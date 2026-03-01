/**
 * Reproduction test for past-plot-resize bug:
 * ResizeObserver does not send plotIndex when viewing a historical plot.
 *
 * When the user navigates back to plot 1 of 2 and resizes the browser,
 * the resize message should include plotIndex so that R re-renders the
 * historical plot at the new dimensions.  Without plotIndex, R replays
 * only the latest (current) plot's display list, and the historical
 * plot is never re-rendered server-side.
 *
 * This test uses a real browser (Astral/Chromium) to trigger the actual
 * ResizeObserver and verifies:
 *  1. Resize while viewing latest plot sends NO plotIndex (normal resize).
 *  2. Resize while viewing a past plot sends plotIndex matching the
 *     viewed plot's index.
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { TestServer } from "../helpers/server.ts";
import { RClient } from "../helpers/r_client.ts";
import { E2EBrowser, plotInfoText, readOfType } from "../helpers/e2e_browser.ts";
import { delay } from "@std/async";
import type { ResizeMessage } from "../helpers/types.ts";

Deno.test("E2E: ResizeObserver sends plotIndex when viewing past plot", async (t) => {
  const server = new TestServer();
  const rClient = new RClient();
  const e2e = new E2EBrowser();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await e2e.launch();

    const page = await e2e.newPage(server.httpBaseUrl);
    // Consume the initial resize from browser connect
    await rClient.readMessage<ResizeMessage>();

    // Send two plots
    await rClient.sendFrame({
      ops: [{ op: "rect", x0: 0, y0: 0, x1: 400, y1: 300, gc: { fill: "#ff0000" } }],
      device: { width: 400, height: 300, bg: "#ff0000" },
    }, { newPage: true });
    await delay(500);

    await rClient.sendFrame({
      ops: [{ op: "rect", x0: 0, y0: 0, x1: 400, y1: 300, gc: { fill: "#0000ff" } }],
      device: { width: 400, height: 300, bg: "#0000ff" },
    }, { newPage: true });
    await delay(500);

    const info = await plotInfoText(page);
    assertEquals(info, "2 / 2");

    await t.step("resize at latest plot sends NO plotIndex", async () => {
      // Trigger ResizeObserver by changing container size
      await page.evaluate(`(function() {
        var c = document.getElementById('canvas-container');
        c.style.width = '500px';
        c.style.height = '350px';
      })()`);

      // Wait for resize message to reach R (debounced 300ms)
      const msg = await readOfType<ResizeMessage>(
        rClient, "resize", 5000,
      );

      assertEquals(
        msg.plotIndex,
        undefined,
        "Resize at latest plot should NOT include plotIndex",
      );
    });

    await t.step("navigate to plot 1", async () => {
      await page.evaluate(`document.getElementById('btn-prev').click()`);
      await delay(300);

      const plotInfo = await plotInfoText(page);
      assertEquals(plotInfo, "1 / 2");
    });

    await t.step("resize at past plot sends plotIndex", async () => {
      // Trigger ResizeObserver with different dimensions
      await page.evaluate(`(function() {
        var c = document.getElementById('canvas-container');
        c.style.width = '600px';
        c.style.height = '400px';
      })()`);

      // Wait for resize message to reach R
      const msg = await readOfType<ResizeMessage>(
        rClient, "resize", 5000,
        (m: ResizeMessage) => m.width !== 500 && m.height !== 350,
      );

      // When viewing plot 1 of 2 (0-indexed: plotIndex=0), the resize
      // message should include plotIndex so R can re-render that
      // specific historical plot.
      assertNotEquals(
        msg.plotIndex,
        undefined,
        "Resize while viewing past plot must include plotIndex",
      );
      assertEquals(
        msg.plotIndex,
        0,
        "plotIndex should be 0 when viewing plot 1 of 2",
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
