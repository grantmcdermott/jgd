/**
 * E2E test: plotIndex resize — verify R re-renders historical plots via snapshots.
 *
 * Sends two sequential plots, then requests plotIndex resizes for each.
 * Verifies:
 *  1. Normal resize re-renders the current (latest) plot without plotIndex.
 *  2. plotIndex=0 resize re-renders the first plot's snapshot.
 *  3. plotIndex=1 resize re-renders the second plot's snapshot.
 *  4. Re-rendered plots produce ops consistent with their original content.
 *  5. Normal resize still works correctly after plotIndex resizes.
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
  name: "E2E: plotIndex resize re-renders historical plot",
  ignore: !rAvailable,
  async fn() {
    const server = new TestServer({ tcp: true });
    const browser = new AutoMetricsBrowserClient();

    try {
      await server.start();
      await browser.connect(server.wsUrl);
      browser.sendResize(800, 600);
      await delay(200);

      // Start R with two plots + polling loop to keep the device open
      // and responsive to resize messages.  Rscript (batch mode) does not
      // process R input handlers during Sys.sleep, so we poll explicitly.
      const r = startR(
        'jgd(width=8, height=6, dpi=96); plot(1:3); plot(4:6); for (i in 1:200) { .Call(jgd:::C_jgd_poll_resize); Sys.sleep(0.05) }',
        server.socketPath,
      );

      try {
        // Wait for both frames
        const frame1 = await browser.waitForType<FrameMessage>("frame", 15000);
        assert(frame1.plot.ops.length > 0, "First frame should have ops");

        const frame2 = await browser.waitForType<FrameMessage>("frame", 15000);
        assert(frame2.plot.ops.length > 0, "Second frame should have ops");

        // --- Test 1: plotIndex=0 resize re-renders the first plot ---
        browser.sendResizeWithPlotIndex(640, 480, 0);

        const resized0 = await browser.waitForMessage<FrameMessage>(
          (msg) => msg.type === "frame" && (msg as FrameMessage).resize === true,
          10000,
        );

        assertEquals(resized0.resize, true, "plotIndex=0 frame should have resize:true");
        assertEquals(resized0.plotIndex, 0, "plotIndex=0 frame should have plotIndex:0");
        assert(resized0.plot.ops.length > 0, "plotIndex=0 frame should have ops");

        // The re-rendered frame should contain text from plot(1:3), not plot(4:6)
        const texts0 = extractTextOps(resized0);
        assert(texts0.length > 0, "plotIndex=0 re-render should contain text ops");

        // --- Test 2: plotIndex=1 resize re-renders the second plot ---
        // Use different dimensions to avoid dedup (though plotIndex bypasses it)
        browser.sendResizeWithPlotIndex(700, 500, 1);

        const resized1 = await browser.waitForMessage<FrameMessage>(
          (msg) => msg.type === "frame" && (msg as FrameMessage).resize === true,
          10000,
        );

        assertEquals(resized1.resize, true, "plotIndex=1 frame should have resize:true");
        assertEquals(resized1.plotIndex, 1, "plotIndex=1 frame should have plotIndex:1");
        assert(resized1.plot.ops.length > 0, "plotIndex=1 frame should have ops");

        const texts1 = extractTextOps(resized1);
        assert(texts1.length > 0, "plotIndex=1 re-render should contain text ops");

        // plot(1:3) and plot(4:6) produce different axis labels, so the
        // text ops from plotIndex=0 and plotIndex=1 should differ.
        assertNotEquals(
          JSON.stringify(texts0),
          JSON.stringify(texts1),
          "plotIndex=0 and plotIndex=1 should produce different text ops (different plots)",
        );

        // --- Test 3: normal resize (no plotIndex) still works ---
        browser.sendResize(750, 550);

        const normalResize = await browser.waitForMessage<FrameMessage>(
          (msg) => msg.type === "frame" && (msg as FrameMessage).resize === true,
          10000,
        );

        assertEquals(normalResize.resize, true, "Normal resize frame should have resize:true");
        assertEquals(normalResize.plotIndex, undefined, "Normal resize should NOT have plotIndex");
        assert(normalResize.plot.ops.length > 0, "Normal resize frame should have ops");

        // Normal resize re-renders the current (latest) plot, which is plot(4:6).
        // Its text ops should match plotIndex=1 (the second plot), not plotIndex=0.
        const textsNormal = extractTextOps(normalResize);
        assertEquals(
          JSON.stringify(textsNormal),
          JSON.stringify(texts1),
          "Normal resize should re-render the current (latest) plot, matching plotIndex=1",
        );
      } finally {
        r.kill();
        // Drain process output to avoid resource leaks
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
