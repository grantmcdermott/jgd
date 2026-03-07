/**
 * Server-side protocol test for plotIndex resize frames.
 *
 * R now self-reports plotIndex in the frame message when replaying a
 * historical snapshot.  The server reads plotIndex directly from the
 * frame and injects resize:true when resizeReplay is present.
 *
 * These tests verify:
 * 1. plotIndex resize frames are tagged with resize:true and plotIndex
 * 2. Multiple plotIndex frames are each tagged correctly
 * 3. Subsequent new-plot frames are not mistagged
 */

import { assertEquals } from "@std/assert";
import { withTestHarness } from "./helpers/harness.ts";
import type { FrameMessage, ResizeMessage } from "./helpers/types.ts";

Deno.test("plotIndex: R responds to first of two plotIndex resizes", withTestHarness(async (t, { rClient, browser }) => {
  // Prime dedup state and establish sessionId
  browser.sendResize(1, 1);
  await rClient.readMessage<ResizeMessage>();
  await rClient.sendFrame(
    { ops: [], device: { width: 1, height: 1 } },
    { resizeReplay: true },
  );
  const primingFrame = await browser.waitForType<FrameMessage>("frame");
  const sessionId = primingFrame.plot.sessionId!;

  // Plot 1 (newPage=true): establishes history[0]
  await rClient.sendFrame(
    { ops: [{ op: "rect", fill: "red" }], device: { width: 400, height: 300 } },
    { newPage: true },
  );
  await browser.waitForType<FrameMessage>("frame");

  // Plot 2 (newPage=true): establishes history[1]
  await rClient.sendFrame(
    { ops: [{ op: "rect", fill: "blue" }], device: { width: 400, height: 300 } },
    { newPage: true },
  );
  await browser.waitForType<FrameMessage>("frame");

  await t.step("two plotIndex resizes forwarded to R", async () => {
    browser.sendResizeWithPlotIndex(500, 400, 0, sessionId);
    browser.sendResizeWithPlotIndex(600, 450, 1, sessionId);

    const msg1 = await rClient.readMessage<ResizeMessage>();
    assertEquals(msg1.type, "resize");
    assertEquals(msg1.plotIndex, 0);
    assertEquals(msg1.width, 500);

    const msg2 = await rClient.readMessage<ResizeMessage>();
    assertEquals(msg2.type, "resize");
    assertEquals(msg2.plotIndex, 1);
    assertEquals(msg2.width, 600);
  });

  await t.step("R responds to first plotIndex only — tagged correctly", async () => {
    // R replays snapshot[0] at 500x400, including plotIndex in the frame.
    await rClient.sendFrame(
      { ops: [{ op: "rect", fill: "red" }], device: { width: 500, height: 400 } },
      { resizeReplay: true, plotIndex: 0 },
    );
    const frame = await browser.waitForType<FrameMessage>("frame");

    assertEquals(frame.resize, true,
      "Frame must be tagged as resize");
    assertEquals(frame.plotIndex, 0,
      "plotIndex must be 0 (from R's frame)");
    assertEquals(frame.plot.device.width, 500);
    assertEquals(frame.plot.device.height, 400);
  });

  await t.step("subsequent normal frame is not mistagged", async () => {
    await rClient.sendFrame(
      { ops: [{ op: "rect", fill: "green" }], device: { width: 400, height: 300 } },
      { newPage: true },
    );
    const frame = await browser.waitForType<FrameMessage>("frame");

    assertEquals(frame.resize, undefined,
      "New plot must not be tagged as resize");
    assertEquals(frame.plotIndex, undefined,
      "New plot must not have plotIndex");
  });
}));

Deno.test("plotIndex: both resizes consumed when R responds to both", withTestHarness(async (t, { rClient, browser }) => {
  // Baseline: when R responds to both plotIndex resizes, both
  // should be tagged correctly with their respective plotIndex.
  browser.sendResize(1, 1);
  await rClient.readMessage<ResizeMessage>();
  await rClient.sendFrame(
    { ops: [], device: { width: 1, height: 1 } },
    { resizeReplay: true },
  );
  const primingFrame = await browser.waitForType<FrameMessage>("frame");
  const sessionId = primingFrame.plot.sessionId!;

  // Two plots
  await rClient.sendFrame(
    { ops: [{ op: "rect", fill: "red" }], device: { width: 400, height: 300 } },
    { newPage: true },
  );
  await browser.waitForType<FrameMessage>("frame");

  await rClient.sendFrame(
    { ops: [{ op: "rect", fill: "blue" }], device: { width: 400, height: 300 } },
    { newPage: true },
  );
  await browser.waitForType<FrameMessage>("frame");

  // Two plotIndex resizes
  browser.sendResizeWithPlotIndex(500, 400, 0, sessionId);
  browser.sendResizeWithPlotIndex(600, 450, 1, sessionId);

  await rClient.readMessage<ResizeMessage>();
  await rClient.readMessage<ResizeMessage>();

  await t.step("first plotIndex response tagged correctly", async () => {
    await rClient.sendFrame(
      { ops: [{ op: "rect", fill: "red" }], device: { width: 500, height: 400 } },
      { resizeReplay: true, plotIndex: 0 },
    );
    const frame = await browser.waitForType<FrameMessage>("frame");
    assertEquals(frame.resize, true);
    assertEquals(frame.plotIndex, 0);
  });

  await t.step("second plotIndex response tagged correctly", async () => {
    await rClient.sendFrame(
      { ops: [{ op: "rect", fill: "blue" }], device: { width: 600, height: 450 } },
      { resizeReplay: true, plotIndex: 1 },
    );
    const frame = await browser.waitForType<FrameMessage>("frame");
    assertEquals(frame.resize, true);
    assertEquals(frame.plotIndex, 1);
  });
}));
