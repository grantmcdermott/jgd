import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { TestServer } from "./helpers/server.ts";
import { RClient } from "./helpers/r_client.ts";
import { BrowserClient } from "./helpers/browser_client.ts";
import { delay } from "@std/async";
import type {
  FrameMessage,
  MetricsRequestMessage,
  MetricsResponseMessage,
  ResizeMessage,
} from "./helpers/types.ts";

Deno.test("multi-session routing", async (t) => {
  const server = new TestServer();
  const r1 = new RClient();
  const r2 = new RClient();
  let r1b: RClient | undefined;
  const browser = new BrowserClient();

  try {
    await server.start();
    await r1.connect(server.socketPath);
    await r2.connect(server.socketPath);
    await browser.connect(server.wsUrl);

    // Wait for registration
    browser.sendResize(1, 1);
    await r1.readMessage<ResizeMessage>();
    await r2.readMessage<ResizeMessage>();

    await t.step("two R sessions can connect simultaneously", () => {
      // If we got here, both are connected
      assert(true);
    });

    await t.step(
      "frames from different sessions have different sessionIds",
      async () => {
        // Send frames without explicit sessionId so server injects them
        await r1.sendFrame({
          ops: [{ op: "rect" }],
          device: { width: 100, height: 100 },
        } as FrameMessage["plot"]);

        const msg1 = await browser.waitForType<FrameMessage>("frame");
        const sid1 = msg1.plot.sessionId;

        await r2.sendFrame({
          ops: [{ op: "circle" }],
          device: { width: 200, height: 200 },
        } as FrameMessage["plot"]);

        const msg2 = await browser.waitForType<FrameMessage>("frame");
        const sid2 = msg2.plot.sessionId;

        assertNotEquals(sid1, sid2, "Session IDs should differ between R sessions");
      },
    );

    await t.step(
      "disconnecting one session does not affect the other",
      async () => {
        r1.close();
        await delay(200);

        // r2 should still work
        await r2.sendFrame({
          sessionId: "r2-alive",
          ops: [{ op: "line" }],
          device: {},
        });

        const msg = await browser.waitForType<FrameMessage>("frame");
        assertEquals(msg.plot.sessionId, "r2-alive");
      },
    );

    await t.step(
      "metrics with same original ID from two sessions are routed correctly",
      async () => {
        // Reconnect r1 for this test
        r1b = new RClient();
        await r1b.connect(server.socketPath);

        // TODO: replace delay with a server-side registration acknowledgement
        // Wait for r1b to be registered by the server
        await delay(100);

        browser.sendResize(2, 2);
        await r1b.readMessage<ResizeMessage>();
        await r2.readMessage<ResizeMessage>();

        // Both sessions send metrics_request with the SAME original id.
        // This exercises the ID collision bug: without remapping, the
        // second set() would overwrite the first routing entry.
        await r1b.sendMetricsRequest(1);
        await r2.sendMetricsRequest(1);

        const req1 = await browser.waitForType<MetricsRequestMessage>(
          "metrics_request",
        );
        const req2 = await browser.waitForType<MetricsRequestMessage>(
          "metrics_request",
        );

        // Server must assign distinct forwarded IDs
        assertNotEquals(req1.id, req2.id);

        // Respond to both (in reverse order for extra coverage)
        browser.sendMetricsResponse(req2.id, 20, 5, 1);
        browser.sendMetricsResponse(req1.id, 40, 10, 3);

        // Each session should receive its response with original id=1
        const resp1 = await r1b.readMessage<MetricsResponseMessage>();
        const resp2 = await r2.readMessage<MetricsResponseMessage>();

        assertEquals(resp1.id, 1);
        assertEquals(resp1.width, 40);
        assertEquals(resp2.id, 1);
        assertEquals(resp2.width, 20);

        r1b.close();
        await delay(100);
      },
    );
  } finally {
    browser.close();
    r1.close();
    r2.close();
    r1b?.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});
