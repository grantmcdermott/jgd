import { assert, assertEquals } from "@std/assert";
import { BrowserClient } from "./helpers/browser_client.ts";
import { withTestHarness } from "./helpers/harness.ts";
import { delay } from "@std/async";
import type { FrameMessage, ResizeMessage } from "./helpers/types.ts";

Deno.test("R→Browser frame relay", withTestHarness(async (t, { server, rClient, browser }) => {
  // Wait for WebSocket registration by sending a resize round-trip
  browser.sendResize(100, 100);
  await rClient.readMessage<ResizeMessage>();

  await t.step("frame reaches browser", async () => {
    await rClient.sendFrame({
      sessionId: "test-session",
      ops: [{ op: "rect", x: 0, y: 0, w: 100, h: 100 }],
      device: { width: 500, height: 400 },
    });

    const msg = await browser.waitForType<FrameMessage>("frame");
    assertEquals(msg.type, "frame");
    assert(msg.plot !== undefined);
  });

  await t.step("plot data (ops, device) is preserved", async () => {
    const ops = [{ op: "line", x1: 0, y1: 0, x2: 100, y2: 100 }];
    const device = { width: 800, height: 600 };
    await rClient.sendFrame({ sessionId: "test-session", ops, device });

    const msg = await browser.waitForType<FrameMessage>("frame");
    assertEquals(msg.plot.ops, ops);
    assertEquals(msg.plot.device, device);
  });

  await t.step("incremental flag is preserved", async () => {
    await rClient.send({
      type: "frame",
      plot: { sessionId: "test-session", ops: [], device: {} },
      incremental: true,
    });

    const msg = await browser.waitForType<FrameMessage>("frame");
    assertEquals(msg.incremental, true);
  });

  await t.step("sessionId is injected when absent", async () => {
    // Send frame without sessionId - server should inject one
    await rClient.sendFrame({
      ops: [{ op: "circle" }],
      device: { width: 100, height: 100 },
    } as FrameMessage["plot"]);

    const msg = await browser.waitForType<FrameMessage>("frame");
    assert(
      msg.plot.sessionId !== undefined && msg.plot.sessionId !== "",
      "Server should inject sessionId",
    );
  });

  await t.step("explicit sessionId is preserved", async () => {
    await rClient.sendFrame({
      sessionId: "my-custom-id",
      ops: [],
      device: {},
    });

    const msg = await browser.waitForType<FrameMessage>("frame");
    assertEquals(msg.plot.sessionId, "my-custom-id");
  });

  await t.step("frame is broadcast to all browsers", async () => {
    const browser2 = new BrowserClient();
    await browser2.connect(server.wsUrl);

    // Wait for browser2 registration
    browser2.sendResize(50, 50);
    await rClient.readMessage<ResizeMessage>();

    await rClient.sendFrame({
      sessionId: "broadcast-test",
      ops: [{ op: "text" }],
      device: {},
    });

    const [msg1, msg2] = await Promise.all([
      browser.waitForType<FrameMessage>("frame"),
      browser2.waitForType<FrameMessage>("frame"),
    ]);

    assertEquals(msg1.plot.sessionId, "broadcast-test");
    assertEquals(msg2.plot.sessionId, "broadcast-test");

    browser2.close();
    await delay(100);
  });
}));
