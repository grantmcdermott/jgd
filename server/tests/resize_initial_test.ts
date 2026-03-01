/**
 * Reproduction test: initial browser resize before R has any plots.
 *
 * When the browser connects and sends a resize (ws.onopen) before R
 * has drawn any plots, the server pushes a pendingResizes entry.
 * R processes the resize but doesn't send a frame (empty display list
 * → GEplayDisplayList is a no-op).  The stale entry persists and
 * incorrectly tags the first real new-plot frame as resize:true.
 *
 * Expected behavior: new-plot frames should never be tagged as resize
 * responses.  The newPage flag in R's frame messages tells the server
 * to silently drain matching entries without tagging.
 */

import { assertEquals } from "@std/assert";
import { TestServer } from "./helpers/server.ts";
import { RClient } from "./helpers/r_client.ts";
import { BrowserClient } from "./helpers/browser_client.ts";
import { delay } from "@std/async";
import type { FrameMessage, ResizeMessage } from "./helpers/types.ts";

Deno.test("initial resize before R frames — stale entry bug", async (t) => {
  const server = new TestServer();
  const rClient = new RClient();
  const browser = new BrowserClient();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await browser.connect(server.wsUrl);
    await rClient.waitForWelcome();

    await t.step("ws.onopen resize should not tag first new-plot frame", async () => {
      // Browser sends initial resize (simulating ws.onopen behavior).
      // At this point R has no active plot — the display list is empty.
      browser.sendResize(800, 600);

      // R receives the resize message.
      const resizeMsg = await rClient.readMessage<ResizeMessage>();
      assertEquals(resizeMsg.type, "resize");

      // R processes the resize: GEplayDisplayList is a no-op (empty DL),
      // so R does NOT send a frame back.  The server's pendingResizes
      // entry for this session is never consumed.

      // R draws plot 1 — a genuinely NEW plot, not a resize response.
      // The newPage flag tells the server to drain the matching entry
      // without tagging.
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot1-new" }],
        device: { width: 800, height: 600 },
      }, { newPage: true });

      const frame1 = await browser.waitForType<FrameMessage>("frame");

      assertEquals(
        frame1.resize,
        undefined,
        "New-plot frame must NOT be tagged as resize response",
      );
    });

    await t.step("second new-plot frame is also clean", async () => {
      // R draws plot 2 — another new plot.
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot2-new" }],
        device: { width: 800, height: 600 },
      }, { newPage: true });

      const frame2 = await browser.waitForType<FrameMessage>("frame");
      assertEquals(
        frame2.resize,
        undefined,
        "Second new-plot frame must NOT be tagged as resize response",
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

/**
 * Reproduction test: two resizes arrive before R's first frame.
 *
 * In practice, ws.onopen sends the first resize and ResizeObserver sends
 * a second one (with different dims due to layout changes) while R is
 * still drawing its first plot.  R stashes the second resize via
 * recv_metrics_response and processes it after the first frame is sent,
 * producing a second frame (replay) that must be tagged resize:true.
 *
 * Without the fix, the server has no pendingResizes entry for the replay
 * frame, so it arrives untagged → browser calls addPlot → duplicate plot.
 */
Deno.test("two resizes before first frame — replay must be tagged", async (t) => {
  const server = new TestServer();
  const rClient = new RClient();
  const browser = new BrowserClient();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await browser.connect(server.wsUrl);
    await rClient.waitForWelcome();

    await t.step("first resize (ws.onopen) before any frame", async () => {
      browser.sendResize(800, 600);
      const msg = await rClient.readMessage<ResizeMessage>();
      assertEquals(msg.type, "resize");
    });

    await t.step("second resize (ResizeObserver, different dims) is deferred", async () => {
      // With the fix, the server defers this resize instead of forwarding
      // it to R.  This prevents recv_metrics_response from stashing it
      // during text-metric waits (which would produce an untagged replay).
      browser.sendResize(900, 700);
      // R does NOT receive the resize yet — it's held by the server.
    });

    await t.step("first frame triggers deferred resize forwarding", async () => {
      // R draws plot 1 at the initial resize dimensions.
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot1-new" }],
        device: { width: 800, height: 600 },
      }, { newPage: true });

      const frame1 = await browser.waitForType<FrameMessage>("frame");
      assertEquals(
        frame1.resize,
        undefined,
        "New-plot frame must not be tagged as resize response",
      );

      // After the first frame, the server forwards the deferred resize to R.
      const deferredMsg = await rClient.readMessage<ResizeMessage>();
      assertEquals(deferredMsg.type, "resize");
      assertEquals(deferredMsg.width, 900);
      assertEquals(deferredMsg.height, 700);
    });

    await t.step("replay frame from deferred resize MUST be tagged resize:true", async () => {
      // R replays the current plot at the deferred resize dimensions.
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot1-resized" }],
        device: { width: 900, height: 700 },
      });

      const frame2 = await browser.waitForType<FrameMessage>("frame");
      assertEquals(
        frame2.resize,
        true,
        "Replay frame from deferred resize must be tagged resize:true",
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

Deno.test("resize after first frame — correctly tags replay", async (t) => {
  const server = new TestServer();
  const rClient = new RClient();
  const browser = new BrowserClient();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await browser.connect(server.wsUrl);
    await rClient.waitForWelcome();

    // R draws plot 1 first (no resize yet).
    await rClient.sendFrame({
      ops: [{ op: "text", str: "plot1" }],
      device: { width: 800, height: 600 },
    }, { newPage: true });
    const frame1 = await browser.waitForType<FrameMessage>("frame");
    assertEquals(frame1.resize, undefined, "First frame should not be tagged");

    await t.step("resize after active plot correctly tags the replay frame", async () => {
      // NOW browser sends resize — R has an active plot and will replay.
      browser.sendResize(640, 480);
      const resizeMsg = await rClient.readMessage<ResizeMessage>();
      assertEquals(resizeMsg.type, "resize");

      // R replays plot 1 at new dimensions (resize response).
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot1-resized" }],
        device: { width: 640, height: 480 },
      });

      const replayFrame = await browser.waitForType<FrameMessage>("frame");
      assertEquals(
        replayFrame.resize,
        true,
        "Replay frame after resize must be tagged resize:true",
      );
    });

    await t.step("subsequent new-plot frame is not tagged", async () => {
      // R draws plot 2 — new plot after the resize was consumed.
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot2-new" }],
        device: { width: 640, height: 480 },
      }, { newPage: true });

      const frame2 = await browser.waitForType<FrameMessage>("frame");
      assertEquals(
        frame2.resize,
        undefined,
        "New-plot frame after consumed resize must not be tagged",
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
