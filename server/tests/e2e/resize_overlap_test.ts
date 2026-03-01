import { assertEquals } from "@std/assert";
import { TestServer } from "../helpers/server.ts";
import { RClient } from "../helpers/r_client.ts";
import { BrowserClient } from "../helpers/browser_client.ts";
import { E2EBrowser, readOfType, sampleCanvasColors } from "../helpers/e2e_browser.ts";
import { delay } from "@std/async";
import type { ResizeMessage } from "../helpers/types.ts";

/**
 * Reproduction test for ghost/overlap bug:
 * Plot 2 images -> navigate back to plot 1 -> resize -> two images overlap.
 */
Deno.test("E2E: resize after history navigation must not show ghost image", async (t) => {
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

    // Frame 1: entirely RED (#ff0000)
    await rClient.sendFrame({
      ops: [{ op: "rect", x0: 0, y0: 0, x1: 400, y1: 300, gc: { fill: "#ff0000" } }],
      device: { width: 400, height: 300, bg: "#ff0000" },
    }, { newPage: true });
    await delay(500);

    // Frame 2: entirely BLUE (#0000ff)
    await rClient.sendFrame({
      ops: [{ op: "rect", x0: 0, y0: 0, x1: 400, y1: 300, gc: { fill: "#0000ff" } }],
      device: { width: 400, height: 300, bg: "#0000ff" },
    }, { newPage: true });
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

    await t.step("navigate to plot 1, canvas is red", async () => {
      await page.evaluate(`document.getElementById('btn-prev').click()`);
      await delay(300);

      const info = await page.evaluate(
        `document.getElementById('plot-info').textContent`,
      ) as string;
      assertEquals(info, "1 / 2");

      const colors = await sampleCanvasColors(page);
      assertEquals(colors.hasRed, true, "plot 1 should show red");
      assertEquals(colors.hasBlue, false, "plot 1 should not show blue");
    });

    await t.step("mock resize while viewing plot 1 — no ghost/overlap", async () => {
      // Send resize from BrowserClient mock
      resizeSender.sendResize(800, 600);

      const msg = await readOfType<ResizeMessage>(
        rClient, "resize", (m) => m.width === 800,
      );
      assertEquals(msg.width, 800);

      // R responds with the latest plot redrawn at new size.
      // Server should tag this with resize:true -> replaceLatest, not addPlot.
      await rClient.sendFrame({
        ops: [{ op: "rect", x0: 0, y0: 0, x1: 800, y1: 600, gc: { fill: "#00ff00" } }],
        device: { width: 800, height: 600, bg: "#00ff00" },
      });
      await delay(500);

      const info = await page.evaluate(
        `document.getElementById('plot-info').textContent`,
      ) as string;
      assertEquals(info, "1 / 2", "toolbar should stay at plot 1");

      const colors = await sampleCanvasColors(page);
      assertEquals(colors.hasRed, true, "canvas should show plot 1 (red)");
      assertEquals(colors.hasBlue, false, "canvas must not show ghost of plot 2 (blue)");
      assertEquals(colors.hasGreen, false, "canvas must not show resize frame (green)");
    });

    await t.step("multi-frame resize replay must not corrupt historical plot", async () => {
      // Simulates R's GEplayDisplayList sending multiple frames during resize:
      // 1. A complete frame from dev.hold/dev.flush (tagged resize:true by server)
      // 2. An incremental frame from cb_mode(0) for annotations outside hold scope
      //    (e.g. abline, lines, title) — NOT tagged resize:true.
      //
      // Bug: the incremental frame hits appendOps(plots[currentIndex]), which
      // corrupts the historical plot when currentIndex != latest.

      // Ensure we're on plot 1
      const infoPre = await page.evaluate(
        `document.getElementById('plot-info').textContent`,
      ) as string;
      if (infoPre !== "1 / 2") {
        await page.evaluate(`document.getElementById('btn-prev').click()`);
        await delay(300);
      }

      // Send resize
      resizeSender.sendResize(850, 650);
      const msg = await readOfType<ResizeMessage>(
        rClient, "resize", (m) => m.width === 850,
      );
      assertEquals(msg.width, 850);

      // Frame 1: complete frame (will be tagged resize:true -> replaceLatest)
      await rClient.sendFrame({
        ops: [{ op: "rect", x0: 0, y0: 0, x1: 850, y1: 650, gc: { fill: "#00ff00" } }],
        device: { width: 850, height: 650, bg: "#00ff00" },
      });

      // Frame 2: incremental frame — simulates annotation replay (abline etc.)
      // This frame is NOT tagged resize:true by the server, so it goes through
      // the incremental path in handleFrame -> appendOps.
      await rClient.sendFrame(
        {
          ops: [{ op: "line", x1: 0, y1: 325, x2: 850, y2: 325, gc: { col: "#00ff00" } }],
          device: { width: 850, height: 650, bg: "#00ff00" },
        },
        { incremental: true },
      );
      await delay(500);

      // Historical plot 1 must not be corrupted by the incremental frame
      const info = await page.evaluate(
        `document.getElementById('plot-info').textContent`,
      ) as string;
      assertEquals(info, "1 / 2", "toolbar should stay at plot 1");

      const colors = await sampleCanvasColors(page);
      assertEquals(colors.hasRed, true, "canvas should show plot 1 (red)");
      assertEquals(colors.hasGreen, false, "incremental resize frame must not leak into historical plot");
    });

    await t.step("real ResizeObserver resize — no ghost/overlap", async () => {
      // Navigate back to plot 1 (might already be there)
      const infoPre = await page.evaluate(
        `document.getElementById('plot-info').textContent`,
      ) as string;
      if (infoPre !== "1 / 2") {
        await page.evaluate(`document.getElementById('btn-prev').click()`);
        await delay(300);
      }

      // Change container size via JS to trigger the actual ResizeObserver
      await page.evaluate(`(function() {
        var c = document.getElementById('canvas-container');
        c.style.width = '600px';
        c.style.height = '400px';
      })()`);

      // The ResizeObserver fires -> replayCurrentPlot() + debounced resize (300ms)
      // Wait for the debounced resize message to reach R
      const msg = await readOfType<ResizeMessage>(
        rClient, "resize", (m) => m.width !== 800 || m.height !== 600,
      );

      // R responds with resize frame
      await rClient.sendFrame({
        ops: [{ op: "rect", x0: 0, y0: 0, x1: msg.width, y1: msg.height, gc: { fill: "#00ff00" } }],
        device: { width: msg.width, height: msg.height, bg: "#00ff00" },
      });
      await delay(500);

      const info = await page.evaluate(
        `document.getElementById('plot-info').textContent`,
      ) as string;
      assertEquals(info, "1 / 2", "toolbar should stay at plot 1 after real resize");

      const colors = await sampleCanvasColors(page);
      assertEquals(colors.hasRed, true, "canvas should still show plot 1 (red)");
      assertEquals(colors.hasBlue, false, "no ghost of plot 2 (blue)");
      assertEquals(colors.hasGreen, false, "no leak of resize frame (green)");
    });

    await t.step("sequential resizes — both tagged as resize", async () => {
      // Two resizes in sequence (R responds between them).
      // Both frames should be tagged resize:true -> replaceLatest.
      const infoPre = await page.evaluate(
        `document.getElementById('plot-info').textContent`,
      ) as string;
      if (infoPre !== "1 / 2") {
        await page.evaluate(`document.getElementById('btn-prev').click()`);
        await delay(300);
      }

      const infoBefore = await page.evaluate(
        `document.getElementById('plot-info').textContent`,
      ) as string;

      // First resize
      resizeSender.sendResize(900, 700);
      const r1 = await readOfType<ResizeMessage>(rClient, "resize", (m) => m.width === 900);
      assertEquals(r1.width, 900);

      await rClient.sendFrame({
        ops: [{ op: "rect", x0: 0, y0: 0, x1: 900, y1: 700, gc: { fill: "#00ff00" } }],
        device: { width: 900, height: 700, bg: "#00ff00" },
      });
      await delay(300);

      // Second resize
      resizeSender.sendResize(1000, 750);
      const r2 = await readOfType<ResizeMessage>(rClient, "resize", (m) => m.width === 1000);
      assertEquals(r2.width, 1000);

      await rClient.sendFrame({
        ops: [{ op: "rect", x0: 0, y0: 0, x1: 1000, y1: 750, gc: { fill: "#ffff00" } }],
        device: { width: 1000, height: 750, bg: "#ffff00" },
      });
      await delay(500);

      // Neither resize should have added a history entry
      const infoAfter = await page.evaluate(
        `document.getElementById('plot-info').textContent`,
      ) as string;
      assertEquals(
        infoAfter, infoBefore,
        `sequential resizes should not add history entries: was ${infoBefore}, now ${infoAfter}`,
      );

      const colors = await sampleCanvasColors(page);
      assertEquals(colors.hasRed, true, "canvas should still show plot 1 (red)");
      assertEquals(colors.hasGreen, false, "no leak of first resize frame (green)");
      assertEquals(colors.hasYellow, false, "no leak of second resize frame (yellow)");
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
