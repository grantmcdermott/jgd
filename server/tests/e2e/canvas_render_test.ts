import { assertEquals, assertNotEquals } from "@std/assert";
import { TestServer } from "../helpers/server.ts";
import { RClient } from "../helpers/r_client.ts";
import { E2EBrowser, canvasHasContent, plotInfoText } from "../helpers/e2e_browser.ts";
import { delay } from "@std/async";
import type { ResizeMessage } from "../helpers/types.ts";

Deno.test("E2E: canvas renders a plot from R", async (t) => {
  const server = new TestServer();
  const rClient = new RClient();
  const e2e = new E2EBrowser();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await e2e.launch();

    const page = await e2e.newPage(server.httpBaseUrl);
    // Wait for the page to load and WebSocket to connect.
    // The browser sends an initial resize on connect; wait for R to receive it.
    await rClient.readMessage<ResizeMessage>();

    await t.step("canvas exists and is initially empty", async () => {
      const hasCanvas = await page.evaluate(`(function() {
        return !!document.querySelector('#plot-canvas');
      })()`) as boolean;
      assertEquals(hasCanvas, true);

      // No plot yet — canvas should be empty
      const hasContent = await canvasHasContent(page);
      assertEquals(hasContent, false);

      const info = await plotInfoText(page);
      assertEquals(info, "No plots");
    });

    await t.step("R frame renders visible pixels on canvas", async () => {
      // Send a frame with a filled red rectangle
      await rClient.sendFrame({
        ops: [{
          op: "rect",
          x0: 10, y0: 10, x1: 200, y1: 150,
          gc: { fill: "#ff0000", col: "#000000", lwd: 2 },
        }],
        device: { width: 400, height: 300, bg: "#ffffff" },
      }, { newPage: true });

      // Wait for render (requestAnimationFrame + WebSocket round trip)
      await delay(500);

      const hasContent = await canvasHasContent(page);
      assertEquals(hasContent, true);
    });

    await t.step("toolbar shows 1 / 1 after first plot", async () => {
      const info = await plotInfoText(page);
      assertEquals(info, "1 / 1");
    });

    await t.step("second plot advances toolbar to 2 / 2", async () => {
      await rClient.sendFrame({
        ops: [{
          op: "circle",
          x: 100, y: 100, r: 50,
          gc: { fill: "#0000ff", col: "#000000", lwd: 1 },
        }],
        device: { width: 400, height: 300, bg: "#ffffff" },
      }, { newPage: true });

      await delay(500);

      const info = await plotInfoText(page);
      assertEquals(info, "2 / 2");
    });

    await t.step("previous button navigates back", async () => {
      await page.evaluate(`document.getElementById('btn-prev').click()`);
      await delay(200);

      const info = await plotInfoText(page);
      assertEquals(info, "1 / 2");

      // Canvas still has content (the first plot)
      const hasContent = await canvasHasContent(page);
      assertEquals(hasContent, true);
    });

  } finally {
    await e2e.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});
