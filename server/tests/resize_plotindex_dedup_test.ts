import { assertEquals } from "@std/assert";
import { withTestHarness } from "./helpers/harness.ts";
import type { FrameMessage, ResizeMessage } from "./helpers/types.ts";

/**
 * Test suite for the interaction between plotIndex resizes and the
 * normal resize dedup guard.
 *
 * Context (trigd-1uj.20): When a user resizes the viewport while viewing
 * a historical plot (plotIndex resize), then navigates back to the latest
 * plot, the browser sends a normal resize at the current viewport
 * dimensions.  Because the plotIndex resize already updated lastResizeW/H
 * to those same dimensions, the normal resize is silently deduped — even
 * though it targets a different plot (latest vs historical).
 *
 * R's poll_resize_impl does NOT skip same-dimension resizes: it always
 * replays the display list.  A plotIndex resize replays a historical
 * snapshot; a normal resize replays the current display list.  So the
 * two are semantically different even at the same dimensions.
 */

Deno.test("plotIndex→normal dedup interaction", withTestHarness(async (t, { rClient, browser }) => {
  // Prime: send initial frame + consume welcome resize
  browser.sendResize(1, 1);
  await rClient.readMessage<ResizeMessage>();
  await rClient.sendFrame(
    { ops: [], device: { width: 1, height: 1 } },
  );
  const primingFrame = await browser.waitForType<FrameMessage>("frame");
  const sessionId = primingFrame.plot.sessionId!;

  // Set up: dedup state at 800x600 (simulating initial viewport)
  browser.sendResize(800, 600);
  await rClient.readMessage<ResizeMessage>();
  await rClient.sendFrame(
    { ops: [{ op: "rect" }], device: { width: 800, height: 600 } },
  );
  await browser.waitForType<FrameMessage>("frame");

  await t.step("normal→normal same-dims dedup still works", async () => {
    // Dedup state is 800x600.
    // Same dims should be dropped, different dims should arrive.
    browser.sendResize(800, 600); // duplicate — should be dropped
    browser.sendResize(640, 480); // new dims — should arrive

    const msg = await rClient.readMessage<ResizeMessage>();
    assertEquals(msg.width, 640, "800x600 should be deduped; 640x480 should arrive");
    assertEquals(msg.height, 480);

    // Consume frame to keep queue in sync
    await rClient.sendFrame(
      { ops: [{ op: "rect" }], device: { width: 640, height: 480 } },
    );
    await browser.waitForType<FrameMessage>("frame");
  });

  await t.step("plotIndex resize at different dims reaches R", async () => {
    // Dedup state is 640x480 from previous step.
    // plotIndex resize to 500x400 — should bypass dedup.
    browser.sendResizeWithPlotIndex(500, 400, 0, sessionId);
    const msg = await rClient.readMessage<ResizeMessage>();
    assertEquals(msg.type, "resize");
    assertEquals(msg.width, 500);
    assertEquals(msg.height, 400);
    assertEquals(msg.plotIndex, 0);

    // Consume plotIndex frame
    await rClient.sendFrame(
      { ops: [{ op: "rect" }], device: { width: 500, height: 400 } },
    );
    await browser.waitForType<FrameMessage>("frame");
  });

  await t.step("BUG: normal resize at same dims as prior plotIndex is deduped", async () => {
    // Dedup state is now 500x400 (updated by plotIndex resize).
    // User navigates back to latest plot — browser sends normal resize
    // at 500x400 (current viewport), targeting the latest plot's
    // display list.  This SHOULD reach R, but the dedup guard blocks it.
    //
    // This test documents the current (buggy) behavior.
    // After trigd-1uj.22 is fixed, this test should be updated to
    // expect the normal resize to reach R.
    browser.sendResize(500, 400); // targets latest plot — currently deduped
    browser.sendResize(700, 500); // sentinel — should arrive

    const msg = await rClient.readMessage<ResizeMessage>();
    // Current behavior: 500x400 is deduped, 700x500 arrives.
    // Desired behavior: 500x400 should arrive (no plotIndex).
    assertEquals(msg.width, 700, "BUG: 500x400 normal resize was deduped after plotIndex at same dims");
    assertEquals(msg.height, 500);

    // Consume frame
    await rClient.sendFrame(
      { ops: [{ op: "rect" }], device: { width: 700, height: 500 } },
    );
    await browser.waitForType<FrameMessage>("frame");
  });

  await t.step("normal resize at different dims from plotIndex is not deduped", async () => {
    // Send a plotIndex resize to 400x300
    browser.sendResizeWithPlotIndex(400, 300, 1, sessionId);
    await rClient.readMessage<ResizeMessage>();
    await rClient.sendFrame(
      { ops: [{ op: "rect" }], device: { width: 400, height: 300 } },
    );
    await browser.waitForType<FrameMessage>("frame");

    // Dedup state is 400x300.
    // Normal resize at 700x500 (different) — should reach R.
    browser.sendResize(700, 500);
    const msg = await rClient.readMessage<ResizeMessage>();
    assertEquals(msg.width, 700);
    assertEquals(msg.height, 500);
    assertEquals(msg.plotIndex, undefined, "Normal resize should not have plotIndex");

    // Consume frame and verify tagging
    await rClient.sendFrame(
      { ops: [{ op: "circle" }], device: { width: 700, height: 500 } },
    );
    const frame = await browser.waitForType<FrameMessage>("frame");
    assertEquals(frame.resize, true);
    assertEquals(frame.plotIndex, undefined);
  });
}));

Deno.test("multiple plotIndex then normal resize", withTestHarness(async (t, { rClient, browser }) => {
  // Prime
  browser.sendResize(1, 1);
  await rClient.readMessage<ResizeMessage>();
  await rClient.sendFrame(
    { ops: [], device: { width: 1, height: 1 } },
  );
  const primingFrame = await browser.waitForType<FrameMessage>("frame");
  const sessionId = primingFrame.plot.sessionId!;

  // Set up at 800x600
  browser.sendResize(800, 600);
  await rClient.readMessage<ResizeMessage>();
  await rClient.sendFrame(
    { ops: [{ op: "rect" }], device: { width: 800, height: 600 } },
  );
  await browser.waitForType<FrameMessage>("frame");

  await t.step("two sequential plotIndex resizes update dedup state correctly", async () => {
    // First plotIndex resize to 500x400
    browser.sendResizeWithPlotIndex(500, 400, 0, sessionId);
    await rClient.readMessage<ResizeMessage>();
    await rClient.sendFrame(
      { ops: [{ op: "rect" }], device: { width: 500, height: 400 } },
    );
    await browser.waitForType<FrameMessage>("frame");

    // Second plotIndex resize to 600x450
    browser.sendResizeWithPlotIndex(600, 450, 1, sessionId);
    await rClient.readMessage<ResizeMessage>();
    await rClient.sendFrame(
      { ops: [{ op: "rect" }], device: { width: 600, height: 450 } },
    );
    await browser.waitForType<FrameMessage>("frame");

    // Dedup state is now 600x450.
    // Normal resize at 500x400 — different from dedup state, should arrive.
    browser.sendResize(500, 400);
    const msg = await rClient.readMessage<ResizeMessage>();
    assertEquals(msg.width, 500);
    assertEquals(msg.height, 400);
    assertEquals(msg.plotIndex, undefined);

    // Consume frame
    await rClient.sendFrame(
      { ops: [{ op: "rect" }], device: { width: 500, height: 400 } },
    );
    await browser.waitForType<FrameMessage>("frame");
  });

  await t.step("BUG: normal resize after plotIndex at matching dedup state", async () => {
    // Dedup state is 500x400 from previous step.
    // plotIndex resize to 500x400 (same dims, different plot).
    browser.sendResizeWithPlotIndex(500, 400, 2, sessionId);
    const piMsg = await rClient.readMessage<ResizeMessage>();
    assertEquals(piMsg.plotIndex, 2, "plotIndex bypasses dedup even at same dims");
    await rClient.sendFrame(
      { ops: [{ op: "rect" }], device: { width: 500, height: 400 } },
    );
    await browser.waitForType<FrameMessage>("frame");

    // Now normal resize at 500x400 — should reach R (different plot)
    // but currently deduped.
    browser.sendResize(500, 400);
    browser.sendResize(900, 700); // sentinel

    const msg = await rClient.readMessage<ResizeMessage>();
    // Current behavior: 500x400 deduped, sentinel arrives.
    // Desired: 500x400 arrives.
    assertEquals(msg.width, 900, "BUG: normal resize at 500x400 deduped after plotIndex at same dims");

    // Consume frame
    await rClient.sendFrame(
      { ops: [{ op: "rect" }], device: { width: 900, height: 700 } },
    );
    await browser.waitForType<FrameMessage>("frame");
  });
}));

Deno.test("plotIndex→normal→normal dedup chain", withTestHarness(async (t, { rClient, browser }) => {
  // Prime
  browser.sendResize(1, 1);
  await rClient.readMessage<ResizeMessage>();
  await rClient.sendFrame(
    { ops: [], device: { width: 1, height: 1 } },
  );
  const primingFrame = await browser.waitForType<FrameMessage>("frame");
  const sessionId = primingFrame.plot.sessionId!;

  // Set up at 800x600
  browser.sendResize(800, 600);
  await rClient.readMessage<ResizeMessage>();
  await rClient.sendFrame(
    { ops: [{ op: "rect" }], device: { width: 800, height: 600 } },
  );
  await browser.waitForType<FrameMessage>("frame");

  await t.step("after fix: normal→normal at same dims should still be deduped", async () => {
    // plotIndex resize to 500x400
    browser.sendResizeWithPlotIndex(500, 400, 0, sessionId);
    await rClient.readMessage<ResizeMessage>();
    await rClient.sendFrame(
      { ops: [{ op: "rect" }], device: { width: 500, height: 400 } },
    );
    await browser.waitForType<FrameMessage>("frame");

    // Normal resize at 500x400 — after fix, this should reach R
    // (first normal after plotIndex). For now it's deduped.
    // We send a sentinel to proceed regardless of current behavior.
    browser.sendResize(500, 400);
    browser.sendResize(500, 400); // second normal at same dims
    browser.sendResize(1200, 900); // sentinel

    const msg = await rClient.readMessage<ResizeMessage>();
    // With current behavior: all three 500x400 are deduped, sentinel arrives
    // With fix: first 500x400 arrives, second is deduped, then 1200x900 arrives
    // Either way, sentinel eventually arrives. Check it's there.
    if (msg.width === 500) {
      // Fix is in place: first 500x400 arrived.
      assertEquals(msg.plotIndex, undefined, "Should be normal resize, not plotIndex");

      // Consume frame for first normal resize
      await rClient.sendFrame(
        { ops: [{ op: "rect" }], device: { width: 500, height: 400 } },
      );
      await browser.waitForType<FrameMessage>("frame");

      // Second 500x400 should be deduped (normal→normal same dims).
      // 1200x900 should arrive.
      const msg2 = await rClient.readMessage<ResizeMessage>();
      assertEquals(msg2.width, 1200, "Second 500x400 should be deduped; sentinel should arrive");
      assertEquals(msg2.height, 900);
    } else {
      // Current buggy behavior: all deduped, sentinel arrived.
      assertEquals(msg.width, 1200, "Current behavior: all 500x400 deduped");
    }

    // Consume sentinel frame
    await rClient.sendFrame(
      { ops: [{ op: "rect" }], device: { width: msg.width, height: msg.height } },
    );
    await browser.waitForType<FrameMessage>("frame");
  });
}));
