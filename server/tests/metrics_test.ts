import { assert, assertEquals } from "@std/assert";
import { TestServer } from "./helpers/server.ts";
import { RClient } from "./helpers/r_client.ts";
import { BrowserClient } from "./helpers/browser_client.ts";
import { delay } from "@std/async";
import type {
  MetricsRequestMessage,
  MetricsResponseMessage,
  ResizeMessage,
} from "./helpers/types.ts";

Deno.test("metrics request/response round-trip", async (t) => {
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

    await t.step("metrics_request is forwarded to browser", async () => {
      await rClient.sendMetricsRequest(1);

      const msg = await browser.waitForType<MetricsRequestMessage>(
        "metrics_request",
      );
      assertEquals(msg.id, 1);

      // Respond so no fallback timer is left pending
      browser.sendMetricsResponse(1, 10, 5, 2);
      await rClient.readMessage<MetricsResponseMessage>();
    });

    await t.step("metrics_response is routed back to R", async () => {
      await rClient.sendMetricsRequest(2);
      await browser.waitForType<MetricsRequestMessage>("metrics_request");

      browser.sendMetricsResponse(2, 42.5, 10.3, 3.2);

      const msg = await rClient.readMessage<MetricsResponseMessage>();
      assertEquals(msg.type, "metrics_response");
      assertEquals(msg.id, 2);
      assertEquals(msg.width, 42.5);
      assertEquals(msg.ascent, 10.3);
      assertEquals(msg.descent, 3.2);
    });

    await t.step(
      "timeout: zero-value fallback after 2s without response",
      async () => {
        const startTime = Date.now();
        await rClient.sendMetricsRequest(99);
        await browser.waitForType<MetricsRequestMessage>("metrics_request");

        // Don't respond — wait for fallback
        const msg = await rClient.readMessage<MetricsResponseMessage>(5000);
        const elapsed = Date.now() - startTime;

        assertEquals(msg.type, "metrics_response");
        assertEquals(msg.id, 99);
        assertEquals(msg.width, 0);
        assertEquals(msg.ascent, 0);
        assertEquals(msg.descent, 0);

        assert(
          elapsed >= 1500,
          `Fallback arrived too early: ${elapsed}ms (expected >= 1500ms)`,
        );
      },
    );

    await t.step("late response after timeout is ignored (no crash)", async () => {
      await rClient.sendMetricsRequest(100);
      await browser.waitForType<MetricsRequestMessage>("metrics_request");

      // Wait for the timeout fallback
      const fallback = await rClient.readMessage<MetricsResponseMessage>(5000);
      assertEquals(fallback.id, 100);
      assertEquals(fallback.width, 0);

      // Now send a late response — should be silently ignored
      browser.sendMetricsResponse(100, 50, 10, 3);
      await delay(500);

      // Server should still be functional
      await rClient.sendMetricsRequest(101);
      await browser.waitForType<MetricsRequestMessage>("metrics_request");
      browser.sendMetricsResponse(101, 30, 8, 2);

      const msg = await rClient.readMessage<MetricsResponseMessage>();
      assertEquals(msg.id, 101);
      assertEquals(msg.width, 30);
    });

    await t.step(
      "multiple concurrent requests route independently",
      async () => {
        // Send two requests
        await rClient.sendMetricsRequest(200);
        await rClient.sendMetricsRequest(201);

        const req1 = await browser.waitForType<MetricsRequestMessage>(
          "metrics_request",
        );
        const req2 = await browser.waitForType<MetricsRequestMessage>(
          "metrics_request",
        );

        // Respond in reverse order
        const ids = [req1.id, req2.id];
        browser.sendMetricsResponse(ids[1], 20, 5, 1);
        browser.sendMetricsResponse(ids[0], 40, 10, 3);

        // Read both responses (order may vary)
        const resp1 = await rClient.readMessage<MetricsResponseMessage>();
        const resp2 = await rClient.readMessage<MetricsResponseMessage>();

        const responses = new Map<number, MetricsResponseMessage>();
        responses.set(resp1.id, resp1);
        responses.set(resp2.id, resp2);

        assertEquals(responses.get(ids[0])!.width, 40);
        assertEquals(responses.get(ids[1])!.width, 20);
      },
    );
  } finally {
    browser.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});
