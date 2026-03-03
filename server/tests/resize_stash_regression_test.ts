/**
 * Regression tests for resize stashing during metrics-heavy drawing.
 *
 * When R draws a ggplot2 faceted plot, it sends metrics_request messages
 * for font measurements.  R's recv_metrics_response reads from the socket
 * while waiting for the browser's response.  If a resize message has been
 * forwarded to R, recv_metrics_response picks it up and stashes it in
 * pending_w/h.  After drawing completes, poll_resize_impl replays the
 * display list at the stashed dimensions — that replay frame carries
 * resizeReplay:true so the server can unambiguously tag it resize:true.
 *
 * R's poll_resize_impl does NOT skip same-dimension resizes — it always
 * replays the display list.  This means a resize at the current device
 * dimensions will still produce a replay frame.
 *
 * These tests verify that the resizeReplay/resizeConsumed protocol flags
 * from R allow the server to correctly tag stashed replay frames, even
 * when the new-plot frame's dimensions match the pending resize entry.
 */

import { assertEquals } from "@std/assert";
import { withTestHarness } from "./helpers/harness.ts";
import type {
  FrameMessage,
  MetricsRequestMessage,
  MetricsResponseMessage,
  ResizeMessage,
} from "./helpers/types.ts";

// ---------------------------------------------------------------------------
// Scenario 1: plotIndex → normal resize at same dims → metrics plot
//
// Timeline:
//   1. Plot 1 exists at 800x600
//   2. plotIndex resize(800,600) → historical snapshot replayed
//   3. Normal resize(800,600) → flag bypasses dedup → sent to R
//   4. R starts drawing plot 2 (ggplot2 with metrics)
//   5. recv_metrics_response stashes the normal resize
//   6. R finishes → frame (newPage:true, 800x600) — no resizeConsumed
//   7. Server: newPage without resizeConsumed → entry preserved
//   8. R processes stashed resize → replay frame (resizeReplay:true)
//   9. Server: consumes entry, tags resize:true
// ---------------------------------------------------------------------------

Deno.test("plotIndex→normal same-dims → stashed during metrics → replay tagged", withTestHarness(async (t, { rClient, browser }) => {
  // Prime: establish session and initial frame
  browser.sendResize(1, 1);
  await rClient.readMessage<ResizeMessage>();
  await rClient.sendFrame(
    { ops: [], device: { width: 1, height: 1 } },
  );
  const primingFrame = await browser.waitForType<FrameMessage>("frame");
  const sessionId = primingFrame.plot.sessionId!;

  // Set up: plot 1 at 800x600
  browser.sendResize(800, 600);
  await rClient.readMessage<ResizeMessage>();
  await rClient.sendFrame(
    { ops: [{ op: "rect" }], device: { width: 800, height: 600 } },
    { newPage: true },
  );
  const plot1Frame = await browser.waitForType<FrameMessage>("frame");
  assertEquals(plot1Frame.resize, undefined, "Plot 1 is a new plot");

  // Consume the resize replay (R applies the resize after drawing plot 1)
  await rClient.sendFrame(
    { ops: [{ op: "rect" }], device: { width: 800, height: 600 } },
  );
  const resizeFrame = await browser.waitForType<FrameMessage>("frame");
  assertEquals(resizeFrame.resize, true, "Resize replay should be tagged");

  await t.step("plotIndex resize → R replays historical snapshot", async () => {
    browser.sendResizeWithPlotIndex(800, 600, 0, sessionId);
    const msg = await rClient.readMessage<ResizeMessage>();
    assertEquals(msg.plotIndex, 0);

    await rClient.sendFrame(
      { ops: [{ op: "rect" }], device: { width: 800, height: 600 } },
    );
    const frame = await browser.waitForType<FrameMessage>("frame");
    assertEquals(frame.resize, true);
    assertEquals(frame.plotIndex, 0);
  });

  await t.step("normal resize at same dims passes through (flag bypass)", async () => {
    // User navigates back to latest — browser sends normal resize at
    // current viewport dims (800x600), same as the plotIndex resize.
    // The lastResizeHadPlotIndex flag allows this through.
    browser.sendResize(800, 600);
    const msg = await rClient.readMessage<ResizeMessage>();
    assertEquals(msg.width, 800);
    assertEquals(msg.height, 600);
    assertEquals(msg.plotIndex, undefined, "Should be a normal resize");
  });

  await t.step("R draws plot 2 with metrics — stashes the resize", async () => {
    // In R's real behavior:
    //   1. R starts drawing plot 2 (cb_newPage)
    //   2. R needs font metrics → sends metrics_request
    //   3. recv_metrics_response reads the normal resize from socket → stashes
    //   4. recv_metrics_response reads metrics_response → returns
    //   5. R finishes drawing → frame (newPage:true)
    //
    // In our test, we model this by sending metrics_request (which the
    // rClient already has the resize in its buffer), exchanging metrics,
    // then sending the newPage frame.

    // R has already received the resize (step above read it).
    // R sends metrics_request during drawing
    await rClient.sendMetricsRequest(1);
    const metricsReq = await browser.waitForType<MetricsRequestMessage>("metrics_request");
    assertEquals(metricsReq.id, 1);

    // Browser responds to metrics
    browser.sendMetricsResponse(1, 42.5, 10.3, 3.2);
    const metricsResp = await rClient.readMessage<MetricsResponseMessage>();
    assertEquals(metricsResp.id, 1);

    // R finishes drawing plot 2 → frame (newPage:true, 800x600)
    // This is the critical frame: its dimensions match the pending resize
    // entry.  Without the resizeReplay protocol, the server would drain
    // the entry here and the subsequent replay frame would be untagged.
    await rClient.sendFrame(
      { ops: [{ op: "text", str: "faceted-ggplot2" }], device: { width: 800, height: 600 } },
      { newPage: true },
    );
    const plot2Frame = await browser.waitForType<FrameMessage>("frame");
    assertEquals(plot2Frame.resize, undefined, "Plot 2 is a new plot, not a resize response");
  });

  await t.step("stashed resize replay MUST be tagged as resize", async () => {
    // R processes the stashed resize (from recv_metrics_response).
    // poll_resize_impl always replays, even at same dimensions.
    // The replay frame carries resizeReplay:true from R.
    await rClient.sendFrame(
      { ops: [{ op: "text", str: "faceted-ggplot2-resized" }], device: { width: 800, height: 600 } },
      { resizeReplay: true },
    );
    const replayFrame = await browser.waitForType<FrameMessage>("frame");

    assertEquals(
      replayFrame.resize,
      true,
      "Stashed resize replay must be tagged resize:true — otherwise browser creates duplicate plot",
    );
    assertEquals(
      replayFrame.plotIndex,
      undefined,
      "Should be a normal resize, not plotIndex",
    );
  });
}));

// ---------------------------------------------------------------------------
// Scenario 2: plotIndex → normal resize at same dims → metrics plot
//
// Same pattern as scenario 1 at different dimensions (500×400).
// The newPage frame's dims match the pending entry but resizeConsumed is
// absent, so the entry is preserved for the resizeReplay frame.
// ---------------------------------------------------------------------------

Deno.test("plotIndex→normal same-dims → stashed during metrics → replay tagged (variant)", withTestHarness(async (t, { rClient, browser }) => {
  // Prime
  browser.sendResize(1, 1);
  await rClient.readMessage<ResizeMessage>();
  await rClient.sendFrame(
    { ops: [], device: { width: 1, height: 1 } },
  );
  const primingFrame = await browser.waitForType<FrameMessage>("frame");
  const sessionId = primingFrame.plot.sessionId!;

  // Plot 1 at 800x600
  browser.sendResize(800, 600);
  await rClient.readMessage<ResizeMessage>();
  await rClient.sendFrame(
    { ops: [{ op: "rect" }], device: { width: 800, height: 600 } },
    { newPage: true },
  );
  await browser.waitForType<FrameMessage>("frame");
  await rClient.sendFrame(
    { ops: [{ op: "rect" }], device: { width: 800, height: 600 } },
  );
  await browser.waitForType<FrameMessage>("frame");

  await t.step("plotIndex at different dims → normal resize at different dims", async () => {
    // plotIndex resize at 500x400 (different from current 800x600)
    browser.sendResizeWithPlotIndex(500, 400, 0, sessionId);
    await rClient.readMessage<ResizeMessage>();
    await rClient.sendFrame(
      { ops: [{ op: "rect" }], device: { width: 500, height: 400 } },
    );
    await browser.waitForType<FrameMessage>("frame");

    // Normal resize at 500x400 (same as plotIndex, flag bypass)
    browser.sendResize(500, 400);
    const msg = await rClient.readMessage<ResizeMessage>();
    assertEquals(msg.width, 500);
  });

  await t.step("R draws plot 2 with metrics at resize dims", async () => {
    // R sends metrics_request during drawing
    await rClient.sendMetricsRequest(1);
    await browser.waitForType<MetricsRequestMessage>("metrics_request");
    browser.sendMetricsResponse(1, 10, 5, 2);
    await rClient.readMessage<MetricsResponseMessage>();

    // R finishes drawing at 500x400 (same dims as resize).
    // Without the resizeReplay protocol, the server would drain the
    // {500,400} entry here if dims match.
    await rClient.sendFrame(
      { ops: [{ op: "text", str: "plot2" }], device: { width: 500, height: 400 } },
      { newPage: true },
    );
    const frame = await browser.waitForType<FrameMessage>("frame");
    assertEquals(frame.resize, undefined, "Plot 2 is a new plot");
  });

  await t.step("replay at same dims must be tagged", async () => {
    // R processes stashed resize → replays at 500x400.
    // poll_resize_impl sends resizeReplay:true.
    await rClient.sendFrame(
      { ops: [{ op: "text", str: "plot2-resized" }], device: { width: 500, height: 400 } },
      { resizeReplay: true },
    );
    const frame = await browser.waitForType<FrameMessage>("frame");
    assertEquals(frame.resize, true,
      "Replay must be tagged — entry must not have been drained by newPage");
  });
}));

// ---------------------------------------------------------------------------
// Scenario 3: Deferred resize at different dims → metrics plot
//
// When ResizeObserver fires at different dims from ws.onopen before R's
// first frame, the resize is deferred.  After the first frame, the server
// forwards the deferred resize.  If R stashes it during metrics processing
// of the next plot, the resizeReplay flag on the stashed replay ensures
// the server tags it correctly.
// ---------------------------------------------------------------------------

Deno.test("deferred resize stashed during metrics → replay tagged", withTestHarness(async (t, { rClient, browser }) => {
  // Step 1: Initial resize (ws.onopen equivalent)
  browser.sendResize(800, 600);
  const initialResize = await rClient.readMessage<ResizeMessage>();
  assertEquals(initialResize.width, 800);

  // Step 2: ResizeObserver fires at different dims — deferred by server
  // (hasReceivedFrame=false, initialResizeSent=true)
  browser.sendResize(900, 700);
  // R should NOT receive this yet — it's deferred

  await t.step("plot 1 triggers deferred resize forwarding", async () => {
    // R draws plot 1 (simple, at initial resize dims)
    await rClient.sendFrame(
      { ops: [{ op: "rect" }], device: { width: 800, height: 600 } },
      { newPage: true },
    );
    const frame = await browser.waitForType<FrameMessage>("frame");
    assertEquals(frame.resize, undefined, "Plot 1 is a new plot");

    // After first frame, server forwards deferred resize(900,700)
    const deferredResize = await rClient.readMessage<ResizeMessage>();
    assertEquals(deferredResize.width, 900);
    assertEquals(deferredResize.height, 700);
  });

  await t.step("R draws plot 2 with metrics — stashes deferred resize", async () => {
    // R stashed the deferred resize via recv_metrics_response.
    // R draws the new plot at the deferred dims (cb_newPage applied it).

    // Metrics exchange during drawing
    await rClient.sendMetricsRequest(1);
    await browser.waitForType<MetricsRequestMessage>("metrics_request");
    browser.sendMetricsResponse(1, 10, 5, 2);
    await rClient.readMessage<MetricsResponseMessage>();

    // R finishes drawing at 900x700 → frame (newPage:true, 900x700)
    // The pending entry from deferred resize (900x700) matches → drained
    await rClient.sendFrame(
      { ops: [{ op: "text", str: "plot2" }], device: { width: 900, height: 700 } },
      { newPage: true },
    );
    const plot2 = await browser.waitForType<FrameMessage>("frame");
    assertEquals(plot2.resize, undefined, "Plot 2 is a new plot");
  });

  await t.step("stashed deferred resize replay MUST be tagged", async () => {
    // R processes stashed resize → replays at 900x700.
    // poll_resize_impl sends resizeReplay:true.
    await rClient.sendFrame(
      { ops: [{ op: "text", str: "plot2-replayed" }], device: { width: 900, height: 700 } },
      { resizeReplay: true },
    );
    const replay = await browser.waitForType<FrameMessage>("frame");

    assertEquals(
      replay.resize,
      true,
      "Deferred resize replay must be tagged — otherwise browser creates duplicate",
    );
  });
}));

// ---------------------------------------------------------------------------
// Scenario 4: Normal resize → stashed during metrics of next plot
//
// Even without plotIndex involvement, if a resize reaches R and R stashes
// it during metrics processing, the same drain bug can occur when the new
// plot's dimensions match the resize.
// ---------------------------------------------------------------------------

Deno.test("normal resize stashed during metrics of next plot — must be tagged", withTestHarness(async (t, { rClient, browser }) => {
  // Prime
  browser.sendResize(1, 1);
  await rClient.readMessage<ResizeMessage>();
  await rClient.sendFrame(
    { ops: [], device: { width: 1, height: 1 } },
  );
  await browser.waitForType<FrameMessage>("frame");

  // Plot 1 at 800x600
  browser.sendResize(800, 600);
  await rClient.readMessage<ResizeMessage>();
  await rClient.sendFrame(
    { ops: [{ op: "rect" }], device: { width: 800, height: 600 } },
    { newPage: true },
  );
  await browser.waitForType<FrameMessage>("frame");
  // Consume resize replay
  await rClient.sendFrame(
    { ops: [{ op: "rect" }], device: { width: 800, height: 600 } },
  );
  await browser.waitForType<FrameMessage>("frame");

  await t.step("resize to new dims", async () => {
    browser.sendResize(900, 700);
    const msg = await rClient.readMessage<ResizeMessage>();
    assertEquals(msg.width, 900);
  });

  await t.step("R draws plot 2 with metrics at resize dims — stashes resize", async () => {
    // R has stashed the resize during metrics processing.
    // The new plot is drawn at the resize dims (cb_newPage applied it
    // OR the device was already at these dims — either way, the frame
    // dims match the pending entry).

    // Metrics exchange during drawing
    await rClient.sendMetricsRequest(1);
    await browser.waitForType<MetricsRequestMessage>("metrics_request");
    browser.sendMetricsResponse(1, 10, 5, 2);
    await rClient.readMessage<MetricsResponseMessage>();

    // R finishes drawing at resize dims (900x700)
    await rClient.sendFrame(
      { ops: [{ op: "text", str: "plot2" }], device: { width: 900, height: 700 } },
      { newPage: true },
    );
    const frame = await browser.waitForType<FrameMessage>("frame");
    assertEquals(frame.resize, undefined, "Plot 2 is a new plot");
  });

  await t.step("stashed resize replay at same dims must be tagged", async () => {
    // poll_resize_impl sends resizeReplay:true.
    await rClient.sendFrame(
      { ops: [{ op: "text", str: "plot2-replayed" }], device: { width: 900, height: 700 } },
      { resizeReplay: true },
    );
    const replay = await browser.waitForType<FrameMessage>("frame");
    assertEquals(
      replay.resize,
      true,
      "Stashed resize replay must be tagged resize:true",
    );
  });
}));

// ---------------------------------------------------------------------------
// Scenario 5: plotIndex resize of historical plot → resize while viewing
//
// Tests the user-reported Bug 2: ggplot2 as 1st plot, navigate to past
// plot, resize → white image.  The concern is that the plotIndex resize
// frame is incorrectly tagged or that an extra normal resize interferes.
// ---------------------------------------------------------------------------

Deno.test("plotIndex resize while viewing historical — no extra untagged frames", withTestHarness(async (t, { rClient, browser }) => {
  // Prime
  browser.sendResize(1, 1);
  await rClient.readMessage<ResizeMessage>();
  await rClient.sendFrame(
    { ops: [], device: { width: 1, height: 1 } },
  );
  const primingFrame = await browser.waitForType<FrameMessage>("frame");
  const sessionId = primingFrame.plot.sessionId!;

  // Plot 1 (ggplot2-like with metrics) at 800x600
  browser.sendResize(800, 600);
  await rClient.readMessage<ResizeMessage>();

  // Metrics exchange during plot 1 drawing
  await rClient.sendMetricsRequest(1);
  await browser.waitForType<MetricsRequestMessage>("metrics_request");
  browser.sendMetricsResponse(1, 10, 5, 2);
  await rClient.readMessage<MetricsResponseMessage>();

  await rClient.sendFrame(
    { ops: [{ op: "text", str: "ggplot2-faceted" }], device: { width: 800, height: 600 } },
    { newPage: true },
  );
  await browser.waitForType<FrameMessage>("frame");

  // Consume resize replay
  await rClient.sendFrame(
    { ops: [{ op: "text", str: "ggplot2-faceted" }], device: { width: 800, height: 600 } },
  );
  await browser.waitForType<FrameMessage>("frame");

  // Plot 2 (simple)
  await rClient.sendFrame(
    { ops: [{ op: "rect" }], device: { width: 800, height: 600 } },
    { newPage: true },
  );
  await browser.waitForType<FrameMessage>("frame");

  await t.step("plotIndex resize to view plot 1 at new dims", async () => {
    browser.sendResizeWithPlotIndex(640, 480, 0, sessionId);
    const msg = await rClient.readMessage<ResizeMessage>();
    assertEquals(msg.plotIndex, 0);
    assertEquals(msg.width, 640);

    // R replays historical snapshot (plot 1) at 640x480
    // Metrics exchange during replay
    await rClient.sendMetricsRequest(10);
    await browser.waitForType<MetricsRequestMessage>("metrics_request");
    browser.sendMetricsResponse(10, 10, 5, 2);
    await rClient.readMessage<MetricsResponseMessage>();

    await rClient.sendFrame(
      { ops: [{ op: "text", str: "ggplot2-faceted-640" }], device: { width: 640, height: 480 } },
    );
    const frame = await browser.waitForType<FrameMessage>("frame");
    assertEquals(frame.resize, true, "plotIndex replay must be tagged as resize");
    assertEquals(frame.plotIndex, 0, "Must carry plotIndex=0");
  });

  await t.step("no extra untagged frames from normal resize at same dims", async () => {
    // After the plotIndex resize, lastResizeHadPlotIndex=true.
    // If ResizeObserver fires at the same dims (640x480), the flag
    // allows it through.  R replays the CURRENT plot (plot 2, not
    // the historical one).  This frame must be tagged resize:true
    // and must NOT have plotIndex.
    browser.sendResize(640, 480);
    const msg = await rClient.readMessage<ResizeMessage>();
    assertEquals(msg.width, 640);
    assertEquals(msg.plotIndex, undefined);

    // R replays current plot (plot 2) at 640x480
    await rClient.sendFrame(
      { ops: [{ op: "rect" }], device: { width: 640, height: 480 } },
    );
    const frame = await browser.waitForType<FrameMessage>("frame");
    assertEquals(frame.resize, true, "Normal resize replay must be tagged");
    assertEquals(frame.plotIndex, undefined, "Must NOT have plotIndex");
  });
}));
