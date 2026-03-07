/**
 * E2E regression test for plotIndex mismatch after deletion.
 *
 * Bug: After deleting plots from browser history, the browser's plotIndex
 * (sent in resize messages) no longer matches R's snapshot index.
 *
 * Example: R has snapshots [A=0, B=1, C=2, D=3].
 * Browser deletes A and C → history is [B, D].
 * Viewing B (browser index 0), resize sends plotIndex=0.
 * R replays snapshot[0] = A → B gets replaced with A. WRONG.
 * Should send plotIndex=1 (B's R-side snapshot index).
 *
 * This test verifies:
 *  1. After deleting plots, resize sends the correct R-side plotIndex.
 *  2. R's plotIndex response updates the correct plot (not a different one).
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { TestServer } from "../helpers/server.ts";
import { RClient } from "../helpers/r_client.ts";
import { E2EBrowser, readOfType, sampleCanvasColors, waitForPlotInfo } from "../helpers/e2e_browser.ts";
import { delay } from "@std/async";
import type { ResizeMessage } from "../helpers/types.ts";

Deno.test("E2E: plotIndex after deletion must use R snapshot index", async (t) => {
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

    // Create 4 plots: RED(0), GREEN(1), BLUE(2), YELLOW(3)
    await rClient.sendFrame({
      ops: [{ op: "rect", x0: 0, y0: 0, x1: 400, y1: 300, gc: { fill: "#ff0000" } }],
      device: { width: 400, height: 300, bg: "#ff0000" },
    }, { newPage: true });
    await waitForPlotInfo(page, "1 / 1");

    await rClient.sendFrame({
      ops: [{ op: "rect", x0: 0, y0: 0, x1: 400, y1: 300, gc: { fill: "#00ff00" } }],
      device: { width: 400, height: 300, bg: "#00ff00" },
    }, { newPage: true });
    await waitForPlotInfo(page, "2 / 2");

    await rClient.sendFrame({
      ops: [{ op: "rect", x0: 0, y0: 0, x1: 400, y1: 300, gc: { fill: "#0000ff" } }],
      device: { width: 400, height: 300, bg: "#0000ff" },
    }, { newPage: true });
    await waitForPlotInfo(page, "3 / 3");

    await rClient.sendFrame({
      ops: [{ op: "rect", x0: 0, y0: 0, x1: 400, y1: 300, gc: { fill: "#ffff00" } }],
      device: { width: 400, height: 300, bg: "#ffff00" },
    }, { newPage: true });
    await waitForPlotInfo(page, "4 / 4");

    await t.step("delete RED (plot 1) — navigate to it and delete", async () => {
      // Navigate back to plot 1 (RED)
      await page.evaluate(`document.getElementById('btn-prev').click()`);
      await waitForPlotInfo(page, "3 / 4");
      await page.evaluate(`document.getElementById('btn-prev').click()`);
      await waitForPlotInfo(page, "2 / 4");
      await page.evaluate(`document.getElementById('btn-prev').click()`);
      await waitForPlotInfo(page, "1 / 4");

      const colors = await sampleCanvasColors(page);
      assertEquals(colors.hasRed, true, "should be viewing RED");

      // Delete RED
      await page.evaluate(`document.getElementById('btn-delete').click()`);
      await waitForPlotInfo(page, "1 / 3");

      // Should now show GREEN (next plot after deletion)
      const colorsAfter = await sampleCanvasColors(page);
      assertEquals(colorsAfter.hasGreen, true, "after deleting RED, should show GREEN");
    });

    await t.step("delete BLUE (plot 2 of remaining [GREEN, BLUE, YELLOW])", async () => {
      // Navigate to BLUE (now at position 2/3)
      await page.evaluate(`document.getElementById('btn-next').click()`);
      await waitForPlotInfo(page, "2 / 3");

      const colors = await sampleCanvasColors(page);
      assertEquals(colors.hasBlue, true, "should be viewing BLUE");

      // Delete BLUE
      await page.evaluate(`document.getElementById('btn-delete').click()`);
      await waitForPlotInfo(page, "2 / 2");

      // Should now show YELLOW (the remaining plot at that position)
      const colorsAfter = await sampleCanvasColors(page);
      assertEquals(colorsAfter.hasYellow, true, "after deleting BLUE, should show YELLOW");
    });

    // At this point: browser has [GREEN, YELLOW], R snapshots are [RED=0, GREEN=1, BLUE=2, YELLOW=3]
    // Viewing YELLOW (browser index 1, R snapshot index 3)

    await t.step("navigate to GREEN and resize — must send correct plotIndex", async () => {
      // Navigate to GREEN
      await page.evaluate(`document.getElementById('btn-prev').click()`);
      await waitForPlotInfo(page, "1 / 2");

      const colors = await sampleCanvasColors(page);
      assertEquals(colors.hasGreen, true, "should be viewing GREEN");

      // Trigger resize by changing container size
      await page.evaluate(`(function() {
        var c = document.getElementById('canvas-container');
        c.style.width = '600px';
        c.style.height = '450px';
      })()`);

      // Read the resize message R receives
      const msg = await readOfType<ResizeMessage>(rClient, "resize", 5000);
      assertEquals(msg.type, "resize");

      // The plotIndex must be GREEN's R-side snapshot index (1),
      // NOT the browser array index (0).
      assertNotEquals(
        msg.plotIndex,
        undefined,
        "resize while viewing non-latest plot must include plotIndex",
      );
      assertEquals(
        msg.plotIndex,
        1,
        "plotIndex must be GREEN's R snapshot index (1), not browser array index (0)",
      );
    });

    await t.step("R response with correct plotIndex updates GREEN, not YELLOW", async () => {
      // R replays snapshot[1] (GREEN) at new dimensions
      await rClient.sendFrame({
        ops: [{ op: "rect", x0: 0, y0: 0, x1: 600, y1: 450, gc: { fill: "#00ff00" } }],
        device: { width: 600, height: 450, bg: "#00ff00" },
      }, { resizeReplay: true, plotIndex: 1 });
      await delay(500);

      // Should still be 1/2 — resize must not add history entries
      const info = await page.evaluate(
        `document.getElementById('plot-info').textContent`,
      ) as string;
      assertEquals(info, "1 / 2", "resize must not change plot count");

      // Canvas should still show GREEN
      const colors = await sampleCanvasColors(page);
      assertEquals(colors.hasGreen, true, "GREEN should be updated in place");
      assertEquals(colors.hasRed, false, "RED must not reappear");
    });

    await t.step("YELLOW is unchanged after GREEN resize", async () => {
      // Navigate to YELLOW
      await page.evaluate(`document.getElementById('btn-next').click()`);
      await waitForPlotInfo(page, "2 / 2");

      const colors = await sampleCanvasColors(page);
      assertEquals(colors.hasYellow, true, "YELLOW must be unchanged");
    });

  } finally {
    await e2e.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});
