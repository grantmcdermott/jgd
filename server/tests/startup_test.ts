import { assert, assertEquals } from "@std/assert";
import { TestServer } from "./helpers/server.ts";

Deno.test("server startup", async (t) => {
  const server = new TestServer();
  try {
    await server.start();

    await t.step("server reports a valid HTTP port", () => {
      assert(server.httpPort > 0, `HTTP port should be > 0, got ${server.httpPort}`);
    });

    await t.step("server has a valid PID", () => {
      assert(server.pid > 0, `PID should be > 0, got ${server.pid}`);
    });

    await t.step("discovery file has correct schema", async () => {
      const disc = await server.readDiscovery();
      assertEquals(typeof disc.socketPath, "string");
      assert(disc.socketPath.length > 0, "socketPath should be non-empty");
      assertEquals(typeof disc.httpPort, "number");
      assert(disc.httpPort > 0, "httpPort should be > 0");
      assertEquals(typeof disc.pid, "number");
      assert(disc.pid > 0, "pid should be > 0");
    });

    await t.step("discovery file pid matches server process", async () => {
      const disc = await server.readDiscovery();
      assertEquals(disc.pid, server.pid);
    });

    await t.step("discovery file httpPort matches server", async () => {
      const disc = await server.readDiscovery();
      assertEquals(disc.httpPort, server.httpPort);
    });

    await t.step("discovery file socketPath matches server", async () => {
      const disc = await server.readDiscovery();
      assertEquals(disc.socketPath, server.socketPath);
    });
  } finally {
    await server.shutdown();
    server.cleanup();
  }
});
