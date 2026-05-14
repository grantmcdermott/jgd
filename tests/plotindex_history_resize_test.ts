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

async function canvasAlphaChecksum(
  page: Awaited<ReturnType<E2EBrowser["newPage"]>>,
): Promise<number> {
  return await page.evaluate(`(function() {
    var c = document.getElementById('plot-canvas');
    if (!c || c.width === 0 || c.height === 0) return 0;
    var ctx = c.getContext('2d');
    var data = ctx.getImageData(0, 0, c.width, c.height).data;
    var sum = 0;
    for (var i = 3; i < data.length; i += 4) sum += data[i];
    return sum;
  })()`) as number;
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
      browser.sendResize(800, 600);
      await delay(100);

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
      await delay(500);

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
      const beforeResizeChecksum = await canvasAlphaChecksum(page);

      // Trigger resize — ResizeObserver fires with plotIndex=0 because we're
      // viewing a historical plot
      await page.evaluate(`(function() {
        var c = document.getElementById('canvas-container');
        c.style.width = '500px';
        c.style.height = '350px';
      })()`);

      // Wait for the page's ResizeObserver debounce and then process the
      // server-side resize message in R.
      await delay(500);
      const replayFramePromise = observer.waitForMessage<FrameMessage>(
        (msg) =>
          msg.type === "frame" &&
          (msg as FrameMessage).resize === true &&
          (msg as FrameMessage).plotIndex === 0,
        15_000,
      );
      await pollResize(arf, 40);
      await replayFramePromise;

      // Wait for a post-resize render signal before asserting non-blank.
      // Content can already be non-blank due to local browser replay.
      const deadline = Date.now() + 5_000;
      let changed = false;
      let hasContent = false;
      while (Date.now() < deadline) {
        const checksum = await canvasAlphaChecksum(page);
        hasContent = await canvasHasContent(page);
        if (checksum !== beforeResizeChecksum) changed = true;
        if (changed && hasContent) break;
        await delay(100);
      }
      assert(changed, "canvas should update after plotIndex resize replay");
      assert(hasContent, "canvas must not be blank after plotIndex resize");

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
