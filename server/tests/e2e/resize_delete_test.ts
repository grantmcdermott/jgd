import { assertEquals } from "@std/assert";
import { TestServer } from "../helpers/server.ts";
import { RClient } from "../helpers/r_client.ts";
import { BrowserClient } from "../helpers/browser_client.ts";
import { E2EBrowser, readOfType, sampleCanvasColors } from "../helpers/e2e_browser.ts";
import { delay } from "@std/async";
import type { ResizeMessage } from "../helpers/types.ts";

/**
 * Reproduction test for resize-after-delete bug (jgd#11 comment):
 *
 * 1. Create two plots: RED (plot(1:10)) then BLUE (hist(rnorm(100)))
 * 2. Delete the second (BLUE) plot
 * 3. Resize the panel
 * 4. R replays its display list — sends the BLUE (deleted) plot back
 *
 * Bug: replaceLatest() overwrites the remaining RED plot with the BLUE one,
 * and the RED plot is lost forever.
 *
 * Expected: the RED plot should survive; the resized frame from R should
 * NOT replace a plot that differs from what R replayed.
 */
Deno.test("E2E: resize after deleting latest plot must not replace remaining plot", async (t) => {
  const server = new TestServer();
  const rClient = new RClient();
  const e2e = new E2EBrowser();
  const resizeSender = new BrowserClient();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await e2e.launch();

    const page = await e2e.newPage(server.httpBaseUrl);
    await resizeSender.connect(server.wsUrl);

    // Consume the initial resize from browser connect
    await rClient.readMessage<ResizeMessage>();

    // Frame 1: entirely RED (simulates plot(1:10))
    await rClient.sendFrame({
      ops: [{ op: "rect", x0: 0, y0: 0, x1: 400, y1: 300, gc: { fill: "#ff0000" } }],
      device: { width: 400, height: 300, bg: "#ff0000" },
    });
    await delay(500);

    // Frame 2: entirely BLUE (simulates hist(rnorm(100)))
    await rClient.sendFrame({
      ops: [{ op: "rect", x0: 0, y0: 0, x1: 400, y1: 300, gc: { fill: "#0000ff" } }],
      device: { width: 400, height: 300, bg: "#0000ff" },
    });
    await delay(500);

    await t.step("setup: at plot 2/2, canvas is blue", async () => {
      const info = await page.evaluate(
        `document.getElementById('plot-info').textContent`,
      ) as string;
      assertEquals(info, "2 / 2");

      const colors = await sampleCanvasColors(page);
      assertEquals(colors.hasBlue, true, "plot 2 should show blue");
      assertEquals(colors.hasRed, false, "plot 2 should not show red");
    });

    await t.step("delete current (blue) plot, canvas shows red", async () => {
      await page.evaluate(`document.getElementById('btn-delete').click()`);
      await delay(300);

      const info = await page.evaluate(
        `document.getElementById('plot-info').textContent`,
      ) as string;
      assertEquals(info, "1 / 1", "should have 1 plot remaining after delete");

      const colors = await sampleCanvasColors(page);
      assertEquals(colors.hasRed, true, "remaining plot should be red");
      assertEquals(colors.hasBlue, false, "deleted blue plot should be gone");
    });

    await t.step("resize after delete — remaining plot must survive", async () => {
      // Send resize from BrowserClient mock
      resizeSender.sendResize(800, 600);

      const msg = await readOfType<ResizeMessage>(
        rClient, "resize", (m) => m.width === 800,
      );
      assertEquals(msg.width, 800);

      // R replays its display list — which is the histogram (BLUE),
      // because R does not know about client-side deletion.
      // Server tags this with resize:true.
      await rClient.sendFrame({
        ops: [{ op: "rect", x0: 0, y0: 0, x1: 800, y1: 600, gc: { fill: "#0000ff" } }],
        device: { width: 800, height: 600, bg: "#0000ff" },
      });
      await delay(500);

      // The remaining RED plot must NOT be replaced by the BLUE one.
      const info = await page.evaluate(
        `document.getElementById('plot-info').textContent`,
      ) as string;
      assertEquals(info, "1 / 1", "plot count should still be 1 after resize");

      const colors = await sampleCanvasColors(page);
      assertEquals(colors.hasRed, true, "canvas should still show the red plot");
      assertEquals(colors.hasBlue, false, "deleted blue plot must not reappear via resize");
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