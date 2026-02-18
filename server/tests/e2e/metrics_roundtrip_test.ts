import { assertEquals } from "@std/assert";
import { TestServer } from "../helpers/server.ts";
import { RClient } from "../helpers/r_client.ts";
import { E2EBrowser, readOfType } from "../helpers/e2e_browser.ts";
import { delay } from "@std/async";
import type { MetricsResponseMessage, ResizeMessage } from "../helpers/types.ts";

Deno.test("E2E: metrics round-trip with real browser measurement", async (t) => {
  const server = new TestServer();
  const rClient = new RClient();
  const e2e = new E2EBrowser();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await e2e.launch();

    const page = await e2e.newPage(server.httpBaseUrl);
    // Wait for the WebSocket to register
    await rClient.readMessage<ResizeMessage>();
    // Let any ResizeObserver messages arrive so they get buffered
    await delay(500);

    await t.step("strWidth request returns positive width", async () => {
      await rClient.sendMetricsRequest(1, "strWidth");
      const resp = await readOfType<MetricsResponseMessage>(rClient, "metrics_response");

      assertEquals(resp.id, 1);
      assertEquals(resp.width > 0, true, `strWidth should be positive, got ${resp.width}`);
      assertEquals(resp.ascent, 0);
      assertEquals(resp.descent, 0);
    });

    await t.step("metricInfo request returns positive dimensions", async () => {
      await rClient.sendMetricsRequest(2, "metricInfo");
      const resp = await readOfType<MetricsResponseMessage>(rClient, "metrics_response");

      assertEquals(resp.id, 2);
      assertEquals(resp.width > 0, true, `width should be positive, got ${resp.width}`);
      assertEquals(resp.ascent > 0, true, `ascent should be positive, got ${resp.ascent}`);
      assertEquals(resp.descent >= 0, true, `descent should be non-negative, got ${resp.descent}`);
    });

    await t.step("concurrent requests are routed independently", async () => {
      await rClient.sendMetricsRequest(10, "strWidth");
      await rClient.sendMetricsRequest(11, "metricInfo");

      const r1 = await readOfType<MetricsResponseMessage>(rClient, "metrics_response");
      const r2 = await readOfType<MetricsResponseMessage>(rClient, "metrics_response");
      const byId = new Map([[r1.id, r1], [r2.id, r2]]);

      assertEquals(byId.get(10)!.width > 0, true);
      assertEquals(byId.get(11)!.width > 0, true);
      assertEquals(byId.get(11)!.ascent > 0, true);
    });

    await t.step("real browser measures different widths for different strings", async () => {
      // "i" is narrow, "WWWW" is wide
      await rClient.send({
        type: "metrics_request",
        id: 20,
        kind: "strWidth",
        str: "i",
        gc: { font: { family: "sans", face: 1, size: 12 } },
      });
      const narrow = await readOfType<MetricsResponseMessage>(rClient, "metrics_response");

      await rClient.send({
        type: "metrics_request",
        id: 21,
        kind: "strWidth",
        str: "WWWW",
        gc: { font: { family: "sans", face: 1, size: 12 } },
      });
      const wide = await readOfType<MetricsResponseMessage>(rClient, "metrics_response");

      assertEquals(narrow.id, 20);
      assertEquals(wide.id, 21);
      assertEquals(
        wide.width > narrow.width,
        true,
        `"WWWW" (${wide.width}) should be wider than "i" (${narrow.width})`,
      );
    });

  } finally {
    await e2e.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});
