import { TestServer } from "./server.ts";
import { RClient } from "./r_client.ts";
import { BrowserClient } from "./browser_client.ts";
import { delay } from "@std/async";

export interface TestHarness {
  server: TestServer;
  rClient: RClient;
  browser: BrowserClient;
}

/**
 * Wrap a test body with standard server + R client + browser setup/teardown.
 *
 * Usage:
 *   Deno.test("name", withTestHarness(async (t, { rClient, browser }) => { ... }));
 */
export function withTestHarness(
  fn: (t: Deno.TestContext, h: TestHarness) => Promise<void>,
): (t: Deno.TestContext) => Promise<void> {
  return async (t: Deno.TestContext) => {
    const server = new TestServer();
    const rClient = new RClient();
    const browser = new BrowserClient();

    try {
      await server.start();
      await rClient.connect(server.socketPath);
      await browser.connect(server.wsUrl);

      await fn(t, { server, rClient, browser });
    } finally {
      browser.close();
      rClient.close();
      await delay(100);
      await server.shutdown();
      server.cleanup();
    }
  };
}
