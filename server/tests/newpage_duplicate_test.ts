/**
 * Reproduction tests for the newPage duplicate plot regression.
 *
 * Symptom: Creating plot 2 causes plot 1 to appear duplicated in browser
 * history as [plot1, plot1-copy, plot2] instead of [plot1, plot2].
 *
 * These tests exercise the server's frame routing at the protocol level,
 * simulating message sequences that arise in real browser+R interactions.
 *
 * The key distinction: R self-reports resizeReplay:true on frames from
 * poll_resize_impl.  The server injects resize:true only when it sees
 * resizeReplay:true.  newPage frames (genuinely new plots) never have
 * resizeReplay, so they are never tagged as resize responses.
 */

import { assertEquals } from "@std/assert";
import { withTestHarness } from "./helpers/harness.ts";
import type { FrameMessage, ResizeMessage } from "./helpers/types.ts";

// ---------------------------------------------------------------------------
// Scenario 1: Baseline — two new plots, no resize between them
// ---------------------------------------------------------------------------

Deno.test("two sequential new plots — both untagged", withTestHarness(async (t, { rClient, browser }) => {
  await rClient.waitForWelcome();

  // Initial resize from browser (ws.onopen equivalent)
  browser.sendResize(800, 600);
  await rClient.readMessage<ResizeMessage>();

  await t.step("plot 1 — new plot", async () => {
    await rClient.sendFrame({
      ops: [{ op: "text", str: "plot1" }],
      device: { width: 800, height: 600 },
    }, { newPage: true });
    const frame = await browser.waitForType<FrameMessage>("frame");
    assertEquals(frame.resize, undefined, "Plot 1 must not be tagged as resize");
  });

  await t.step("plot 2 — new plot, not a duplicate", async () => {
    await rClient.sendFrame({
      ops: [{ op: "text", str: "plot2" }],
      device: { width: 800, height: 600 },
    }, { newPage: true });
    const frame = await browser.waitForType<FrameMessage>("frame");
    assertEquals(frame.resize, undefined, "Plot 2 must not be tagged as resize");
  });
}));

// ---------------------------------------------------------------------------
// Scenario 2 (Race A): R consumes resize in cb_newPage — new-plot frame at
// resize dims.
//
// Timeline:
//   1. Browser sends resize → server sends to R
//   2. R reads resize in cb_newPage's check_incoming (NOT poll_resize_impl)
//   3. R draws new plot at resize dims → sends frame with newPage:true
//      (no resizeReplay).  Server does not tag.
//   4. Browser calls addPlot ✓
// ---------------------------------------------------------------------------

Deno.test("race A: new plot at resize dims should not be tagged (cb_newPage consumed resize)", withTestHarness(async (t, { rClient, browser }) => {
  await rClient.waitForWelcome();

  // Prime: initial resize + first frame
  browser.sendResize(800, 600);
  await rClient.readMessage<ResizeMessage>();
  await rClient.sendFrame({
    ops: [{ op: "text", str: "plot1" }],
    device: { width: 800, height: 600 },
  }, { newPage: true });
  await browser.waitForType<FrameMessage>("frame");

  await t.step("resize sent to R", async () => {
    browser.sendResize(900, 700);
    const msg = await rClient.readMessage<ResizeMessage>();
    assertEquals(msg.width, 900);
  });

  await t.step("R sends new plot at resize dims (not a replay)", async () => {
    // R consumed the resize in cb_newPage's check_incoming and drew
    // the new plot at the resize dimensions.  No separate replay.
    // The newPage flag + absence of resizeReplay tells the server
    // this is a new plot.
    await rClient.sendFrame({
      ops: [{ op: "text", str: "plot2-NEW" }],
      device: { width: 900, height: 700 },
    }, { newPage: true });
    const frame = await browser.waitForType<FrameMessage>("frame");

    assertEquals(
      frame.resize,
      undefined,
      "New plot must not be tagged as resize even when dims match",
    );
  });
}));

// ---------------------------------------------------------------------------
// Scenario 3 (Race B): R's recv_metrics_response consumes resize during
// drawing.  New-plot frame arrives at OLD dims with newPage:true.
//
// Timeline:
//   1. Browser sends resize(900,700)
//   2. R is drawing plot 2 with metrics.  recv_metrics_response reads the
//      resize → pending_w/h set but not applied during drawing.
//   3. R flushes plot 2 at OLD dims (800,600) with newPage:true.
//   4. R finishes, returns to prompt.  poll_resize_impl sees pending_w/h,
//      replays plot 2 at 900x700 → frame with resizeReplay:true.
//      Server injects resize:true.  ✓
// ---------------------------------------------------------------------------

Deno.test("race B: new plot at old dims, then resize replay tagged", withTestHarness(async (t, { rClient, browser }) => {
  await rClient.waitForWelcome();

  // Prime: initial resize + first frame
  browser.sendResize(800, 600);
  await rClient.readMessage<ResizeMessage>();
  await rClient.sendFrame({
    ops: [{ op: "text", str: "plot1" }],
    device: { width: 800, height: 600 },
  }, { newPage: true });
  await browser.waitForType<FrameMessage>("frame");

  await t.step("resize sent to R", async () => {
    browser.sendResize(900, 700);
    const msg = await rClient.readMessage<ResizeMessage>();
    assertEquals(msg.width, 900);
  });

  await t.step("new plot at old dims — should not be tagged", async () => {
    // R was drawing when the resize arrived.  recv_metrics_response
    // consumed the resize message but didn't apply the dimensions.
    // The frame is flushed at the old dimensions with newPage:true.
    await rClient.sendFrame({
      ops: [{ op: "text", str: "plot2" }],
      device: { width: 800, height: 600 },
    }, { newPage: true });
    const frame = await browser.waitForType<FrameMessage>("frame");

    assertEquals(
      frame.resize,
      undefined,
      "New plot at old dims must not be tagged as resize",
    );
  });

  await t.step("resize replay at new dims — should be tagged", async () => {
    // R returns to prompt, poll_resize_impl applies pending_w/h and
    // replays the current plot at the new dimensions with resizeReplay.
    await rClient.sendFrame({
      ops: [{ op: "text", str: "plot2-resized" }],
      device: { width: 900, height: 700 },
    }, { resizeReplay: true });
    const frame = await browser.waitForType<FrameMessage>("frame");

    assertEquals(
      frame.resize,
      true,
      "Resize replay must be tagged",
    );
  });
}));

// ---------------------------------------------------------------------------
// Scenario 4: Full duplicate sequence — three frames for two plots.
//
// This matches the user-reported symptom exactly:
//   [plot1, plot1-copy, plot2] instead of [plot1, plot2]
//
// Timeline:
//   1. Browser sends initial resize(800,600), sent to R.
//   2. R does NOT process the resize before the user creates plot 1
//      (timing: user typed command before input handler fired).
//   3. R draws plot 1 at default dims with newPage:true → frame.
//      Server: no resizeReplay → not tagged.  ✓
//   4. R returns to prompt → input handler fires → poll_resize_impl
//      reads resize(800,600) → replays plot 1 at 800x600 → frame
//      with resizeReplay:true.  Server injects resize:true.  ✓
//   5. User creates plot 2 → frame with newPage:true → addPlot.  ✓
// ---------------------------------------------------------------------------

Deno.test("initial resize replay after first plot — must be tagged to avoid duplicate", withTestHarness(async (t, { rClient, browser }) => {
  await rClient.waitForWelcome();

  await t.step("initial resize and plot 1 at default dims", async () => {
    // Browser sends initial resize.
    browser.sendResize(800, 600);
    const msg = await rClient.readMessage<ResizeMessage>();
    assertEquals(msg.type, "resize");

    // R draws plot 1 at DEFAULT dimensions (the resize hasn't been
    // processed yet by R's input handler — user typed fast).
    // newPage:true tells the server this is a new plot.
    await rClient.sendFrame({
      ops: [{ op: "text", str: "plot1" }],
      device: { width: 672, height: 672 },
    }, { newPage: true });
    const frame1 = await browser.waitForType<FrameMessage>("frame");
    assertEquals(frame1.resize, undefined, "Plot 1 is a new plot");
  });

  await t.step("R processes initial resize — replay must be tagged", async () => {
    // R's input handler fires, reads resize(800,600), replays plot 1
    // at 800x600.  R sends resizeReplay:true.
    await rClient.sendFrame({
      ops: [{ op: "text", str: "plot1-at-800" }],
      device: { width: 800, height: 600 },
    }, { resizeReplay: true });
    const replay = await browser.waitForType<FrameMessage>("frame");

    assertEquals(
      replay.resize,
      true,
      "Initial resize replay must be tagged to prevent duplicate",
    );
  });

  await t.step("plot 2 — must be new plot", async () => {
    await rClient.sendFrame({
      ops: [{ op: "text", str: "plot2" }],
      device: { width: 800, height: 600 },
    }, { newPage: true });
    const frame = await browser.waitForType<FrameMessage>("frame");
    assertEquals(frame.resize, undefined, "Plot 2 must be a new plot");
  });
}));
