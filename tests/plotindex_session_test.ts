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
import { toRSocketAddress } from "./helpers/r_process.ts";
import { ArfSession, checkArfTestAvailable } from "./helpers/arf_session.ts";

const arfTestAvailable = await checkArfTestAvailable();
const skip = !arfTestAvailable;

Deno.test({
  name: "E2E: plotIndex resize after R restart does not corrupt history",
  ignore: skip,
  async fn() {
    const server = new TestServer({ tcp: true });
    const browser = new AutoMetricsBrowserClient();
    const arf2 = new ArfSession();

    try {
      await server.start();
      await browser.connect(server.wsUrl);
      browser.sendResize(800, 600);
      await delay(100);

      const socketAddr = toRSocketAddress(server.socketPath);

      // --- Session 1: generate plot 1 (plot(1:3)) ---
      const arf1 = new ArfSession();
      await arf1.start();
      await arf1.eval(
        `options(jgd.socket = "${socketAddr}"); library(jgd); jgd(width=8, height=6, dpi=96)`,
      );
      await arf1.eval("plot(1:3)");

      const frame1 = await browser.waitForType<FrameMessage>("frame", 8000);
      assert(frame1.plot.ops.length > 0, "Session 1 frame should have ops");
      const texts1 = extractTextOps(frame1);
      const session1Id = frame1.plot.sessionId;

      // Shut down session 1 and wait for disconnect
      await arf1.shutdown();
      await delay(500);

      // --- Session 2: generate plot 2 (plot(4:6)) ---
      await arf2.start();
      await arf2.eval(
        `options(jgd.socket = "${socketAddr}"); library(jgd); jgd(width=8, height=6, dpi=96)`,
      );
      await arf2.eval("plot(4:6)");

      const frame2 = await browser.waitForType<FrameMessage>("frame", 8000);
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
      // Include session1Id so the server routes to the correct (dead) session.
      browser.sendResizeWithPlotIndex(640, 480, 0, session1Id);

      // The server routes the plotIndex resize to session 1 only (via
      // sessionId).  Since session 1 is dead, the resize is silently
      // dropped — no frame should arrive.  This prevents session confusion
      // where session 2 would render its own plot at new dimensions and
      // the server would tag it as plotIndex=0, corrupting history.

      // Send a ping sentinel: any server-side message queued before the
      // pong will arrive first.  Race the pong against a frame waiter —
      // if the pong wins, the server correctly dropped the plotIndex resize.
      // AbortController cancels the losing waiter so it doesn't consume
      // later messages.
      const ac = new AbortController();
      const sentinel = Symbol("pong");
      const resizeFrame = await Promise.race([
        browser.waitForMessage<FrameMessage>(
          (msg) =>
            msg.type === "frame" && (msg as FrameMessage).resize === true,
          6000,
          ac.signal,
        ).catch(() => null),
        browser.sendPing(6000).then(() => {
          ac.abort();
          return sentinel;
        }),
      ]);

      // No frame should arrive — session 1 is dead and cannot re-render.
      // The server should drop the plotIndex resize entirely.
      assertEquals(
        resizeFrame,
        sentinel,
        "No resize frame should arrive — session 1 is dead and cannot re-render plot 1",
      );
    } finally {
      await arf2.shutdown();
      browser.close();
      await delay(100);
      await server.shutdown();
      server.cleanup();
    }
  },
});
