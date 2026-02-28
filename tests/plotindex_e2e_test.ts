/**
 * E2E test: plotIndex resize — verify R re-renders historical plots via snapshots.
 *
 * Sends two sequential plots, then requests a plotIndex resize for the first.
 * Expects R to replay the snapshot and return a frame tagged with resize:true
 * and plotIndex:0.
 */

import { assert, assertEquals } from "@std/assert";
import { delay } from "@std/async";
import { TestServer } from "../server/tests/helpers/server.ts";
import type { FrameMessage } from "../server/tests/helpers/types.ts";
import { AutoMetricsBrowserClient } from "./helpers/auto_metrics_client.ts";
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

        // Send plotIndex resize for the first plot (index 0)
        browser.sendResizeWithPlotIndex(640, 480, 0);

        // Wait for the re-rendered historical frame
        const resizedFrame = await browser.waitForMessage<FrameMessage>(
          (msg) => msg.type === "frame" && (msg as FrameMessage).resize === true,
          10000,
        );

        assertEquals(resizedFrame.resize, true, "Frame should have resize:true");
        assertEquals(resizedFrame.plotIndex, 0, "Frame should have plotIndex:0");
        assert(resizedFrame.plot.ops.length > 0, "Re-rendered frame should have ops");
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
