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
import { ArfSession, checkArfTestAvailable } from "./helpers/arf_session.ts";
import { toRSocketAddress } from "./helpers/r_process.ts";

const arfTestAvailable = await checkArfTestAvailable();
const skip = !arfTestAvailable;

Deno.test({
  name: "E2E: plotIndex resize re-renders historical plot",
  ignore: skip,
  async fn() {
    const server = new TestServer({ tcp: true });
    const browser = new AutoMetricsBrowserClient();
    const arf = new ArfSession();

    try {
      await server.start();
      await browser.connect(server.wsUrl);
      browser.sendResize(800, 600);
      await delay(100);

      await arf.start();
      const socketAddr = toRSocketAddress(server.socketPath);
      await arf.eval(
        `options(jgd.socket = "${socketAddr}"); library(jgd); jgd(width=8, height=6, dpi=96)`,
      );
      await arf.eval("plot(1:3); plot(4:6)");

      // Wait for both frames
      const frame1 = await browser.waitForType<FrameMessage>("frame", 8000);
      assert(frame1.plot.ops.length > 0, "First frame should have ops");

      const frame2 = await browser.waitForType<FrameMessage>("frame", 8000);
      assert(frame2.plot.ops.length > 0, "Second frame should have ops");

      // --- Test 1: plotIndex=0 resize re-renders the first plot ---
      const sessionId = frame1.plot.sessionId!;
      browser.sendResizeWithPlotIndex(640, 480, 0, sessionId);
      await delay(100); // allow WS message to propagate to server
      await arf.eval(".Call(jgd:::C_jgd_poll_resize)");

      const resized0 = await browser.waitForMessage<FrameMessage>(
        (msg) => msg.type === "frame" && (msg as FrameMessage).resize === true,
        6000,
      );

      assertEquals(
        resized0.resize,
        true,
        "plotIndex=0 frame should have resize:true",
      );
      assertEquals(
        resized0.plotIndex,
        0,
        "plotIndex=0 frame should have plotIndex:0",
      );
      assert(resized0.plot.ops.length > 0, "plotIndex=0 frame should have ops");

      // The re-rendered frame should contain text from plot(1:3), not plot(4:6)
      const texts0 = extractTextOps(resized0);
      assert(
        texts0.length > 0,
        "plotIndex=0 re-render should contain text ops",
      );

      // --- Test 2: plotIndex=1 is the latest plot (no snapshot exists) ---
      // With 2 plots, R has 1 snapshot (plot 1) and the active display list
      // (plot 2).  plotIndex=1 exceeds the snapshot count, so R falls
      // through to a normal resize of the current display list.  The frame
      // should have resize:true but no plotIndex.
      browser.sendResizeWithPlotIndex(700, 500, 1, sessionId);
      await delay(100); // allow WS message to propagate to server
      await arf.eval(".Call(jgd:::C_jgd_poll_resize)");

      const resized1 = await browser.waitForMessage<FrameMessage>(
        (msg) => msg.type === "frame" && (msg as FrameMessage).resize === true,
        6000,
      );

      assertEquals(
        resized1.resize,
        true,
        "plotIndex=1 frame should have resize:true",
      );
      assertEquals(
        resized1.plotIndex,
        undefined,
        "plotIndex=1 targets the latest plot (no snapshot) — R treats as normal resize",
      );
      assert(resized1.plot.ops.length > 0, "plotIndex=1 frame should have ops");

      const texts1 = extractTextOps(resized1);
      assert(
        texts1.length > 0,
        "plotIndex=1 re-render should contain text ops",
      );

      // plot(1:3) and plot(4:6) produce different axis labels, so the
      // text ops from plotIndex=0 and plotIndex=1 should differ.
      assertNotEquals(
        JSON.stringify(texts0),
        JSON.stringify(texts1),
        "plotIndex=0 and plotIndex=1 should produce different text ops (different plots)",
      );

      // --- Test 3: normal resize (no plotIndex) still works ---
      browser.sendResize(750, 550);
      await delay(100); // allow WS message to propagate to server
      await arf.eval(".Call(jgd:::C_jgd_poll_resize)");

      const normalResize = await browser.waitForMessage<FrameMessage>(
        (msg) => msg.type === "frame" && (msg as FrameMessage).resize === true,
        6000,
      );

      assertEquals(
        normalResize.resize,
        true,
        "Normal resize frame should have resize:true",
      );
      assertEquals(
        normalResize.plotIndex,
        undefined,
        "Normal resize should NOT have plotIndex",
      );
      assert(
        normalResize.plot.ops.length > 0,
        "Normal resize frame should have ops",
      );

      // Normal resize re-renders the current (latest) plot, which is plot(4:6).
      // Its text ops should match the plotIndex=1 response (also the latest plot).
      const textsNormal = extractTextOps(normalResize);
      assertEquals(
        JSON.stringify(textsNormal),
        JSON.stringify(texts1),
        "Normal resize should re-render the current (latest) plot, matching plotIndex=1",
      );
    } finally {
      browser.close();
      await delay(100);
      await server.shutdown();
      server.cleanup();
      await arf.shutdown();
    }
  },
});
