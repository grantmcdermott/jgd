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
import { E2EBrowser, plotInfoText } from "../server/tests/helpers/e2e_browser.ts";
import { checkRAvailable, startR } from "./helpers/r_process.ts";

const rAvailable = await checkRAvailable();

/** Poll until plotInfo shows expected count or timeout. */
async function waitForPlotCount(
  page: Awaited<ReturnType<E2EBrowser["newPage"]>>,
  expectedCount: number,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let info = "";
  while (Date.now() < deadline) {
    info = await plotInfoText(page);
    const count = parseInt(info.split("/")[1]?.trim() ?? "0");
    if (count >= expectedCount) return info;
    await delay(200);
  }
  return info;
}

Deno.test({
  name: "Full-stack: R + Browser — 3 plots must show 3/3 (no duplication)",
  ignore: !rAvailable,
  async fn() {
    const server = new TestServer({ tcp: true });
    const e2e = new E2EBrowser();

    try {
      await server.start();
      await e2e.launch();
      const page = await e2e.newPage(server.httpBaseUrl);

      // Wait for browser to be ready
      await delay(500);

      // R creates 3 plots with long delays between them.
      // Sys.sleep(3) provides ample margin for the test to read between plots.
      // The polling loop processes resize messages between plots.
      const r = startR(
        'jgd(width=8, height=6, dpi=96); ' +
          'plot(1:3); ' +
          'Sys.sleep(3); ' +
          'for (i in 1:20) { .Call(jgd:::C_jgd_poll_resize); Sys.sleep(0.05) }; ' +
          'plot(4:6); ' +
          'Sys.sleep(3); ' +
          'for (i in 1:20) { .Call(jgd:::C_jgd_poll_resize); Sys.sleep(0.05) }; ' +
          'plot(7:9); ' +
          'Sys.sleep(1); ' +
          'for (i in 1:200) { .Call(jgd:::C_jgd_poll_resize); Sys.sleep(0.05) }',
        server.socketPath,
      );

      try {
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
        r.kill();
        try {
          await r.process.output();
        } catch { /* ignore */ }
      }
    } finally {
      await e2e.close();
      await delay(100);
      await server.shutdown();
      server.cleanup();
    }
  },
});
