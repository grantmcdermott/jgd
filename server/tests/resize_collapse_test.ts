/**
 * Reproduction test for the resize collapse bug (trigd-1uj.6).
 *
 * Root cause: broadcastResizeToR's collapse logic removes ALL normal
 * (non-plotIndex) pendingResizes entries when a new resize arrives.
 * But R has already received the previous resize(s) and WILL send a
 * replay frame for each.  When the entry for an in-flight resize is
 * removed, the corresponding replay frame arrives without a
 * pendingResizes entry → untagged → browser calls addPlot → duplicate
 * plot in history.
 *
 * Two scenarios are tested:
 *
 * 1. Deferred resize + post-frame resize: the deferred resize entry
 *    is pushed when the first frame triggers forwarding.  A subsequent
 *    resize from the browser (e.g. ResizeObserver after render)
 *    collapses the deferred entry.  R's replay for the deferred resize
 *    steals the new entry, leaving the second replay untagged.
 *
 * 2. Rapid resizes after first frame: two resizes with different
 *    dimensions arrive in quick succession.  The second collapses the
 *    first's entry.  R's first replay steals the second's entry,
 *    leaving the second replay untagged.
 *
 * Both tests currently FAIL because the collapse logic does not
 * account for in-flight resize responses.
 */

import { assertEquals } from "@std/assert";
import { TestServer } from "./helpers/server.ts";
import { RClient } from "./helpers/r_client.ts";
import { BrowserClient } from "./helpers/browser_client.ts";
import { delay } from "@std/async";
import type { FrameMessage, ResizeMessage } from "./helpers/types.ts";

Deno.test("deferred resize entry survives collapse from later resize", async (t) => {
  const server = new TestServer();
  const rClient = new RClient();
  const browser = new BrowserClient();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await browser.connect(server.wsUrl);
    await rClient.waitForWelcome();

    await t.step("two resizes before first frame", async () => {
      // ws.onopen resize — forwarded to R, no pendingResizes entry.
      browser.sendResize(800, 600);
      const msg = await rClient.readMessage<ResizeMessage>();
      assertEquals(msg.type, "resize");

      // ResizeObserver resize — deferred by the server.
      browser.sendResize(900, 700);
    });

    await t.step("first frame triggers deferred forwarding", async () => {
      // R draws plot 1 at the initial resize dimensions.
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot1" }],
        device: { width: 800, height: 600 },
      });

      const frame = await browser.waitForType<FrameMessage>("frame");
      assertEquals(frame.resize, undefined, "Plot 1 must not be tagged");
    });

    await t.step("post-render resize collapses deferred entry", async () => {
      // After the browser renders plot 1, ResizeObserver fires with
      // slightly different dimensions (e.g. scrollbar appeared).  The
      // server's collapse logic removes the deferred resize's
      // pendingResizes entry and pushes a new one for this resize.
      browser.sendResize(901, 701);

      // R reads both pending resize messages in order.
      const deferred = await rClient.readMessage<ResizeMessage>();
      assertEquals(deferred.width, 900, "First should be the deferred resize");

      const postRender = await rClient.readMessage<ResizeMessage>();
      assertEquals(postRender.width, 901, "Second should be the post-render resize");
    });

    await t.step("both replay frames must be tagged resize:true", async () => {
      // R replays plot 1 at deferred resize dimensions.
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot1-at-900" }],
        device: { width: 900, height: 700 },
      });
      const replay1 = await browser.waitForType<FrameMessage>("frame");
      assertEquals(replay1.resize, true, "Deferred replay must be tagged");

      // R replays plot 1 at post-render resize dimensions.
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot1-at-901" }],
        device: { width: 901, height: 701 },
      });
      const replay2 = await browser.waitForType<FrameMessage>("frame");

      // BUG: The collapse logic removed the deferred resize's entry,
      // so the first replay consumed the post-render resize's entry.
      // This second replay has no entry → untagged → browser treats
      // it as a new plot → duplicate.
      assertEquals(
        replay2.resize,
        true,
        "Post-render replay must be tagged — collapse ate the deferred entry",
      );
    });

    await t.step("subsequent new-plot frame must not be tagged", async () => {
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot2" }],
        device: { width: 901, height: 701 },
      });
      const frame = await browser.waitForType<FrameMessage>("frame");
      assertEquals(frame.resize, undefined, "New plot must not be tagged");
    });
  } finally {
    browser.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});

Deno.test("rapid resizes after first frame — all replays tagged", async (t) => {
  const server = new TestServer();
  const rClient = new RClient();
  const browser = new BrowserClient();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await browser.connect(server.wsUrl);
    await rClient.waitForWelcome();

    // Prime with an initial frame so hasReceivedFrame=true.
    await rClient.sendFrame({
      ops: [{ op: "text", str: "init" }],
      device: { width: 1, height: 1 },
    });
    await browser.waitForType<FrameMessage>("frame");

    // Prime dedup state with a baseline resize.
    browser.sendResize(1, 1);
    await rClient.readMessage<ResizeMessage>();

    await t.step("two rapid resizes with different dims", async () => {
      // First resize — pushed as a pendingResizes entry.
      browser.sendResize(800, 600);

      // Second resize — collapse removes first's entry, pushes new.
      // Both are forwarded to R.
      browser.sendResize(900, 700);

      const msg1 = await rClient.readMessage<ResizeMessage>();
      assertEquals(msg1.width, 800);

      const msg2 = await rClient.readMessage<ResizeMessage>();
      assertEquals(msg2.width, 900);
    });

    await t.step("both replay frames must be tagged resize:true", async () => {
      // R replays for first resize.
      await rClient.sendFrame({
        ops: [{ op: "rect" }],
        device: { width: 800, height: 600 },
      });
      const replay1 = await browser.waitForType<FrameMessage>("frame");
      assertEquals(replay1.resize, true, "First replay must be tagged");

      // R replays for second resize.
      await rClient.sendFrame({
        ops: [{ op: "rect" }],
        device: { width: 900, height: 700 },
      });
      const replay2 = await browser.waitForType<FrameMessage>("frame");

      // BUG: The collapse removed the first resize's entry.  R's
      // first replay consumed the second's entry.  The second replay
      // has no entry → untagged → addPlot → duplicate plot.
      assertEquals(
        replay2.resize,
        true,
        "Second replay must be tagged — collapse ate the first entry",
      );
    });

    await t.step("new-plot frame after resizes is not tagged", async () => {
      await rClient.sendFrame({
        ops: [{ op: "circle" }],
        device: { width: 900, height: 700 },
      });
      const frame = await browser.waitForType<FrameMessage>("frame");
      assertEquals(frame.resize, undefined);
    });
  } finally {
    browser.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});
