/**
 * Reproduction test for resize-creates-duplicate-plot bug.
 *
 * Root cause: cb_newPage() unconditionally sets new_page=1 during
 * GEplayDisplayList replay (replaying=1).  After replay, poll_resize_impl
 * clears replaying and calls jgd_flush_frame which sees new_page=1 and
 * emits "newPage":true in the frame JSON.  The server then calls
 * the server's newPage handler instead of injecting resize:true
 * and tagging the frame.  The browser treats the untagged frame as a new
 * plot (addPlot) instead of a resize replacement (replaceLatest).
 *
 * This test verifies:
 *  1. A normal resize after a single plot produces a frame with resize:true.
 *  2. The frame does NOT have newPage:true (which would indicate the C bug).
 *  3. No extra plot entries are created (resize should not grow history).
 */

import { assert, assertEquals } from "@std/assert";
import { delay } from "@std/async";
import { TestServer } from "../server/tests/helpers/server.ts";
import type { FrameMessage } from "../server/tests/helpers/types.ts";
import { AutoMetricsBrowserClient } from "./helpers/auto_metrics_client.ts";
import { ArfSession, checkArfTestAvailable } from "./helpers/arf_session.ts";
import { toRSocketAddress } from "./helpers/r_process.ts";

const arfTestAvailable = await checkArfTestAvailable();
const skip = !arfTestAvailable;

Deno.test({
  name: "E2E: resize replay frame must have resize:true, not newPage:true",
  ignore: skip,
  async fn() {
    const server = new TestServer({ tcp: true });
    const browser = new AutoMetricsBrowserClient();
    const arf = new ArfSession();

    try {
      await server.start();
      await browser.connect(server.wsUrl);
      browser.sendResize(800, 600);
      await delay(200);

      await arf.start();
      const socketAddr = toRSocketAddress(server.socketPath);
      await arf.eval(
        `options(jgd.socket = "${socketAddr}"); library(jgd); jgd(width=8, height=6, dpi=96)`,
      );
      await arf.eval("plot(1:5)");

      // Wait for the initial plot frame
      const plotFrame = await browser.waitForType<FrameMessage>(
        "frame",
        15000,
      );
      assert(plotFrame.plot.ops.length > 0, "Initial plot should have ops");

      // Send a resize with different dimensions
      browser.sendResize(640, 480);
      await delay(100); // allow WS message to propagate to server
      await arf.eval(".Call(jgd:::C_jgd_poll_resize)");

      // Wait for ANY frame (not filtering by resize:true) to see what R
      // actually sends after the resize.
      const resizeFrame = await browser.waitForType<FrameMessage>(
        "frame",
        10000,
      );

      // The resize replay frame MUST be tagged with resize:true so the
      // browser calls replaceLatest instead of addPlot.
      assertEquals(
        resizeFrame.resize,
        true,
        "Resize replay frame must have resize:true — " +
          `got resize=${resizeFrame.resize}, newPage=${resizeFrame.newPage}`,
      );

      // The frame must NOT have newPage:true.  If it does, the C code
      // is incorrectly setting new_page during GEplayDisplayList replay.
      assertEquals(
        resizeFrame.newPage,
        undefined,
        "Resize replay frame must not have newPage — cb_newPage should " +
          "not set new_page flag during replaying",
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

Deno.test({
  name: "E2E: two resizes do not create extra plot entries",
  ignore: skip,
  async fn() {
    const server = new TestServer({ tcp: true });
    const browser = new AutoMetricsBrowserClient();
    const arf = new ArfSession();

    try {
      await server.start();
      await browser.connect(server.wsUrl);
      browser.sendResize(800, 600);
      await delay(200);

      await arf.start();
      const socketAddr = toRSocketAddress(server.socketPath);
      await arf.eval(
        `options(jgd.socket = "${socketAddr}"); library(jgd); jgd(width=8, height=6, dpi=96)`,
      );
      await arf.eval("plot(1:3); plot(4:6)");

      // Wait for both plot frames
      await browser.waitForType<FrameMessage>("frame", 15000);
      await browser.waitForType<FrameMessage>("frame", 15000);

      // Count total frames received: should be exactly 2 so far.
      // Now send resize — should produce exactly 1 more frame with resize:true.
      browser.sendResize(640, 480);
      await delay(100); // allow WS message to propagate to server
      await arf.eval(".Call(jgd:::C_jgd_poll_resize)");

      const frame3 = await browser.waitForType<FrameMessage>(
        "frame",
        10000,
      );

      assertEquals(
        frame3.resize,
        true,
        "First resize frame must be tagged resize:true",
      );
      assertEquals(
        frame3.newPage,
        undefined,
        "First resize frame must not have newPage",
      );

      // Send another resize
      browser.sendResize(700, 500);
      await delay(100); // allow WS message to propagate to server
      await arf.eval(".Call(jgd:::C_jgd_poll_resize)");

      const frame4 = await browser.waitForType<FrameMessage>(
        "frame",
        10000,
      );

      assertEquals(
        frame4.resize,
        true,
        "Second resize frame must also be tagged resize:true",
      );
      assertEquals(
        frame4.newPage,
        undefined,
        "Second resize frame must not have newPage",
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
