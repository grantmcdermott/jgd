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
 * responses.  The server should only push a pendingResizes entry when
 * the R session has an active plot (i.e., has previously sent at least
 * one frame).
 *
 * This test fails with the current code (stale entry bug) and should
 * pass after the fix.
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
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot1-new" }],
        device: { width: 800, height: 600 },
      });

      const frame1 = await browser.waitForType<FrameMessage>("frame");

      // BUG: The stale pendingResizes entry tags this new-plot frame
      // as resize:true.  From the browser's perspective this triggers
      // replaceLatest instead of addPlot.  On an empty history the
      // fallback to addPlot masks the issue, but the semantics are
      // wrong and downstream timing races cause duplicate plots.
      assertEquals(
        frame1.resize,
        undefined,
        "New-plot frame must NOT be tagged as resize response (stale entry bug)",
      );
    });

    await t.step("second new-plot frame is also clean", async () => {
      // R draws plot 2 — another new plot.
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot2-new" }],
        device: { width: 800, height: 600 },
      });

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

    await t.step("second resize (ResizeObserver, different dims) before any frame", async () => {
      browser.sendResize(900, 700);
      const msg = await rClient.readMessage<ResizeMessage>();
      assertEquals(msg.type, "resize");
      assertEquals(msg.width, 900);
    });

    await t.step("first frame (new plot) must NOT be tagged", async () => {
      // R draws plot 1 — new plot, not a resize response.
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot1-new" }],
        device: { width: 900, height: 700 },
      });

      const frame1 = await browser.waitForType<FrameMessage>("frame");
      assertEquals(
        frame1.resize,
        undefined,
        "New-plot frame must not be tagged as resize response",
      );
    });

    await t.step("second frame (stashed resize replay) MUST be tagged resize:true", async () => {
      // R processes the stashed resize (from recv_metrics_response) and
      // replays the current plot at the new dimensions.
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot1-resized" }],
        device: { width: 900, height: 700 },
      });

      const frame2 = await browser.waitForType<FrameMessage>("frame");
      assertEquals(
        frame2.resize,
        true,
        "Replay frame from stashed resize must be tagged resize:true (otherwise browser creates duplicate plot)",
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
    });
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
      });

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
