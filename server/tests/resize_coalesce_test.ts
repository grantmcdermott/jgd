/**
 * Server protocol test: one resize → one frame (no coalescing).
 *
 * Real R's poll_resize_impl() reads ONE message per call, producing
 * one frame per resize.  This keeps the server's FIFO queue in sync.
 *
 * Previously, poll_resize_impl read ALL available messages in a loop
 * (coalescing), producing fewer frames than queue entries.  Stale
 * entries would mis-tag subsequent regular frames.
 *
 * This test verifies that when R processes each resize separately,
 * each frame gets the correct tag and subsequent regular frames are
 * not contaminated by stale queue entries.
 */

import { assertEquals } from "@std/assert";
import { TestServer } from "./helpers/server.ts";
import { RClient } from "./helpers/r_client.ts";
import { BrowserClient } from "./helpers/browser_client.ts";
import { delay } from "@std/async";
import type { FrameMessage, ResizeMessage } from "./helpers/types.ts";

Deno.test("one resize per frame — no stale queue entries", async (t) => {
  const server = new TestServer();
  const rClient = new RClient();
  const browser = new BrowserClient();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await browser.connect(server.wsUrl);
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

    // Prime dedup state: send a resize at initial dims so the server
    // records lastResizeW/H.  Without this, the first test resize at
    // (640, 480) would be the session's first resize, bypassing dedup
    // and mixing up initialResizeSent logic.  Consume the entry with a
    // frame so the queue starts empty for the actual test step.
    browser.sendResize(800, 600);
    await rClient.readMessage<ResizeMessage>();
    await rClient.sendFrame(
      { ops: [{ op: "text", str: "plot2" }], device: { width: 800, height: 600 } },
    );
    await browser.waitForType<FrameMessage>("frame");

    await t.step("each resize produces its own correctly-tagged frame", async () => {
      // Browser sends two resize messages in quick succession:
      // 1. Normal resize (no plotIndex) — e.g. ws.onopen
      // 2. plotIndex resize — e.g. ResizeObserver after debounce
      browser.sendResize(640, 480);
      // Small delay to ensure the first resize is forwarded to R before
      // the plotIndex resize arrives.  The exact value isn't critical:
      // both messages travel through the same event loop, but the delay
      // guarantees they're processed in separate turns.
      await delay(50);
      browser.sendResizeWithPlotIndex(640, 480, 0, sessionId);

      // R receives both resize messages (in order)
      const msg1 = await rClient.readMessage<ResizeMessage>();
      assertEquals(msg1.type, "resize");
      assertEquals(msg1.plotIndex, undefined, "First resize should not have plotIndex");

      const msg2 = await rClient.readMessage<ResizeMessage>();
      assertEquals(msg2.type, "resize");
      assertEquals(msg2.plotIndex, 0, "Second resize should have plotIndex=0");

      // R processes resize 1 (normal) — sends one frame.
      // poll_resize_impl reads ONE message per call, so this frame
      // corresponds exactly to the first resize.
      await rClient.sendFrame(
        { ops: [{ op: "text", str: "plot2-resized" }], device: { width: 640, height: 480 } },
      );
      const resizeFrame1 = await browser.waitForType<FrameMessage>("frame");
      assertEquals(resizeFrame1.resize, true, "First frame should be a resize response");
      assertEquals(
        resizeFrame1.plotIndex,
        undefined,
        "First frame (normal resize) should NOT have plotIndex",
      );

      // R processes resize 2 (plotIndex=0) — sends another frame.
      await rClient.sendFrame(
        { ops: [{ op: "text", str: "plot1-resized" }], device: { width: 640, height: 480 } },
      );
      const resizeFrame2 = await browser.waitForType<FrameMessage>("frame");
      assertEquals(resizeFrame2.resize, true, "Second frame should be a resize response");
      assertEquals(
        resizeFrame2.plotIndex,
        0,
        "Second frame (plotIndex resize) should have plotIndex=0",
      );

      // R sends a NEW regular frame — user draws a new plot.
      // Queue should be empty — no stale entries to contaminate this frame.
      await rClient.sendFrame(
        { ops: [{ op: "text", str: "plot3-new" }], device: { width: 640, height: 480 } },
      );
      const newFrame = await browser.waitForType<FrameMessage>("frame");
      assertEquals(
        newFrame.resize,
        undefined,
        "New plot frame must NOT be tagged as resize response",
      );
      assertEquals(
        newFrame.plotIndex,
        undefined,
        "New plot frame must NOT have plotIndex",
      );
    });
  } finally {
    browser.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});
