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
import { delay } from "@std/async";
import { TestServer } from "../server/tests/helpers/server.ts";
import {
  E2EBrowser,
  plotInfoText,
  waitForPlotCount,
} from "../server/tests/helpers/e2e_browser.ts";
import { toRSocketAddress } from "./helpers/r_process.ts";
import { ArfSession, checkArfTestAvailable } from "./helpers/arf_session.ts";

const arfTestAvailable = await checkArfTestAvailable();
const skip = !arfTestAvailable;

Deno.test({
  name: "Full-stack: R + Browser — 3 plots must show 3/3 (no duplication)",
  ignore: skip,
  async fn() {
    const server = new TestServer({ tcp: true });
    const e2e = new E2EBrowser();
    const arf = new ArfSession();

    try {
      await server.start();
      await e2e.launch();
      const page = await e2e.newPage(server.httpBaseUrl);

      // Wait for browser to be ready
      await delay(500);

      await arf.start();
      const socketAddr = toRSocketAddress(server.socketPath);
      await arf.eval(
        `options(jgd.socket = "${socketAddr}"); library(jgd); jgd(width=8, height=6, dpi=96)`,
      );

      // Plot 1
      await arf.eval("plot(1:3)");

      // Wait for plot 1 to appear
      let info = await waitForPlotCount(page, 1, 10_000);
      console.error(`After plot 1: "${info}"`);
      assertEquals(info, "1 / 1", "After plot 1, should show 1 / 1");

      // Wait a moment, then verify no extra plots appeared
      await delay(1000);
      info = await plotInfoText(page);
      console.error(`After plot 1 + 1s settle: "${info}"`);
      assertEquals(
        info,
        "1 / 1",
        `After plot 1 + settle, still 1 / 1, got "${info}" — ` +
          "possible duplication from resize replay",
      );

      // Process any browser resize before next plot
      await delay(100);
      await arf.eval(".Call(jgd:::C_jgd_poll_resize)");

      // Plot 2
      await arf.eval("plot(4:6)");

      // Wait for plot 2
      info = await waitForPlotCount(page, 2, 15_000);
      console.error(`After plot 2: "${info}"`);

      // Key assertion: after 2 plots, toolbar must show "2 / 2"
      // The bug would cause "3 / 3" (previous plot duplicated)
      assertEquals(
        info,
        "2 / 2",
        `After 2 plots, should show 2 / 2, got "${info}" — ` +
          "plot duplication bug detected",
      );

      await delay(100);
      await arf.eval(".Call(jgd:::C_jgd_poll_resize)");

      // Plot 3
      await arf.eval("plot(7:9)");

      // Wait for plot 3
      info = await waitForPlotCount(page, 3, 15_000);
      console.error(`After plot 3: "${info}"`);

      assertEquals(
        info,
        "3 / 3",
        `After 3 plots, should show 3 / 3, got "${info}" — ` +
          "plot duplication bug detected",
      );
    } finally {
      await arf.shutdown();
      await e2e.close();
      await delay(100);
      await server.shutdown();
      server.cleanup();
    }
  },
});
