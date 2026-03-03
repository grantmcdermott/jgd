import { assertEquals } from "@std/assert";
import { withTestHarness } from "./helpers/harness.ts";
import type { FrameMessage, ResizeMessage } from "./helpers/types.ts";

/**
 * Test suite for the interaction between plotIndex resizes and the
 * normal resize dedup guard.
 *
 * Context: When a user resizes the viewport while viewing
 * a historical plot (plotIndex resize), then navigates back to the latest
 * plot, the browser sends a normal resize at the current viewport
 * dimensions.  The dedup guard uses a lastResizeHadPlotIndex flag to
 * allow this normal resize through — even though the dimensions match —
 * because the two target different display lists (historical snapshot
 * vs current).
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

  await t.step("normal resize at same dims as prior plotIndex passes through", async () => {
    // Dedup state is now 500x400 (updated by plotIndex resize).
    // User navigates back to latest plot — browser sends normal resize
    // at 500x400 (current viewport), targeting the latest plot's
    // display list.  The lastResizeHadPlotIndex flag ensures this
    // passes through despite matching dimensions.
    browser.sendResize(500, 400); // targets latest plot — should arrive

    const msg = await rClient.readMessage<ResizeMessage>();
    assertEquals(msg.width, 500, "Normal resize after plotIndex should pass through");
    assertEquals(msg.height, 400);
    assertEquals(msg.plotIndex, undefined, "Should be a normal resize, not plotIndex");

    // Consume frame
    await rClient.sendFrame(
      { ops: [{ op: "rect" }], device: { width: 500, height: 400 } },
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

  await t.step("normal resize after plotIndex at matching dedup state passes through", async () => {
    // Dedup state is 500x400 from previous step.
    // plotIndex resize to 500x400 (same dims, different plot).
    browser.sendResizeWithPlotIndex(500, 400, 2, sessionId);
    const piMsg = await rClient.readMessage<ResizeMessage>();
    assertEquals(piMsg.plotIndex, 2, "plotIndex bypasses dedup even at same dims");
    await rClient.sendFrame(
      { ops: [{ op: "rect" }], device: { width: 500, height: 400 } },
    );
    await browser.waitForType<FrameMessage>("frame");

    // Now normal resize at 500x400 — should reach R because the
    // lastResizeHadPlotIndex flag allows it through.
    browser.sendResize(500, 400);

    const msg = await rClient.readMessage<ResizeMessage>();
    assertEquals(msg.width, 500, "Normal resize after plotIndex should pass through");
    assertEquals(msg.height, 400);
    assertEquals(msg.plotIndex, undefined, "Should be a normal resize");

    // Consume frame
    await rClient.sendFrame(
      { ops: [{ op: "rect" }], device: { width: 500, height: 400 } },
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

  await t.step("normal→normal at same dims should still be deduped after plotIndex", async () => {
    // plotIndex resize to 500x400
    browser.sendResizeWithPlotIndex(500, 400, 0, sessionId);
    await rClient.readMessage<ResizeMessage>();
    await rClient.sendFrame(
      { ops: [{ op: "rect" }], device: { width: 500, height: 400 } },
    );
    await browser.waitForType<FrameMessage>("frame");

    // First normal resize at 500x400 — passes through because
    // lastResizeHadPlotIndex flag allows it.
    browser.sendResize(500, 400);
    browser.sendResize(500, 400); // second normal at same dims — deduped
    browser.sendResize(1200, 900); // different dims — arrives

    const msg = await rClient.readMessage<ResizeMessage>();
    assertEquals(msg.width, 500, "First 500x400 should pass through after plotIndex");
    assertEquals(msg.plotIndex, undefined, "Should be normal resize, not plotIndex");

    // Consume frame for first normal resize
    await rClient.sendFrame(
      { ops: [{ op: "rect" }], device: { width: 500, height: 400 } },
    );
    await browser.waitForType<FrameMessage>("frame");

    // Second 500x400 should be deduped (normal→normal same dims).
    // 1200x900 should arrive.
    const msg2 = await rClient.readMessage<ResizeMessage>();
    assertEquals(msg2.width, 1200, "Second 500x400 should be deduped; 1200x900 should arrive");
    assertEquals(msg2.height, 900);

    // Consume sentinel frame
    await rClient.sendFrame(
      { ops: [{ op: "rect" }], device: { width: 1200, height: 900 } },
    );
    await browser.waitForType<FrameMessage>("frame");
  });
}));
