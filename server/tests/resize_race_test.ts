/**
 * Server protocol test: resize state race condition.
 *
 * When the browser sends two resize messages in quick succession (e.g.,
 * ws.onopen resize without plotIndex, then ResizeObserver with plotIndex
 * after 300ms debounce), R processes them separately and includes the
 * correct plotIndex (or lack thereof) in each frame's JSON.
 *
 * This test verifies that the server correctly passes through R's
 * plotIndex from the frame message, rather than mixing up state between
 * the two resize responses.
 */

import { assertEquals } from "@std/assert";
import { withTestHarness } from "./helpers/harness.ts";
import { delay } from "@std/async";
import type { FrameMessage, ResizeMessage } from "./helpers/types.ts";

Deno.test("resize state race — normal then plotIndex", withTestHarness(async (t, { rClient, browser }) => {
  await rClient.waitForWelcome();

  // Send two initial frames to establish plot history
  await rClient.sendFrame(
    { ops: [{ op: "text", str: "plot1" }], device: { width: 800, height: 600 } },
  );
  const frame1 = await browser.waitForType<FrameMessage>("frame");
  const sessionId = frame1.plot.sessionId!;

  await rClient.sendFrame(
    { ops: [{ op: "text", str: "plot2" }], device: { width: 800, height: 600 } },
  );
  await browser.waitForType<FrameMessage>("frame");

  // Prime dedup state.  Consume the pending resize with a frame so
  // dedup state is in sync (in production, every resize triggers a frame).
  browser.sendResize(800, 600);
  await rClient.readMessage<ResizeMessage>();
  await rClient.sendFrame(
    { ops: [{ op: "text", str: "plot2" }], device: { width: 800, height: 600 } },
    { resizeReplay: true },
  );
  await browser.waitForType<FrameMessage>("frame");

  await t.step("normal resize frame should not get plotIndex from later message", async () => {
    // Simulate the real browser behavior:
    // 1. Browser sends normal resize (like ws.onopen on reconnect)
    // 2. Shortly after, browser sends plotIndex resize (ResizeObserver)
    //
    // Both arrive at the server before R responds to the first one.
    browser.sendResize(640, 480);
    // Small delay to ensure server processes the first resize
    await delay(50);
    browser.sendResizeWithPlotIndex(640, 480, 0, sessionId);

    // R receives both resize messages (in order)
    const msg1 = await rClient.readMessage<ResizeMessage>();
    assertEquals(msg1.type, "resize");
    assertEquals(msg1.width, 640);
    assertEquals(msg1.plotIndex, undefined, "First resize should NOT have plotIndex");

    const msg2 = await rClient.readMessage<ResizeMessage>();
    assertEquals(msg2.type, "resize");
    assertEquals(msg2.width, 640);
    assertEquals(msg2.plotIndex, 0, "Second resize should have plotIndex=0");

    // R processes message 1 first (normal resize) and sends a frame.
    // This frame is the current plot (plot 2) re-rendered.
    await rClient.sendFrame(
      { ops: [{ op: "text", str: "plot2-resized" }], device: { width: 640, height: 480 } },
      { resizeReplay: true },
    );

    // The browser should receive this frame as a normal resize (no plotIndex).
    // R did not include plotIndex in the frame JSON because it was a normal resize.
    const frame1 = await browser.waitForType<FrameMessage>("frame");
    assertEquals(frame1.resize, true, "First frame should be a resize response");
    assertEquals(
      frame1.plotIndex,
      undefined,
      "First frame (normal resize of plot 2) should NOT have plotIndex",
    );

    // R processes message 2 (plotIndex resize) and sends the historical plot.
    // R includes plotIndex:0 in the frame JSON because it was a plotIndex resize.
    await rClient.sendFrame(
      { ops: [{ op: "text", str: "plot1-resized" }], device: { width: 640, height: 480 } },
      { resizeReplay: true, plotIndex: 0 },
    );

    // The browser should receive this frame with plotIndex:0.
    // R reported the plotIndex directly in the frame, so the server passes it through.
    const frame2 = await browser.waitForType<FrameMessage>("frame");
    assertEquals(
      frame2.resize,
      true,
      "Second frame (plotIndex resize of plot 1) should have resize:true",
    );
    assertEquals(
      frame2.plotIndex,
      0,
      "Second frame should have plotIndex:0",
    );
  });
}));
