import { assertEquals } from "@std/assert";
import { TestServer } from "./helpers/server.ts";
import { RClient } from "./helpers/r_client.ts";
import { BrowserClient } from "./helpers/browser_client.ts";
import { delay } from "@std/async";
import type { CloseMessage, ResizeMessage } from "./helpers/types.ts";

Deno.test("close message relay", async (t) => {
  const server = new TestServer();
  const rClient = new RClient();
  const browser = new BrowserClient();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await browser.connect(server.wsUrl);

    // Wait for registration
    browser.sendResize(1, 1);
    await rClient.readMessage<ResizeMessage>();

    await t.step("R close message reaches browser", async () => {
      await rClient.sendClose();

      const msg = await browser.waitForType<CloseMessage>("close");
      assertEquals(msg.type, "close");
    });
  } finally {
    browser.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});
