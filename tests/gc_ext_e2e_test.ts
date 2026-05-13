/**
 * E2E test: gc.ext extension fields pass through from R to the browser.
 *
 * Verifies the full stack: R's jgd_ext() → C gc_to_cjson() → JSON frame →
 * Deno server → WebSocket → browser client.
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
  name: "E2E: jgd_ext() embeds gc.ext in frame ops",
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

      // Setup: load jgd with socket
      await arf.eval(`options(jgd.socket = "${socketAddr}"); library(jgd)`);
      // R code: set ext, draw a plot, verify ext is embedded in ops
      await arf.eval(
        "jgd(width=8, height=6, dpi=96); " +
          'jgd_ext(\'{"blendMode":"multiply","opacity":0.5}\'); ' +
          "plot(1:3)",
      );

      const frame = await browser.waitForType<FrameMessage>("frame", 8000);
      assert(frame.plot.ops.length > 0, "Frame should have ops");

      // All drawing ops should have gc.ext since ext was set before plot()
      const ops = frame.plot.ops as Array<Record<string, unknown>>;
      const opsWithExt = ops.filter(
        (op) => op.gc && (op.gc as Record<string, unknown>).ext,
      );

      assert(
        opsWithExt.length > 0,
        `Should have ops with gc.ext, got ${opsWithExt.length}`,
      );

      // Verify the ext content
      const ext = (opsWithExt[0].gc as Record<string, unknown>).ext as Record<
        string,
        unknown
      >;
      assertEquals(ext.blendMode, "multiply", "blendMode should be 'multiply'");
      assertEquals(ext.opacity, 0.5, "opacity should be 0.5");
    } finally {
      browser.close();
      await delay(100);
      await arf.shutdown();
      await server.shutdown();
      server.cleanup();
    }
  },
});

Deno.test({
  name: "E2E: with_jgd_ext() scopes ext and restores on exit",
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

      await arf.eval(`options(jgd.socket = "${socketAddr}"); library(jgd)`);
      // R code: use with_jgd_ext to scope ext around first plot,
      // then draw second plot without ext
      await arf.eval(
        "jgd(width=8, height=6, dpi=96); " +
          'with_jgd_ext(\'{"shadow":{"blur":10,"color":"black"}}\', plot(1:3))',
      );

      const frame1 = await browser.waitForType<FrameMessage>("frame", 8000);
      assert(frame1.plot.ops.length > 0, "First frame should have ops");

      // First frame (plot(1:3) inside with_jgd_ext) should have ext
      const ops1 = frame1.plot.ops as Array<Record<string, unknown>>;
      const opsWithExt = ops1.filter(
        (op) => op.gc && (op.gc as Record<string, unknown>).ext,
      );
      assert(opsWithExt.length > 0, "First plot should have ops with gc.ext");
      const shadow =
        ((opsWithExt[0].gc as Record<string, unknown>).ext as Record<
          string,
          unknown
        >).shadow as Record<string, unknown>;
      assertEquals(shadow.blur, 10, "shadow.blur should be 10");

      await arf.eval("plot(4:6)");

      // Second frame (plot(4:6) after with_jgd_ext scope) should NOT have ext
      const frame2 = await browser.waitForType<FrameMessage>("frame", 8000);
      assert(frame2.plot.ops.length > 0, "Second frame should have ops");
      const ops2 = frame2.plot.ops as Array<Record<string, unknown>>;
      const opsWithExt2 = ops2.filter(
        (op) => op.gc && (op.gc as Record<string, unknown>).ext,
      );
      assertEquals(
        opsWithExt2.length,
        0,
        "Second plot should NOT have gc.ext after with_jgd_ext scope",
      );
    } finally {
      browser.close();
      await delay(100);
      await arf.shutdown();
      await server.shutdown();
      server.cleanup();
    }
  },
});

Deno.test({
  name: "E2E: gc.ext survives resize (display list replay)",
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

      await arf.eval(`options(jgd.socket = "${socketAddr}"); library(jgd)`);
      // R code: use with_jgd_ext (sets then clears ext), then poll for resizes.
      // The bug: after with_jgd_ext returns, ext_json is NULL.  When R replays
      // the display list on resize, jgd_ext() is not re-called (it's not in the
      // display list), so all ops in the replayed frame lose gc.ext.
      await arf.eval(
        "jgd(width=8, height=6, dpi=96); " +
          'with_jgd_ext(\'{"blendMode":"multiply","opacity":0.5}\', plot(1:3))',
      );

      // Wait for initial frame
      const frame1 = await browser.waitForType<FrameMessage>("frame", 8000);
      assert(frame1.plot.ops.length > 0, "Initial frame should have ops");

      const ops1 = frame1.plot.ops as Array<Record<string, unknown>>;
      const opsWithExt1 = ops1.filter(
        (op) => op.gc && (op.gc as Record<string, unknown>).ext,
      );
      assert(
        opsWithExt1.length > 0,
        "Initial frame should have ops with gc.ext",
      );

      // Send a resize — this triggers display list replay in R
      browser.sendResize(640, 480);
      await delay(100);
      await arf.eval(".Call(jgd:::C_jgd_poll_resize)");

      // Wait for the resize replay frame
      const resizeFrame = await browser.waitForMessage<FrameMessage>(
        (msg) => msg.type === "frame",
        6000,
      );
      assert(resizeFrame.plot.ops.length > 0, "Resize frame should have ops");

      // CRITICAL: gc.ext must survive the display list replay.
      // Without recordGraphics, jgd_ext() is not replayed and ext_json
      // is NULL during replay, causing gc.ext to be missing.
      const ops2 = resizeFrame.plot.ops as Array<Record<string, unknown>>;
      const opsWithExt2 = ops2.filter(
        (op) => op.gc && (op.gc as Record<string, unknown>).ext,
      );
      assert(
        opsWithExt2.length > 0,
        `Resize frame should preserve gc.ext (got ${opsWithExt2.length} ops with ext)`,
      );

      const ext = (opsWithExt2[0].gc as Record<string, unknown>).ext as Record<
        string,
        unknown
      >;
      assertEquals(
        ext.blendMode,
        "multiply",
        "blendMode should survive resize",
      );
      assertEquals(ext.opacity, 0.5, "opacity should survive resize");
    } finally {
      browser.close();
      await delay(100);
      await arf.shutdown();
      await server.shutdown();
      server.cleanup();
    }
  },
});

Deno.test({
  name: "E2E: gc.ext survives plotIndex resize (historical plot replay)",
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

      await arf.eval(`options(jgd.socket = "${socketAddr}"); library(jgd)`);
      // R code: draw two plots with different ext, then poll for resizes.
      // Plot 1 gets shadow, plot 2 gets opacity.  After drawing, we resize
      // plot 1 via plotIndex, then resize plot 2 — both must keep their ext.
      await arf.eval(
        "jgd(width=8, height=6, dpi=96); " +
          'jgd_ext(\'{"shadow":{"blur":10,"color":"gray"}}\'); ' +
          "plot(1:3)",
      );

      // Receive frame for plot 1 (shadow)
      const frame1 = await browser.waitForType<FrameMessage>("frame", 8000);
      assert(frame1.plot.ops.length > 0, "Plot 1 should have ops");
      const ops1 = frame1.plot.ops as Array<Record<string, unknown>>;
      const opsWithShadow = ops1.filter(
        (op) => op.gc && (op.gc as Record<string, unknown>).ext,
      );
      assert(opsWithShadow.length > 0, "Plot 1 should have shadow ext");

      await arf.eval(
        "jgd_ext(NULL); " +
          "with_jgd_ext('{\"opacity\":0.5}', plot(4:6))",
      );

      // Receive frame for plot 2 (opacity)
      const frame2 = await browser.waitForType<FrameMessage>("frame", 8000);
      assert(frame2.plot.ops.length > 0, "Plot 2 should have ops");
      const ops2 = frame2.plot.ops as Array<Record<string, unknown>>;
      const opsWithOpacity = ops2.filter(
        (op) => op.gc && (op.gc as Record<string, unknown>).ext,
      );
      assert(opsWithOpacity.length > 0, "Plot 2 should have opacity ext");

      // Resize plot 1 via plotIndex (historical replay)
      const sessionId = frame1.plot.sessionId!;
      browser.sendResizeWithPlotIndex(640, 480, 0, sessionId);
      await delay(100);
      await arf.eval(".Call(jgd:::C_jgd_poll_resize)");

      const replay1 = await browser.waitForMessage<FrameMessage>(
        (msg) => msg.type === "frame" && (msg as FrameMessage).resize === true,
        6000,
      );
      assert(replay1.plot.ops.length > 0, "Plot 1 replay should have ops");
      assertEquals(replay1.plotIndex, 0, "Should be plotIndex 0");
      const replay1Ops = replay1.plot.ops as Array<Record<string, unknown>>;
      const replay1Ext = replay1Ops.filter(
        (op) => op.gc && (op.gc as Record<string, unknown>).ext,
      );
      assert(
        replay1Ext.length > 0,
        "Plot 1 replay should preserve shadow ext",
      );
      const shadow =
        ((replay1Ext[0].gc as Record<string, unknown>).ext as Record<
          string,
          unknown
        >).shadow as Record<string, unknown>;
      assertEquals(
        shadow.blur,
        10,
        "shadow.blur should be 10 after plotIndex resize",
      );

      // Now resize the current plot (plot 2) via plotIndex=1.
      // With 2 plots, plotIndex=1 is the latest plot — R has no snapshot
      // for it, so it falls through to a normal display list replay.
      // Its opacity ext must NOT be lost because of the earlier
      // plotIndex=0 replay.
      browser.sendResizeWithPlotIndex(700, 500, 1, sessionId);
      await delay(100);
      await arf.eval(".Call(jgd:::C_jgd_poll_resize)");

      const replay2 = await browser.waitForMessage<FrameMessage>(
        (msg) => msg.type === "frame" && (msg as FrameMessage).resize === true,
        6000,
      );
      assert(replay2.plot.ops.length > 0, "Plot 2 replay should have ops");
      const replay2Ops = replay2.plot.ops as Array<Record<string, unknown>>;
      const replay2Ext = replay2Ops.filter(
        (op) => op.gc && (op.gc as Record<string, unknown>).ext,
      );
      assert(
        replay2Ext.length > 0,
        `Plot 2 replay should preserve opacity ext (got ${replay2Ext.length} ops with ext)`,
      );
      const ext2 = (replay2Ext[0].gc as Record<string, unknown>).ext as Record<
        string,
        unknown
      >;
      assertEquals(
        ext2.opacity,
        0.5,
        "opacity should survive after plotIndex replay",
      );
    } finally {
      browser.close();
      await delay(100);
      await arf.shutdown();
      await server.shutdown();
      server.cleanup();
    }
  },
});
