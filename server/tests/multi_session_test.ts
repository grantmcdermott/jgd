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
      "metrics response routes to correct session",
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

        // Send metrics from r2
        await r2.sendMetricsRequest(300);
        const req = await browser.waitForType<MetricsRequestMessage>(
          "metrics_request",
        );
        assertEquals(req.id, 300);

        browser.sendMetricsResponse(300, 55, 12, 4);

        // r2 should receive the response
        const resp = await r2.readMessage<MetricsResponseMessage>();
        assertEquals(resp.id, 300);
        assertEquals(resp.width, 55);

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
