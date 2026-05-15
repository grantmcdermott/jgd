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
import { testLog } from "./helpers/test_log.ts";
import {
  plotInfoText,
  waitForPlotCount,
} from "../server/tests/helpers/e2e_browser.ts";
import { BrowserClient } from "../server/tests/helpers/browser_client.ts";
import type { FrameMessage } from "../server/tests/helpers/types.ts";
import { ArfSession, checkArfTestAvailable } from "./helpers/arf_session.ts";
import { startArfPageTest } from "./helpers/arf_e2e.ts";
import { pollResize } from "./helpers/arf_poll.ts";
import { assertPlotInfoStable } from "./helpers/plot_settle.ts";

const arfTestAvailable = await checkArfTestAvailable();
const skip = !arfTestAvailable;

async function pollUntilResizeReplay(
  arf: ArfSession,
  replayFramePromise: Promise<FrameMessage>,
): Promise<void> {
  let replayDone = false;
  replayFramePromise.then(() => (replayDone = true)).catch(
    () => (replayDone = true),
  );

  const deadline = Date.now() + 7_000;
  while (!replayDone && Date.now() < deadline) {
    await pollResize(arf, 40);
  }
  await replayFramePromise;
}

Deno.test({
  name: "Full-stack: resize arrives during R drawing — must not duplicate",
  ignore: skip,
  async fn() {
    testLog("test start");
    const ctx = await startArfPageTest({ browserFirst: false });
    const { arf, page, server } = ctx;
    const observer = new BrowserClient();

    try {
      await observer.connect(server.wsUrl);
      const replayFramePromise = observer.waitForMessage<FrameMessage>(
        (msg) =>
          msg.type === "frame" &&
          (msg as FrameMessage).resize === true &&
          (msg as FrameMessage).resizeReplay === true,
        8_000,
      );

      // Force a browser-originated resize while R is connected, then start
      // drawing immediately. The ResizeObserver debounce can let this arrive
      // while plot 1 is in progress; the replay assertion below proves R saw
      // and processed it.
      await page.evaluate(`(function() {
        var c = document.getElementById('canvas-container');
        c.style.width = '620px';
        c.style.height = '420px';
      })()`);

      // Plot 1
      await arf.eval("plot(1:3)");

      // Wait for plot 1
      let info = await waitForPlotCount(page, 1, 8_000);
      console.error(`After plot 1: "${info}"`);

      // Observe quiet window to catch delayed ghost entries.
      await assertPlotInfoStable(page, "1 / 1");
      info = await plotInfoText(page);
      console.error(`After plot 1 + quiet window: "${info}"`);

      // Process the browser-originated resize and require an observable replay.
      await pollUntilResizeReplay(arf, replayFramePromise);
      await assertPlotInfoStable(page, "1 / 1");
      info = await plotInfoText(page);
      console.error(`After resize poll before plot 2: "${info}"`);

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

      // Poll any later resize without requiring one: the initial resize replay
      // above is the coverage target for this regression.
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
      observer.close();
      await ctx.close();
    }
  },
});
