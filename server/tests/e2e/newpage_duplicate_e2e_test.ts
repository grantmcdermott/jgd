/**
 * Reproduction test for plot duplication bug:
 * Sending a 2nd plot causes the 1st plot to be duplicated in the browser
 * history, showing "3 / 3" instead of "2 / 2" in the toolbar.
 *
 * The bug manifests in a real browser — each new plot causes the previous
 * plot to appear duplicated: [plot1, plot1-copy, plot2] instead of
 * [plot1, plot2].
 *
 * This test uses a real browser (Astral/Chromium) to verify:
 *  1. Sending two newPage frames produces exactly "2 / 2" in the toolbar.
 *  2. Sending three newPage frames produces exactly "3 / 3".
 *  3. A resize between plots does not create ghost entries.
 */

import { assertEquals } from "@std/assert";
import { TestServer } from "../helpers/server.ts";
import { RClient } from "../helpers/r_client.ts";
import { E2EBrowser, plotInfoText } from "../helpers/e2e_browser.ts";
import { delay } from "@std/async";
import type { ResizeMessage } from "../helpers/types.ts";

Deno.test("E2E: two newPage frames must show 2/2 in toolbar (no duplication)", async (t) => {
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

    await t.step("send plot 1 (red)", async () => {
      await rClient.sendFrame({
        ops: [{ op: "rect", x0: 0, y0: 0, x1: 400, y1: 300, gc: { fill: "#ff0000" } }],
        device: { width: 400, height: 300, bg: "#ff0000" },
      }, { newPage: true });
      await delay(500);

      const info = await plotInfoText(page);
      assertEquals(info, "1 / 1", "After plot 1, toolbar should show 1 / 1");
    });

    await t.step("send plot 2 (blue) — must not duplicate plot 1", async () => {
      await rClient.sendFrame({
        ops: [{ op: "rect", x0: 0, y0: 0, x1: 400, y1: 300, gc: { fill: "#0000ff" } }],
        device: { width: 400, height: 300, bg: "#0000ff" },
      }, { newPage: true });
      await delay(500);

      const info = await plotInfoText(page);
      assertEquals(
        info,
        "2 / 2",
        "After plot 2, toolbar should show 2 / 2 — " +
          `got "${info}" (duplication bug: previous plot was copied)`,
      );
    });

    await t.step("send plot 3 (green) — must not duplicate plot 2", async () => {
      await rClient.sendFrame({
        ops: [{ op: "rect", x0: 0, y0: 0, x1: 400, y1: 300, gc: { fill: "#00ff00" } }],
        device: { width: 400, height: 300, bg: "#00ff00" },
      }, { newPage: true });
      await delay(500);

      const info = await plotInfoText(page);
      assertEquals(
        info,
        "3 / 3",
        "After plot 3, toolbar should show 3 / 3 — " +
          `got "${info}" (duplication bug: previous plot was copied)`,
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

Deno.test("E2E: resize between plots must not create ghost entries", async (t) => {
  const server = new TestServer();
  const rClient = new RClient();
  const e2e = new E2EBrowser();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await e2e.launch();

    const page = await e2e.newPage(server.httpBaseUrl);
    // Consume the initial resize from browser connect
    const initResize = await rClient.readMessage<ResizeMessage>();

    await t.step("plot 1 at initial dims", async () => {
      await rClient.sendFrame({
        ops: [{ op: "rect", x0: 0, y0: 0, x1: initResize.width, y1: initResize.height, gc: { fill: "#ff0000" } }],
        device: { width: initResize.width, height: initResize.height, bg: "#ff0000" },
      }, { newPage: true });
      await delay(500);

      const info = await plotInfoText(page);
      assertEquals(info, "1 / 1");
    });

    await t.step("resize after plot 1 — replay must not add entry", async () => {
      // Trigger ResizeObserver by changing container size
      await page.evaluate(`(function() {
        var c = document.getElementById('canvas-container');
        c.style.width = '500px';
        c.style.height = '350px';
      })()`);

      // Wait for debounced resize (300ms) to reach R
      const resizeMsg = await rClient.readMessage<ResizeMessage>(5000);
      assertEquals(resizeMsg.type, "resize");

      // R sends replay at new dims (server tags with resize:true)
      await rClient.sendFrame({
        ops: [{ op: "rect", x0: 0, y0: 0, x1: resizeMsg.width, y1: resizeMsg.height, gc: { fill: "#ff0000" } }],
        device: { width: resizeMsg.width, height: resizeMsg.height, bg: "#ff0000" },
      });
      await delay(500);

      const info = await plotInfoText(page);
      assertEquals(info, "1 / 1", "Resize replay must not add a history entry");
    });

    await t.step("plot 2 after resize — must not duplicate", async () => {
      await rClient.sendFrame({
        ops: [{ op: "rect", x0: 0, y0: 0, x1: 500, y1: 350, gc: { fill: "#0000ff" } }],
        device: { width: 500, height: 350, bg: "#0000ff" },
      }, { newPage: true });
      await delay(500);

      const info = await plotInfoText(page);
      assertEquals(
        info,
        "2 / 2",
        "After plot 2, toolbar should show 2 / 2 — " +
          `got "${info}" (resize ghost or duplication bug)`,
      );
    });

    await t.step("plot 3 after plot 2 — no accumulated ghosts", async () => {
      await rClient.sendFrame({
        ops: [{ op: "rect", x0: 0, y0: 0, x1: 500, y1: 350, gc: { fill: "#00ff00" } }],
        device: { width: 500, height: 350, bg: "#00ff00" },
      }, { newPage: true });
      await delay(500);

      const info = await plotInfoText(page);
      assertEquals(
        info,
        "3 / 3",
        "After plot 3, toolbar should show 3 / 3 — " +
          `got "${info}" (accumulated ghost entries)`,
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
