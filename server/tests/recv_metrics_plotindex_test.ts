/**
 * Server-side protocol test for recv_metrics_response plotIndex buffering.
 *
 * When two plotIndex resize messages arrive during a metrics exchange,
 * the R device (recv_metrics_response) should buffer only the first
 * and skip the second (FIFO ordering matches the server's queue).
 *
 * This test verifies the server correctly handles the situation where
 * R responds to only ONE of two plotIndex resizes:
 * 1. Both plotIndex resize messages are forwarded to R
 * 2. R's single frame response is tagged with the first plotIndex
 * 3. The orphaned queue entry for the second resize is drained by
 *    subsequent frames without corrupting tagging
 */

import { assertEquals } from "@std/assert";
import { withTestHarness } from "./helpers/harness.ts";
import type { FrameMessage, ResizeMessage } from "./helpers/types.ts";

Deno.test("plotIndex FIFO: R responds to first of two plotIndex resizes", withTestHarness(async (t, { rClient, browser }) => {
  // Prime dedup state and establish sessionId
  browser.sendResize(1, 1);
  await rClient.readMessage<ResizeMessage>();
  await rClient.sendFrame(
    { ops: [], device: { width: 1, height: 1 } },
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
    // Browser sends two plotIndex resizes in quick succession.
    // In production, these would arrive during a metrics exchange.
    browser.sendResizeWithPlotIndex(500, 400, 0, sessionId);
    browser.sendResizeWithPlotIndex(600, 450, 1, sessionId);

    // R receives both resize messages
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
    // After the fix, recv_metrics_response buffers only the first
    // plotIndex resize (pi=0 at 500x400) and skips the second.
    // R replays snapshot[0] at 500x400.
    await rClient.sendFrame(
      { ops: [{ op: "rect", fill: "red" }], device: { width: 500, height: 400 } },
    );
    const frame = await browser.waitForType<FrameMessage>("frame");

    assertEquals(frame.resize, true,
      "Frame must be tagged as resize");
    assertEquals(frame.plotIndex, 0,
      "plotIndex must be 0 (from first buffered resize)");
    assertEquals(frame.plot.device.width, 500);
    assertEquals(frame.plot.device.height, 400);
  });

  await t.step("subsequent normal frame is not mistagged", async () => {
    // After the first plotIndex resize was consumed, the second
    // plotIndex entry (pi=1 at 600x450) remains in the queue.
    // A normal new-plot frame should NOT be mistagged with it
    // because newPage frames without resizeConsumed preserve pending
    // entries for subsequent resizeReplay frames.
    //
    // If dims don't match, the entry is simply left in the queue
    // for future consumption.
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

Deno.test("plotIndex FIFO: both resizes consumed when R responds to both", withTestHarness(async (t, { rClient, browser }) => {
  // Baseline: when R responds to both plotIndex resizes (the normal
  // non-metrics-overlap case), both should be tagged correctly.
  browser.sendResize(1, 1);
  await rClient.readMessage<ResizeMessage>();
  await rClient.sendFrame(
    { ops: [], device: { width: 1, height: 1 } },
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
    );
    const frame = await browser.waitForType<FrameMessage>("frame");
    assertEquals(frame.resize, true);
    assertEquals(frame.plotIndex, 0);
  });

  await t.step("second plotIndex response tagged correctly", async () => {
    await rClient.sendFrame(
      { ops: [{ op: "rect", fill: "blue" }], device: { width: 600, height: 450 } },
    );
    const frame = await browser.waitForType<FrameMessage>("frame");
    assertEquals(frame.resize, true);
    assertEquals(frame.plotIndex, 1);
  });
}));
