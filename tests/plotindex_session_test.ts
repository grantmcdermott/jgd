/**
 * E2E test: plotIndex resize must not cross R session boundaries.
 *
 * Reproduces Bug 2 (session confusion):
 *  1. plot(1:3) → plot 1 displayed (R session 1)
 *  2. Restart R, plot(4:6) → plot 2 displayed (R session 2)
 *  3. Navigate to plot 1 in history
 *  4. Resize browser window
 *  5. Expected: plot 1 stays unchanged (session 1 is dead, can't re-render)
 *  6. Actual (bug): session 2 receives the plotIndex resize, renders its
 *     own current plot, and the server tags it as plotIndex=0 — corrupting
 *     plot 1 in the browser's history.
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { delay } from "@std/async";
import { TestServer } from "../server/tests/helpers/server.ts";
import type { FrameMessage } from "../server/tests/helpers/types.ts";
import { AutoMetricsBrowserClient } from "./helpers/auto_metrics_client.ts";
import { extractTextOps } from "./helpers/plot_ops.ts";
import { checkRAvailable, startR } from "./helpers/r_process.ts";

const rAvailable = await checkRAvailable();

Deno.test({
  name: "E2E: plotIndex resize after R restart does not corrupt history",
  ignore: !rAvailable,
  async fn() {
    const server = new TestServer({ tcp: true });
    const browser = new AutoMetricsBrowserClient();

    try {
      await server.start();
      await browser.connect(server.wsUrl);
      browser.sendResize(800, 600);
      await delay(200);

      // --- Session 1: generate plot 1 (plot(1:3)) ---
      const r1 = startR(
        'jgd(width=8, height=6, dpi=96); plot(1:3); for (i in 1:100) { .Call(jgd:::C_jgd_poll_resize); Sys.sleep(0.05) }',
        server.socketPath,
      );

      const frame1 = await browser.waitForType<FrameMessage>("frame", 15000);
      assert(frame1.plot.ops.length > 0, "Session 1 frame should have ops");
      const texts1 = extractTextOps(frame1);
      const session1Id = frame1.plot.sessionId;

      // Kill session 1 and wait for disconnect
      r1.kill();
      try { await r1.process.output(); } catch { /* ignore */ }
      await delay(500);

      // --- Session 2: generate plot 2 (plot(4:6)) ---
      const r2 = startR(
        'jgd(width=8, height=6, dpi=96); plot(4:6); for (i in 1:200) { .Call(jgd:::C_jgd_poll_resize); Sys.sleep(0.05) }',
        server.socketPath,
      );

      try {
        const frame2 = await browser.waitForType<FrameMessage>("frame", 15000);
        assert(frame2.plot.ops.length > 0, "Session 2 frame should have ops");
        const texts2 = extractTextOps(frame2);
        const session2Id = frame2.plot.sessionId;

        // Verify the sessions are different
        assertNotEquals(
          session1Id,
          session2Id,
          "R sessions should have different IDs",
        );
        assertNotEquals(
          JSON.stringify(texts1),
          JSON.stringify(texts2),
          "Plot 1 and plot 2 should have different content",
        );

        // --- Send plotIndex=0 resize (targeting plot 1 from dead session 1) ---
        browser.sendResizeWithPlotIndex(640, 480, 0);

        // Bug: The server broadcasts this resize to session 2, which renders
        // its own current plot (plot 2) at new dimensions.  The server tags
        // the response frame with plotIndex:0, so the browser replaces plot 1
        // in its history with plot 2's content — session confusion.
        //
        // Expected correct behavior: the resize frame (if any) should either
        // (a) not arrive at all (session 1 is dead, no one to render plot 1), or
        // (b) contain plot 1's content (impossible since session 1 is dead).
        //
        // We check: if a frame arrives tagged plotIndex:0, its content must
        // match plot 1 (not plot 2).  Since session 1 is dead, this assertion
        // should fail, demonstrating the session confusion bug.

        let resizeFrame: FrameMessage | null = null;
        try {
          resizeFrame = await browser.waitForMessage<FrameMessage>(
            (msg) =>
              msg.type === "frame" && (msg as FrameMessage).resize === true,
            3000,
          );
        } catch {
          // Timeout — no resize frame arrived.  This is correct behavior:
          // session 1 is dead and cannot re-render plot 1.
          resizeFrame = null;
        }

        if (resizeFrame !== null && resizeFrame.plotIndex === 0) {
          // A frame arrived tagged as plotIndex:0.
          // It MUST contain plot 1's content (from session 1), not plot 2's
          // (from session 2).
          const textsResized = extractTextOps(resizeFrame);
          assertEquals(
            JSON.stringify(textsResized),
            JSON.stringify(texts1),
            "plotIndex=0 resize frame should contain plot 1 content (from session 1), " +
              "not plot 2 content (from session 2). Session confusion detected.",
          );
        }

        // If no frame arrived, that's the correct behavior — session 1 is dead.
      } finally {
        r2.kill();
        try { await r2.process.output(); } catch { /* ignore */ }
      }
    } finally {
      browser.close();
      await delay(100);
      await server.shutdown();
      server.cleanup();
    }
  },
});
