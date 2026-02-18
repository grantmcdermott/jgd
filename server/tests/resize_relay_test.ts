import { assertEquals } from "@std/assert";
import { TestServer } from "./helpers/server.ts";
import { RClient } from "./helpers/r_client.ts";
import { BrowserClient } from "./helpers/browser_client.ts";
import { delay } from "@std/async";
import type { FrameMessage, ResizeMessage } from "./helpers/types.ts";

Deno.test("Browser→R resize relay", async (t) => {
  const server = new TestServer();
  const rClient = new RClient();
  const browser = new BrowserClient();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await browser.connect(server.wsUrl);

    // Wait for WebSocket registration
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
  } finally {
    browser.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});
