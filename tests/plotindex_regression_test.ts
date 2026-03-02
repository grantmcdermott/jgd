/**
 * E2E regression test: normal resize must work after plotIndex resize.
 *
 * Reproduces the bug where resizing the current (latest) plot fails
 * after a plotIndex resize of a historical plot.  The exact reproduction
 * steps from manual testing are:
 *
 *  1. plot(1:3) → plot 1 displayed
 *  2. plot(4:6) → plot 2 displayed
 *  3. Resize browser → plot 2 re-renders (normal resize)
 *  4. Navigate to plot 1
 *  5. Resize browser → plot 1 re-renders (plotIndex=0 resize)
 *  6. Navigate to plot 2
 *  7. Resize browser → plot 2 should re-render (normal resize) ← BUG: fails
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
  name: "E2E: normal resize works after plotIndex resize (regression)",
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
        // Step 1-2: Wait for both plots
        const frame1 = await browser.waitForType<FrameMessage>("frame", 15000);
        assert(frame1.plot.ops.length > 0, "First frame should have ops");

        const frame2 = await browser.waitForType<FrameMessage>("frame", 15000);
        assert(frame2.plot.ops.length > 0, "Second frame should have ops");

        // Step 3: Normal resize — verify latest plot (plot 2) re-renders
        browser.sendResize(640, 480);

        const normalResize1 = await browser.waitForMessage<FrameMessage>(
          (msg) => msg.type === "frame" && (msg as FrameMessage).resize === true,
          10000,
        );

        assertEquals(normalResize1.resize, true, "Step 3: should have resize:true");
        assertEquals(normalResize1.plotIndex, undefined, "Step 3: should NOT have plotIndex");
        assert(normalResize1.plot.ops.length > 0, "Step 3: should have ops");

        const textsStep3 = extractTextOps(normalResize1);
        assert(textsStep3.length > 0, "Step 3: should have text ops");

        // Step 5: plotIndex=0 resize — verify historical plot (plot 1) re-renders
        const sessionId = frame1.plot.sessionId!;
        browser.sendResizeWithPlotIndex(700, 500, 0, sessionId);

        const plotIndexResize = await browser.waitForMessage<FrameMessage>(
          (msg) => msg.type === "frame" && (msg as FrameMessage).resize === true,
          10000,
        );

        assertEquals(plotIndexResize.resize, true, "Step 5: should have resize:true");
        assertEquals(plotIndexResize.plotIndex, 0, "Step 5: should have plotIndex:0");
        assert(plotIndexResize.plot.ops.length > 0, "Step 5: should have ops");

        const textsStep5 = extractTextOps(plotIndexResize);
        assert(textsStep5.length > 0, "Step 5: should have text ops");

        // Verify plot 1 (step 5) and plot 2 (step 3) have different content
        assertNotEquals(
          JSON.stringify(textsStep3),
          JSON.stringify(textsStep5),
          "Step 5 (plot 1) should differ from step 3 (plot 2)",
        );

        // Step 7: Normal resize — THIS is the regression test.
        // After plotIndex resize, a subsequent normal resize should
        // re-render the current (latest) plot.
        browser.sendResize(750, 550);

        const normalResize2 = await browser.waitForMessage<FrameMessage>(
          (msg) => msg.type === "frame" && (msg as FrameMessage).resize === true,
          10000,
        );

        assertEquals(normalResize2.resize, true, "Step 7: should have resize:true");
        assertEquals(normalResize2.plotIndex, undefined, "Step 7: should NOT have plotIndex");
        assert(normalResize2.plot.ops.length > 0, "Step 7: should have ops");

        // Step 7 should re-render the current (latest) plot, i.e. plot(4:6),
        // which has the same content as step 3 (also plot 2).
        const textsStep7 = extractTextOps(normalResize2);
        assertEquals(
          JSON.stringify(textsStep7),
          JSON.stringify(textsStep3),
          "Step 7 should re-render the same plot as step 3 (both are the latest plot)",
        );

        // Also verify step 7 differs from step 5 (which was plot 1)
        assertNotEquals(
          JSON.stringify(textsStep7),
          JSON.stringify(textsStep5),
          "Step 7 (latest plot) should differ from step 5 (historical plot)",
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

Deno.test({
  name: "E2E: normal resize not deduped when dims match pre-plotIndex state",
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
        // Wait for both plots
        const initFrame = await browser.waitForType<FrameMessage>("frame", 15000);
        await browser.waitForType<FrameMessage>("frame", 15000);
        const sessionId = initFrame.plot.sessionId!;

        // Normal resize AFTER R session is established to properly set
        // the server's lastResizeW/H dedup state.
        browser.sendResize(640, 480);

        const firstNormal = await browser.waitForMessage<FrameMessage>(
          (msg) => msg.type === "frame" && (msg as FrameMessage).resize === true,
          10000,
        );
        assertEquals(firstNormal.resize, true);
        // lastResizeW/H is now 640x480 on the server

        // plotIndex resize with DIFFERENT dimensions (700x500).
        // This bypasses dedup and updates lastResizeW/H to 700x500.
        // R's device dimensions are also changed to 700x500.
        browser.sendResizeWithPlotIndex(700, 500, 0, sessionId);

        const plotIndexFrame = await browser.waitForMessage<FrameMessage>(
          (msg) => msg.type === "frame" && (msg as FrameMessage).resize === true,
          10000,
        );
        assertEquals(plotIndexFrame.plotIndex, 0);

        // Now send a normal resize with 640x480.  The server's lastResizeW/H
        // is 700x500 (plotIndex resize updated dedup state), so 640x480
        // should be forwarded (different dims).
        browser.sendResize(640, 480);

        const normalFrame = await browser.waitForMessage<FrameMessage>(
          (msg) => msg.type === "frame" && (msg as FrameMessage).resize === true,
          10000,
        );

        assertEquals(normalFrame.resize, true, "Normal resize should not be deduped");
        assertEquals(normalFrame.plotIndex, undefined, "Should be a normal resize");
        assert(normalFrame.plot.ops.length > 0, "Should have ops");
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
