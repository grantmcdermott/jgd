import { assert, assertEquals } from "@std/assert";
import { TestServer } from "./helpers/server.ts";
import { RClient } from "./helpers/r_client.ts";
import { delay } from "@std/async";
import type { ServerInfoMessage } from "./helpers/types.ts";

Deno.test("server_info welcome message", async (t) => {
  const server = new TestServer();
  const rClient = new RClient();

  try {
    await server.start();
    await rClient.connect(server.socketPath);

    // The welcome is deferred until the server reads the first message
    // from R, so trigger it by sending a dummy message.
    await rClient.waitForWelcome();

    await t.step("welcome is received after first message", () => {
      assert(rClient.serverInfo !== null, "serverInfo should be set");
      assertEquals(rClient.serverInfo!.type, "server_info");
    });

    await t.step("serverName is jgd-http-server", () => {
      assertEquals(rClient.serverInfo!.serverName, "jgd-http-server");
    });

    await t.step("protocolVersion is 1", () => {
      assertEquals(rClient.serverInfo!.protocolVersion, 1);
    });

    await t.step("serverInfo.httpUrl contains correct port", () => {
      assert(rClient.serverInfo!.serverInfo !== undefined, "serverInfo should be present");
      assertEquals(
        rClient.serverInfo!.serverInfo!.httpUrl,
        `http://127.0.0.1:${server.httpPort}/`,
      );
    });

    await t.step("second R client also gets welcome", async () => {
      const rClient2 = new RClient();
      try {
        await rClient2.connect(server.socketPath);
        await rClient2.waitForWelcome();
        assert(rClient2.serverInfo !== null, "second client should get serverInfo");
        assertEquals(rClient2.serverInfo!.type, "server_info");
        assertEquals(rClient2.serverInfo!.serverName, "jgd-http-server");
        assertEquals(rClient2.serverInfo!.protocolVersion, 1);
      } finally {
        rClient2.close();
        await delay(100);
      }
    });
  } finally {
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});
