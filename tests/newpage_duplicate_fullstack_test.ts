/**
 * Full-stack reproduction test: Real R + Real Browser (Astral/Chromium).
 *
 * This test most closely replicates the manual testing scenario where
 * the user sees plot duplication. It combines:
 * - A real R process creating plots via jgd()
 * - A real headless Chromium browser with ResizeObserver, WebSocket, etc.
 *
 * If this test fails, it confirms the bug is in the real R/browser interaction.
 * If it passes, the bug may be specific to interactive R sessions or the
 * user's environment.
 */

import { assertEquals } from "@std/assert";
import { testLog } from "./helpers/test_log.ts";
import {
  plotInfoText,
  waitForPlotCount,
} from "../server/tests/helpers/e2e_browser.ts";
import { checkArfTestAvailable } from "./helpers/arf_session.ts";
import { startArfPageTest } from "./helpers/arf_e2e.ts";
import { pollResize } from "./helpers/arf_poll.ts";
import { assertPlotInfoStable } from "./helpers/plot_settle.ts";

const arfTestAvailable = await checkArfTestAvailable();
const skip = !arfTestAvailable;

Deno.test({
  name: "Full-stack: R + Browser — 3 plots must show 3/3 (no duplication)",
  ignore: skip,
  async fn() {
    testLog("test start");
    const ctx = await startArfPageTest({ browserFirst: true });
    const { arf, page } = ctx;

    try {
      // Plot 1
      await arf.eval("plot(1:3)");

      // Wait for plot 1 to appear
      let info = await waitForPlotCount(page, 1, 8_000);
      console.error(`After plot 1: "${info}"`);
      assertEquals(info, "1 / 1", "After plot 1, should show 1 / 1");

      // Observe a quiet window to ensure no delayed duplicate frame appears.
      await assertPlotInfoStable(page, "1 / 1");
      info = await plotInfoText(page);
      console.error(`After plot 1 + quiet window: "${info}"`);

      // Process any browser resize before next plot
      await pollResize(arf, 40);
      await assertPlotInfoStable(page, "1 / 1");
      info = await plotInfoText(page);
      console.error(`After resize poll before plot 2: "${info}"`);

      // Plot 2
      await arf.eval("plot(4:6)");

      // Wait for plot 2
      info = await waitForPlotCount(page, 2, 8_000);
      console.error(`After plot 2: "${info}"`);

      // Key assertion: after 2 plots, toolbar must show "2 / 2"
      // The bug would cause "3 / 3" (previous plot duplicated)
      assertEquals(
        info,
        "2 / 2",
        `After 2 plots, should show 2 / 2, got "${info}" — ` +
          "plot duplication bug detected",
      );

      await pollResize(arf, 40);
      await assertPlotInfoStable(page, "2 / 2");
      info = await plotInfoText(page);
      console.error(`After resize poll before plot 3: "${info}"`);

      // Plot 3
      await arf.eval("plot(7:9)");

      // Wait for plot 3
      info = await waitForPlotCount(page, 3, 8_000);
      console.error(`After plot 3: "${info}"`);

      assertEquals(
        info,
        "3 / 3",
        `After 3 plots, should show 3 / 3, got "${info}" — ` +
          "plot duplication bug detected",
      );
    } finally {
      await ctx.close();
    }
  },
});
