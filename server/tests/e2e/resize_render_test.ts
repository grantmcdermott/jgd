import { assertEquals } from "@std/assert";
import { TestServer } from "../helpers/server.ts";
import { RClient } from "../helpers/r_client.ts";
import { BrowserClient } from "../helpers/browser_client.ts";
import { E2EBrowser, canvasHasContent, canvasDimensions, readOfType } from "../helpers/e2e_browser.ts";
import { delay } from "@std/async";
import type { ResizeMessage } from "../helpers/types.ts";

Deno.test("E2E: resize triggers canvas re-render", async (t) => {
  const server = new TestServer();
  const rClient = new RClient();
  const e2e = new E2EBrowser();
  // Extra WS client to send resize messages (CDP setViewportSize doesn't
  // trigger ResizeObserver in headless Chrome).
  const resizeSender = new BrowserClient();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await e2e.launch();

    const page = await e2e.newPage(server.httpBaseUrl);
    await resizeSender.connect(server.wsUrl);

    // The real browser sends resize on connect. Read it so R session is registered.
    await rClient.readMessage<ResizeMessage>();

    // Send two frames to establish a plot history baseline
    await rClient.sendFrame({
      ops: [{ op: "rect", x0: 0, y0: 0, x1: 400, y1: 300, gc: { fill: "#3366cc" } }],
      device: { width: 400, height: 300, bg: "#ffffff" },
    }, { newPage: true });
    await delay(300);
    await rClient.sendFrame({
      ops: [{ op: "circle", x: 200, y: 150, r: 50, gc: { fill: "#33cc66" } }],
      device: { width: 400, height: 300, bg: "#ffffff" },
    }, { newPage: true });
    await delay(500);

    const dimsBefore = await canvasDimensions(page);
    const countBefore = await page.evaluate(
      `document.getElementById('plot-info').textContent`,
    ) as string;
    assertEquals(countBefore, "2 / 2");

    await t.step("resize message reaches R", async () => {
      // Send resize with unique dimensions so we can identify it
      resizeSender.sendResize(1234, 5678);

      const msg = await readOfType<ResizeMessage>(
        rClient, "resize", (m) => m.width === 1234,
      );
      assertEquals(msg.width, 1234);
      assertEquals(msg.height, 5678);
    });

    await t.step("R frame after resize re-renders with new dimensions", async () => {
      // Change viewport so the canvas has room for the larger plot
      await page.setViewportSize({ width: 1024, height: 768 });

      // R responds with a frame at the new size
      await rClient.sendFrame({
        ops: [{ op: "rect", x0: 0, y0: 0, x1: 1024, y1: 768, gc: { fill: "#cc3366" } }],
        device: { width: 1024, height: 768, bg: "#ffffff" },
      });
      await delay(500);

      const hasContent = await canvasHasContent(page);
      assertEquals(hasContent, true);

      const dimsAfter = await canvasDimensions(page);
      const changed = dimsAfter.width !== dimsBefore.width || dimsAfter.height !== dimsBefore.height;
      assertEquals(changed, true, `Canvas dims should change: ${JSON.stringify(dimsBefore)} → ${JSON.stringify(dimsAfter)}`);
    });

    await t.step("resize replaces latest plot (no extra history entry)", async () => {
      const countAfter = await page.evaluate(
        `document.getElementById('plot-info').textContent`,
      ) as string;
      assertEquals(countAfter, countBefore, "resize frame should not add a new history entry");
    });

    await t.step("resize preserves user position in history", async () => {
      // Navigate back to plot 1 of 2
      await page.evaluate(`document.getElementById('btn-prev').click()`);
      await delay(200);

      const infoBefore = await page.evaluate(
        `document.getElementById('plot-info').textContent`,
      ) as string;
      assertEquals(infoBefore, "1 / 2");

      // Trigger another resize + frame cycle
      resizeSender.sendResize(800, 600);
      await readOfType<ResizeMessage>(rClient, "resize", (m) => m.width === 800 && m.height === 600);

      await rClient.sendFrame({
        ops: [{ op: "rect", x0: 0, y0: 0, x1: 800, y1: 600, gc: { fill: "#66cc33" } }],
        device: { width: 800, height: 600, bg: "#ffffff" },
      });
      await delay(500);

      // User should stay on plot 1 — resize updates the latest plot in
      // the background without changing the navigation position.
      const infoAfter = await page.evaluate(
        `document.getElementById('plot-info').textContent`,
      ) as string;
      assertEquals(infoAfter, "1 / 2", "resize should not jump user to latest plot");
    });

  } finally {
    resizeSender.close();
    await e2e.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});
