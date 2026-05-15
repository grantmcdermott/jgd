/**
 * Historical plot resize tests using ArfSession for step-by-step R control.
 *
 * These tests cover scenarios where a plot is composed in multiple steps
 * (e.g. plot() followed by lines()) and verify that all drawing ops survive
 * a plotIndex resize of the historical plot.
 *
 * Two test layers:
 *  Layer 1 — protocol-level (op count / type assertions, no browser needed)
 *  Layer 2 — full-stack (real Chromium via Astral, canvas content validation)
 */

import { assert, assertEquals } from "@std/assert";
import { delay } from "@std/async";
import { TestServer } from "../server/tests/helpers/server.ts";
import { testLog } from "./helpers/test_log.ts";
import {
  canvasHasContent,
  E2EBrowser,
  plotInfoText,
  waitForPlotInfo,
} from "../server/tests/helpers/e2e_browser.ts";
import { BrowserClient } from "../server/tests/helpers/browser_client.ts";
import type { FrameMessage } from "../server/tests/helpers/types.ts";
import { AutoMetricsBrowserClient } from "./helpers/auto_metrics_client.ts";
import { pollResize } from "./helpers/arf_poll.ts";
import { ArfSession, checkArfTestAvailable } from "./helpers/arf_session.ts";
import { waitForWsConnected } from "./helpers/page_ready.ts";
import { toRSocketAddress } from "./helpers/r_process.ts";
import { extractTextOps } from "./helpers/plot_ops.ts";

const arfTestAvailable = await checkArfTestAvailable();
const skip = !arfTestAvailable;

// ---------------------------------------------------------------------------
// Layer 1: protocol-level assertions
// ---------------------------------------------------------------------------

// Collect frames until quiet (no new frame within timeoutMs).
// Used to gather both the newPage frame and any incremental frames.
async function collectFramesUntilQuiet(
  browser: AutoMetricsBrowserClient,
  quietMs = 500,
): Promise<FrameMessage[]> {
  const frames: FrameMessage[] = [];
  while (true) {
    try {
      frames.push(await browser.waitForType<FrameMessage>("frame", quietMs));
    } catch {
      break;
    }
  }
  return frames;
}

function hasRedLineOp(frames: FrameMessage[]): boolean {
  for (const frame of frames) {
    for (const op of frame.plot.ops as Array<Record<string, unknown>>) {
      if (op.op === "line" || op.op === "polyline") {
        const gc = op.gc as Record<string, unknown> | null;
        const col = ((gc?.col as string | undefined) ?? "").toLowerCase();
        if (col.includes("ff0000") || col.includes("255,0,0")) return true;
      }
    }
  }
  return false;
}

async function canvasPaintStats(
  page: Awaited<ReturnType<E2EBrowser["newPage"]>>,
): Promise<{ paintedPixels: number; checksum: number }> {
  return await page.evaluate(`(function() {
    var c = document.getElementById('plot-canvas');
    if (!c || c.width === 0 || c.height === 0) {
      return { paintedPixels: 0, checksum: 0 };
    }
    var ctx = c.getContext('2d');
    var data = ctx.getImageData(0, 0, c.width, c.height).data;
    var paintedPixels = 0;
    var checksum = 0;
    for (var i = 0; i < data.length; i += 4) {
      var r = data[i];
      var g = data[i + 1];
      var b = data[i + 2];
      var a = data[i + 3];
      if (a > 0 && (r < 245 || g < 245 || b < 245)) {
        paintedPixels++;
        checksum = (checksum + paintedPixels * (r + 3 * g + 7 * b + 11 * a)) % 1000000007;
      }
    }
    return { paintedPixels: paintedPixels, checksum: checksum };
  })()`) as { paintedPixels: number; checksum: number };
}

Deno.test({
  name: "E2E: base graphics + lines() ops preserved after plotIndex resize",
  ignore: skip,
  async fn() {
    testLog("test start");
    const server = new TestServer({ tcp: true });
    const browser = new AutoMetricsBrowserClient();
    const arf = new ArfSession();

    try {
      await server.start();
      await browser.connect(server.wsUrl);
      await arf.start();
      const socketAddr = toRSocketAddress(server.socketPath);

      await arf.eval(
        `options(jgd.socket = "${socketAddr}"); library(jgd); jgd(width=8, height=6, dpi=96)`,
      );

      // Plot 1: base plot + red lines() overlay.
      // jgd sends lines() as a separate incremental frame, so we collect
      // both the newPage frame and the incremental frame.
      await arf.eval(
        'plot(1:10, main="Plot 1"); lines(c(2, 5, 8), c(2, 5, 8), col="red", lwd=2)',
      );
      const plot1Frames = await collectFramesUntilQuiet(browser);
      assert(
        plot1Frames.length >= 2,
        "plot 1 should produce newPage + incremental frames",
      );
      assert(
        hasRedLineOp(plot1Frames),
        "plot 1 frames must contain red line ops from lines()",
      );

      const sessionId = plot1Frames[0].plot.sessionId!;

      // Plot 2: push plot 1 into history
      await arf.eval('plot(11:20, main="Plot 2")');
      await collectFramesUntilQuiet(browser);

      // Request resize of historical plot 1 (plotIndex = 0)
      browser.sendResizeWithPlotIndex(640, 480, 0, sessionId);
      await browser.sendPing(3000);
      await pollResize(arf, 40);

      const resized = await browser.waitForMessage<FrameMessage>(
        (msg) => msg.type === "frame" && (msg as FrameMessage).resize === true,
        15_000,
      );

      assertEquals(
        resized.resize,
        true,
        "resized frame should have resize:true",
      );
      assertEquals(
        resized.plotIndex,
        0,
        "resized frame should have plotIndex:0",
      );
      assert(resized.plot.ops.length > 0, "resized frame should have ops");

      // Layer 1: plotIndex resize must replay the full display list,
      // including the lines() ops (regression for jgd-c0f: lines() vanishing
      // after resize of a historical plot).
      assert(
        hasRedLineOp([resized]),
        "resized plot 1 must contain red line ops from lines() — regression for jgd-c0f",
      );

      // Text ops (axis labels, title) should match the newPage frame
      const textsOriginal = extractTextOps(plot1Frames[0]);
      const textsResized = extractTextOps(resized);
      assertEquals(
        JSON.stringify(textsOriginal),
        JSON.stringify(textsResized),
        "text ops must be the same before and after resize",
      );
    } finally {
      await arf.shutdown();
      browser.close();
      await delay(100);
      await server.shutdown();
      server.cleanup();
    }
  },
});

// ---------------------------------------------------------------------------
// Layer 2: full-stack browser navigation test
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "E2E: full-stack — browser navigation + plotIndex resize keeps canvas non-blank",
  ignore: skip,
  async fn() {
    testLog("test start");
    const server = new TestServer({ tcp: true });
    const e2e = new E2EBrowser();
    const observer = new BrowserClient();
    const arf = new ArfSession();

    try {
      await server.start();

      // Launch browser before R so it receives frames in order
      await e2e.launch();
      const page = await e2e.newPage(server.httpBaseUrl);
      await observer.connect(server.wsUrl);
      // Deterministic barrier: wait until the page's WebSocket onopen
      // has actually fired so initial frames are not lost on slow CI.
      await waitForWsConnected(page);

      await arf.start();
      const socketAddr = toRSocketAddress(server.socketPath);

      await arf.eval(
        `options(jgd.socket = "${socketAddr}"); library(jgd); jgd(width=8, height=6, dpi=96)`,
      );

      // Plot 1: base plot + lines overlay
      await arf.eval(
        'plot(1:10, main="Plot 1"); lines(c(2, 5, 8), c(2, 5, 8), col="red", lwd=2)',
      );
      await waitForPlotInfo(page, "1 / 1", 15_000);

      // Plot 2: push plot 1 into history
      await arf.eval('plot(11:20, main="Plot 2")');
      await waitForPlotInfo(page, "2 / 2", 15_000);

      // Navigate back to plot 1 via the browser's ◀ button
      await page.evaluate(`document.getElementById('btn-prev').click()`);
      await waitForPlotInfo(page, "1 / 2", 5_000);

      // Verify canvas has content while viewing plot 1
      assert(
        await canvasHasContent(page),
        "canvas should have content when viewing plot 1",
      );
      const beforeResizeStats = await canvasPaintStats(page);
      assert(
        beforeResizeStats.paintedPixels > 0,
        "canvas should have foreground pixels when viewing plot 1",
      );

      // The page's ResizeObserver debounces resize sends by ~300ms, so the
      // resize message may arrive in R's queue well after a single poll
      // window closes. Keep polling R until the replay frame is observed
      // (or the deadline expires), instead of relying on a fixed delay.
      const replayFramePromise = observer.waitForMessage<FrameMessage>(
        (msg) =>
          msg.type === "frame" &&
          (msg as FrameMessage).resize === true &&
          (msg as FrameMessage).resizeReplay === true &&
          (msg as FrameMessage).plotIndex === 0,
        15_000,
      );

      // Trigger resize — ResizeObserver fires with plotIndex=0 because we're
      // viewing a historical plot. The replay waiter is already registered so
      // it cannot be satisfied by a buffered frame from after this action.
      await page.evaluate(`(function() {
        var c = document.getElementById('canvas-container');
        c.style.width = '500px';
        c.style.height = '350px';
      })()`);
      let replayDone = false;
      replayFramePromise.then(() => (replayDone = true)).catch(
        () => (replayDone = true),
      );
      const pollDeadline = Date.now() + 14_000;
      while (!replayDone && Date.now() < pollDeadline) {
        await pollResize(arf, 40);
      }
      await replayFramePromise;

      // Wait for a post-resize render signal before asserting non-blank.
      // Content can already be non-blank due to local browser replay.
      const deadline = Date.now() + 5_000;
      let changed = false;
      let hasContent = false;
      let paintedPixels = 0;
      while (Date.now() < deadline) {
        const stats = await canvasPaintStats(page);
        hasContent = await canvasHasContent(page);
        paintedPixels = stats.paintedPixels;
        if (stats.checksum !== beforeResizeStats.checksum) changed = true;
        if (changed && hasContent && paintedPixels > 0) break;
        await delay(100);
      }
      assert(changed, "canvas should update after plotIndex resize replay");
      assert(hasContent, "canvas must not be blank after plotIndex resize");
      assert(
        paintedPixels > 0,
        "canvas must contain foreground pixels after plotIndex resize",
      );

      // Navigation state should be unchanged (still viewing plot 1 of 2)
      assertEquals(
        await plotInfoText(page),
        "1 / 2",
        "should still be viewing plot 1 of 2 after resize",
      );
    } finally {
      await arf.shutdown();
      observer.close();
      await e2e.close();
      await delay(100);
      await server.shutdown();
      server.cleanup();
    }
  },
});
