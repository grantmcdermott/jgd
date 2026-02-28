/**
 * E2E test: plotIndex resize must produce exactly one frame.
 *
 * Reproduces Bug 1:
 *  1. plot(1:3)  → plot 1 displayed
 *  2. plot(4:6)  → plot 2 displayed
 *  3. Navigate to plot 1 in history
 *  4. Resize browser window
 *  5. Expected: plot 1 re-rendered at new size (single frame)
 *  6. Actual (bug): plot 2 is resized, AND a new plot 3 appears
 *     with plot 2's pre-resize content.
 *
 * This test checks at the protocol level:
 *  - The resize response frame contains plot 1's content (not plot 2)
 *  - No extra frame leaks after the resize
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
  name: "E2E: plotIndex resize produces exactly one frame with correct content",
  ignore: !rAvailable,
  async fn() {
    const server = new TestServer({ tcp: true });
    const browser = new AutoMetricsBrowserClient();

    try {
      await server.start();
      await browser.connect(server.wsUrl);
      browser.sendResize(800, 600);
      await delay(200);

      const r = startR(
        'jgd(width=8, height=6, dpi=96); plot(1:3); plot(4:6); for (i in 1:200) { .Call(jgd:::C_jgd_poll_resize); Sys.sleep(0.05) }',
        server.socketPath,
      );

      try {
        // Wait for both plot frames
        const frame1 = await browser.waitForType<FrameMessage>("frame", 15000);
        assert(frame1.plot.ops.length > 0, "First frame should have ops");
        const texts1 = extractTextOps(frame1);

        const frame2 = await browser.waitForType<FrameMessage>("frame", 15000);
        assert(frame2.plot.ops.length > 0, "Second frame should have ops");
        const texts2 = extractTextOps(frame2);

        // Verify the two plots are different
        assertNotEquals(
          JSON.stringify(texts1),
          JSON.stringify(texts2),
          "Plot 1 and plot 2 should have different text ops",
        );

        // Simulate: navigate to plot 1, then resize.
        // At the protocol level, this is a resize with plotIndex=0.
        browser.sendResizeWithPlotIndex(640, 480, 0);

        // Wait for the resize response frame
        const resized = await browser.waitForMessage<FrameMessage>(
          (msg) => msg.type === "frame" && (msg as FrameMessage).resize === true,
          10000,
        );

        assertEquals(resized.resize, true, "Should have resize:true");
        assertEquals(resized.plotIndex, 0, "Should have plotIndex:0");

        // CRITICAL: The resized frame must contain plot 1's content, not plot 2's.
        // Bug 1 manifests as the frame containing plot 2's content because the
        // snapshot replay produces the wrong plot.
        const textsResized = extractTextOps(resized);
        assertEquals(
          JSON.stringify(textsResized),
          JSON.stringify(texts1),
          "plotIndex=0 resize should render plot 1's content, not plot 2's",
        );

        // CRITICAL: No extra frames should arrive after the resize.
        // Bug 1 also manifests as the current plot restoration leaking an
        // extra untagged frame, which the browser would treat as a new plot 3.
        let extraFrame: FrameMessage | null = null;
        try {
          extraFrame = await browser.waitForType<FrameMessage>("frame", 2000);
        } catch {
          // Timeout is expected — no extra frame should arrive
        }

        assertEquals(
          extraFrame,
          null,
          "No extra frame should arrive after plotIndex resize (would create spurious plot 3)",
        );
      } finally {
        r.kill();
        try { await r.process.output(); } catch { /* ignore */ }
      }
    } finally {
      browser.close();
      await delay(100);
      await server.shutdown();
      server.cleanup();
    }
  },
});
