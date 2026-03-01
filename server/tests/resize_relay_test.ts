import { assertEquals } from "@std/assert";
import { RClient } from "./helpers/r_client.ts";
import { withTestHarness } from "./helpers/harness.ts";
import { delay } from "@std/async";
import type { FrameMessage, ResizeMessage } from "./helpers/types.ts";

Deno.test("Browser→R resize relay", withTestHarness(async (t, { server, rClient, browser }) => {
  // Send an initial frame so the session is marked as having received
  // a frame (hasReceivedFrame=true).  Without this, resize messages
  // won't push pendingResizes entries (stale-entry fix).
  await rClient.sendFrame(
    { ops: [{ op: "text", str: "init" }], device: { width: 1, height: 1 } },
  );
  await browser.waitForType<FrameMessage>("frame");

  // Prime dedup state with an initial resize
  browser.sendResize(1, 1);
  await rClient.readMessage<ResizeMessage>();

  await t.step("resize reaches R session", async () => {
    browser.sendResize(800, 600);

    const msg = await rClient.readMessage<ResizeMessage>();
    assertEquals(msg.type, "resize");
    assertEquals(msg.width, 800);
    assertEquals(msg.height, 600);
  });

  await t.step("width and height are preserved", async () => {
    browser.sendResize(1920, 1080);

    const msg = await rClient.readMessage<ResizeMessage>();
    assertEquals(msg.width, 1920);
    assertEquals(msg.height, 1080);
  });

  await t.step("frame after resize has resize flag", async () => {
    browser.sendResize(1024, 768);

    // R receives the resize
    await rClient.readMessage<ResizeMessage>();

    // R responds with a frame (simulating device redraw)
    await rClient.sendFrame(
      { ops: [{ op: "rect" }], device: { width: 1024, height: 768 } },
    );

    const frame = await browser.waitForType<FrameMessage>("frame");
    assertEquals(frame.resize, true);
  });

  await t.step("frame without preceding resize has no resize flag", async () => {
    // R sends a regular frame (not triggered by resize)
    await rClient.sendFrame(
      { ops: [{ op: "circle" }], device: { width: 1024, height: 768 } },
    );

    const frame = await browser.waitForType<FrameMessage>("frame");
    assertEquals(frame.resize, undefined);
  });

  await t.step("resize is broadcast to all R sessions", async () => {
    const rClient2 = new RClient();
    await rClient2.connect(server.socketPath);

    // TODO: replace delay with a server-side registration acknowledgement
    // Wait for rClient2 to be registered (send and receive a frame)
    await delay(100);

    browser.sendResize(640, 480);

    const [msg1, msg2] = await Promise.all([
      rClient.readMessage<ResizeMessage>(),
      rClient2.readMessage<ResizeMessage>(),
    ]);

    assertEquals(msg1.type, "resize");
    assertEquals(msg1.width, 640);
    assertEquals(msg2.type, "resize");
    assertEquals(msg2.width, 640);

    rClient2.close();
    await delay(100);
  });
}));
