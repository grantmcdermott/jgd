import { assert, assertEquals } from "@std/assert";
import { TestServer } from "./helpers/server.ts";
import { RClient } from "./helpers/r_client.ts";
import { BrowserClient } from "./helpers/browser_client.ts";
import { delay } from "@std/async";
import type { FrameMessage, ResizeMessage } from "./helpers/types.ts";

Deno.test("TCP mode", async (t) => {
  const server = new TestServer({ tcp: true });
  const rClient = new RClient();
  const browser = new BrowserClient();

  try {
    await server.start();

    await t.step("server reports tcp:PORT socket path", () => {
      assert(
        server.socketPath.startsWith("tcp:"),
        `Expected tcp:PORT, got ${server.socketPath}`,
      );
      const port = parseInt(server.socketPath.slice(4), 10);
      assert(port > 0, `Expected valid port, got ${port}`);
    });

    await t.step("discovery file contains tcp:PORT", async () => {
      const disc = await server.readDiscovery();
      assertEquals(disc.socketPath, server.socketPath);
      assert(disc.socketPath.startsWith("tcp:"));
    });

    await t.step("R client connects via TCP", async () => {
      await rClient.connect(server.socketPath);
    });

    await t.step("frame relay works over TCP", async () => {
      await browser.connect(server.wsUrl);

      // Wait for browser registration
      browser.sendResize(200, 200);
      await rClient.readMessage<ResizeMessage>();

      await rClient.sendFrame({
        sessionId: "tcp-test",
        ops: [{ op: "rect", x: 0, y: 0, w: 100, h: 100 }],
        device: { width: 200, height: 200 },
      });

      const msg = await browser.waitForType<FrameMessage>("frame");
      assertEquals(msg.type, "frame");
      assertEquals(msg.plot.sessionId, "tcp-test");
      assertEquals(msg.plot.ops.length, 1);
    });
  } finally {
    browser.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});
