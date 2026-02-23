/**
 * Default transport integration test (Unix socket on POSIX, named pipe on Windows).
 *
 * Complements tcp_mode_test.ts which forces TCP via { tcp: true }.
 * Same structure as tcp_mode_test.ts.
 */

import { assert, assertEquals } from "@std/assert";
import { TestServer } from "./helpers/server.ts";
import { RClient } from "./helpers/r_client.ts";
import { BrowserClient } from "./helpers/browser_client.ts";
import { delay } from "@std/async";
import type { FrameMessage, ResizeMessage } from "./helpers/types.ts";

const isWindows = Deno.build.os === "windows";

Deno.test("Default transport mode", async (t) => {
  // No { tcp: true } — server picks Unix socket or named pipe per platform.
  const server = new TestServer();
  const rClient = new RClient();
  const browser = new BrowserClient();

  try {
    await server.start();

    await t.step("server reports platform-appropriate socket path", () => {
      if (isWindows) {
        assert(
          server.socketPath.startsWith("npipe:///"),
          `Expected npipe:///..., got ${server.socketPath}`,
        );
      } else {
        assert(
          server.socketPath.startsWith("unix:///"),
          `Expected unix:///..., got ${server.socketPath}`,
        );
      }
    });

    await t.step("discovery file contains correct socket path", async () => {
      const disc = await server.readDiscovery();
      assertEquals(disc.socketPath, server.socketPath);
    });

    await t.step("R client connects via default transport", async () => {
      await rClient.connect(server.socketPath);
    });

    await t.step("frame relay works over default transport", async () => {
      await browser.connect(server.wsUrl);

      browser.sendResize(200, 200);
      await rClient.readMessage<ResizeMessage>();

      await rClient.sendFrame({
        sessionId: "default-transport-test",
        ops: [{ op: "rect", x: 0, y: 0, w: 100, h: 100 }],
        device: { width: 200, height: 200 },
      });

      const msg = await browser.waitForType<FrameMessage>("frame");
      assertEquals(msg.type, "frame");
      assertEquals(msg.plot.sessionId, "default-transport-test");
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
