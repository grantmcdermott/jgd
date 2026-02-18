import { assert } from "@std/assert";
import { TestServer } from "./helpers/server.ts";
import { BrowserClient } from "./helpers/browser_client.ts";
import { delay } from "@std/async";

Deno.test("WebSocket connection lifecycle", async (t) => {
  const server = new TestServer();
  try {
    await server.start();

    await t.step("can connect to /ws", async () => {
      const client = new BrowserClient();
      await client.connect(server.wsUrl);
      client.close();
      await delay(100);
    });

    await t.step("multiple clients can connect simultaneously", async () => {
      const clients = [new BrowserClient(), new BrowserClient(), new BrowserClient()];
      for (const c of clients) {
        await c.connect(server.wsUrl);
      }
      // All connected successfully
      assert(true);
      for (const c of clients) {
        c.close();
      }
      await delay(100);
    });

    await t.step("server continues after client disconnect", async () => {
      const client1 = new BrowserClient();
      await client1.connect(server.wsUrl);
      client1.close();
      await delay(200);

      // Server should still accept new connections
      const client2 = new BrowserClient();
      await client2.connect(server.wsUrl);
      client2.close();
      await delay(100);
    });
  } finally {
    await server.shutdown();
    server.cleanup();
  }
});
