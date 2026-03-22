/**
 * E2E test for the resize replay race condition:
 *
 * When a normal resize replay (no plotIndex) arrives AFTER a new plot has been
 * added to the browser history, replaceLatest must NOT overwrite the new plot
 * with stale content.  The fix uses plotNumber from the resize replay frame to
 * verify the replay targets the current latest plot.
 *
 * Scenario:
 *  1. Send plot 1 (red, plotNumber=0)
 *  2. Send plot 2 (blue, plotNumber=1)
 *  3. Send a stale resize replay with plotNumber=0 (as if R replayed plot 1's DL)
 *  4. Verify plot 2 is still blue — NOT overwritten by plot 1's red content
 */

import { assertEquals } from "@std/assert";
import { TestServer } from "../helpers/server.ts";
import { RClient } from "../helpers/r_client.ts";
import {
  E2EBrowser,
  plotInfoText,
  sampleCanvasColors,
  waitForPlotInfo,
  waitForCanvasColors,
} from "../helpers/e2e_browser.ts";
import { delay } from "@std/async";
import type { ResizeMessage } from "../helpers/types.ts";

Deno.test("E2E: stale resize replay must not overwrite newer plot", async (t) => {
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

    await t.step("send plot 1 (red) and plot 2 (blue)", async () => {
      await rClient.sendFrame({
        ops: [{ op: "rect", x0: 0, y0: 0, x1: 400, y1: 300, gc: { fill: "#ff0000" } }],
        device: { width: 400, height: 300, bg: "#ff0000" },
      }, { newPage: true }); // plotNumber=0 (auto)
      await waitForPlotInfo(page, "1 / 1");

      await rClient.sendFrame({
        ops: [{ op: "rect", x0: 0, y0: 0, x1: 400, y1: 300, gc: { fill: "#0000ff" } }],
        device: { width: 400, height: 300, bg: "#0000ff" },
      }, { newPage: true }); // plotNumber=1 (auto)
      await waitForPlotInfo(page, "2 / 2");
      await waitForCanvasColors(page, { hasBlue: true, hasRed: false });
    });

    await t.step("stale resize replay (plotNumber=0) must be rejected", async () => {
      // Simulate: R replayed plot 1's display list for a resize that was sent
      // before plot 2 arrived.  The replay carries plotNumber=0.
      await rClient.sendFrame({
        ops: [{ op: "rect", x0: 0, y0: 0, x1: 400, y1: 300, gc: { fill: "#ff0000" } }],
        device: { width: 400, height: 300, bg: "#ff0000" },
      }, { resizeReplay: true, plotNumber: 0 });

      // Give the browser time to (not) process the stale replay
      await delay(500);

      // Toolbar must still show 2/2 (no ghost entry added)
      const info = await plotInfoText(page);
      assertEquals(info, "2 / 2", "Stale replay must not add a history entry");

      // Canvas must still show blue (plot 2), not red (stale plot 1 replay)
      const colors = await sampleCanvasColors(page);
      assertEquals(colors.hasBlue, true, "Canvas must still show plot 2 (blue)");
      assertEquals(colors.hasRed, false, "Canvas must not show stale plot 1 (red)");
    });

    await t.step("valid resize replay (plotNumber=1) must be accepted", async () => {
      // Simulate: R replayed plot 2's display list — this is the correct current plot.
      await rClient.sendFrame({
        ops: [{ op: "rect", x0: 0, y0: 0, x1: 400, y1: 300, gc: { fill: "#00ff00" } }],
        device: { width: 400, height: 300, bg: "#00ff00" },
      }, { resizeReplay: true, plotNumber: 1 });

      // The canvas should now show green (the valid resize replay for plot 2)
      await waitForCanvasColors(page, { hasGreen: true, hasBlue: false });

      // Still 2/2 — no entry added
      const info = await plotInfoText(page);
      assertEquals(info, "2 / 2");
    });

  } finally {
    await e2e.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});
