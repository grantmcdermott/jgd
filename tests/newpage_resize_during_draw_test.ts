/**
 * Reproduction test for plot duplication when browser resize
 * arrives during R drawing (metrics exchange).
 *
 * This test simulates the exact manual testing scenario:
 * 1. R connects and opens jgd() — BEFORE the browser
 * 2. Browser connects (ResizeObserver sends resize to R)
 * 3. R draws plot 1 — resize may arrive during metrics exchange
 * 4. R draws plot 2 — should produce exactly 2/2
 *
 * The key difference from the other fullstack test: here, R is
 * already connected when the browser sends its initial resize,
 * so the resize reaches R's transport socket and may interleave
 * with metrics request/response messages during drawing.
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
import { assertPlotInfoStable } from "./helpers/plot_settle.ts";

const arfTestAvailable = await checkArfTestAvailable();
const skip = !arfTestAvailable;

Deno.test({
  name: "Full-stack: resize arrives during R drawing — must not duplicate",
  ignore: skip,
  async fn() {
    const server = new TestServer({ tcp: true });
    const e2e = new E2EBrowser();
    const arf = new ArfSession();

    try {
      await server.start();

      // Start R FIRST — before browser — so R is connected when
      // the browser's ResizeObserver fires.
      await arf.start();
      const socketAddr = toRSocketAddress(server.socketPath);
      await arf.eval(
        `options(jgd.socket = "${socketAddr}"); library(jgd); jgd(width=8, height=6, dpi=96)`,
      );

      // Wait for R to connect to the server
      await delay(100);

      // NOW open browser — R is already connected.
      // ResizeObserver will fire → resize reaches R's socket.
      await e2e.launch();
      const page = await e2e.newPage(server.httpBaseUrl);

      // Settle: let browser connect and send initial resize
      await delay(300);

      // Plot 1
      await arf.eval("plot(1:3)");

      // Wait for plot 1
      let info = await waitForPlotCount(page, 1, 8_000);
      console.error(`After plot 1: "${info}"`);

      // Observe quiet window to catch delayed ghost entries.
      await assertPlotInfoStable(page, "1 / 1");
      info = await plotInfoText(page);
      console.error(`After plot 1 + quiet window: "${info}"`);

      // Process any pending resize
      await delay(100);
      await arf.eval(".Call(jgd:::C_jgd_poll_resize)");

      // Plot 2
      await arf.eval("plot(4:6)");

      // Wait for plot 2
      info = await waitForPlotCount(page, 2, 8_000);
      console.error(`After plot 2: "${info}"`);
      assertEquals(
        info,
        "2 / 2",
        `After 2 plots, should show 2 / 2, got "${info}" — ` +
          "plot duplication bug detected",
      );

      // Poll resize
      await delay(100);
      await arf.eval(".Call(jgd:::C_jgd_poll_resize)");

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
      await arf.shutdown();
      await e2e.close();
      await delay(100);
      await server.shutdown();
      server.cleanup();
    }
  },
});
