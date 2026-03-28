import { assert, assertEquals } from "@std/assert";
import { withTestHarness } from "./helpers/harness.ts";
import { delay } from "@std/async";
import type {
  MetricsRequestMessage,
  MetricsResponseMessage,
  ResizeMessage,
} from "./helpers/types.ts";

Deno.test("metrics request/response round-trip", withTestHarness(async (t, { rClient, browser }) => {
  // Wait for registration
  browser.sendResize(1, 1);
  await rClient.readMessage<ResizeMessage>();

  await t.step("metrics_request is forwarded to browser", async () => {
    await rClient.sendMetricsRequest(1);

    const msg = await browser.waitForType<MetricsRequestMessage>(
      "metrics_request",
    );
    // Server remaps IDs to avoid cross-session collisions;
    // the browser sees a server-assigned ID, not the original.
    assert(typeof msg.id === "number");

    // Respond with the server-assigned ID
    browser.sendMetricsResponse(msg.id, 10, 5, 2);
    await rClient.readMessage<MetricsResponseMessage>();
  });

  await t.step("metrics_response is routed back to R", async () => {
    await rClient.sendMetricsRequest(2);
    const req = await browser.waitForType<MetricsRequestMessage>(
      "metrics_request",
    );

    browser.sendMetricsResponse(req.id, 42.5, 10.3, 3.2);

    const msg = await rClient.readMessage<MetricsResponseMessage>();
    assertEquals(msg.type, "metrics_response");
    // R receives the original ID restored by the server
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
      await browser.waitForType<MetricsRequestMessage>(
        "metrics_request",
      );

      // Don't respond — wait for fallback
      const msg = await rClient.readMessage<MetricsResponseMessage>(
        5000,
      );
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
    const req = await browser.waitForType<MetricsRequestMessage>(
      "metrics_request",
    );

    // Wait for the timeout fallback
    const fallback = await rClient.readMessage<MetricsResponseMessage>(
      5000,
    );
    assertEquals(fallback.id, 100);
    assertEquals(fallback.width, 0);

    // Now send a late response with the server-assigned ID —
    // should be silently ignored (already timed out)
    browser.sendMetricsResponse(req.id, 50, 10, 3);
    await delay(500);

    // Server should still be functional
    await rClient.sendMetricsRequest(101);
    const req2 = await browser.waitForType<MetricsRequestMessage>(
      "metrics_request",
    );
    browser.sendMetricsResponse(req2.id, 30, 8, 2);

    const msg = await rClient.readMessage<MetricsResponseMessage>();
    assertEquals(msg.id, 101);
    assertEquals(msg.width, 30);
  });

  await t.step(
    "multiple concurrent requests route independently",
    async () => {
      // Send two requests with known original IDs
      await rClient.sendMetricsRequest(200);
      await rClient.sendMetricsRequest(201);

      const req1 = await browser.waitForType<MetricsRequestMessage>(
        "metrics_request",
      );
      const req2 = await browser.waitForType<MetricsRequestMessage>(
        "metrics_request",
      );

      // Respond in reverse order using server-assigned IDs
      browser.sendMetricsResponse(req2.id, 20, 5, 1);
      browser.sendMetricsResponse(req1.id, 40, 10, 3);

      // Read both responses — R sees original IDs restored
      const resp1 = await rClient.readMessage<MetricsResponseMessage>();
      const resp2 = await rClient.readMessage<MetricsResponseMessage>();

      const responses = new Map<number, MetricsResponseMessage>();
      responses.set(resp1.id, resp1);
      responses.set(resp2.id, resp2);

      // Original IDs 200 and 201 should map to correct widths
      assertEquals(responses.get(200)!.width, 40);
      assertEquals(responses.get(201)!.width, 20);
    },
  );
}));
