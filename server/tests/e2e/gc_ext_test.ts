/**
 * E2E test: gc.ext extension fields are applied by the Canvas2D renderer.
 *
 * Sends synthetic frames with gc.ext fields (blendMode, opacity, shadow)
 * and verifies that the renderer applies them to the canvas context.
 * Uses headless Chrome to test actual Canvas2D rendering.
 */

import { assertEquals } from "@std/assert";
import { TestServer } from "../helpers/server.ts";
import { RClient } from "../helpers/r_client.ts";
import { E2EBrowser, waitForPlotInfo } from "../helpers/e2e_browser.ts";
import { delay } from "@std/async";
import type { ResizeMessage } from "../helpers/types.ts";

Deno.test("E2E: gc.ext opacity reduces pixel alpha values", async () => {
  const server = new TestServer();
  const rClient = new RClient();
  const e2e = new E2EBrowser();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await e2e.launch();

    const page = await e2e.newPage(server.httpBaseUrl);
    await rClient.readMessage<ResizeMessage>();

    // Send a frame with a fully opaque red rectangle (no ext)
    await rClient.sendFrame({
      ops: [{
        op: "rect",
        x0: 10, y0: 10, x1: 200, y1: 150,
        gc: { fill: "#ff0000", col: "rgba(0,0,0,0)", lwd: 0 },
      }],
      device: { width: 400, height: 300, bg: "#ffffff" },
    }, { newPage: true });

    await waitForPlotInfo(page, "1 / 1");

    // Sample the red rectangle's alpha — should be fully opaque (255)
    const opaqueAlpha = await page.evaluate(`(function() {
      var c = document.getElementById('plot-canvas');
      var ctx = c.getContext('2d');
      var data = ctx.getImageData(0, 0, c.width, c.height).data;
      // Find a red pixel
      for (var i = 0; i < data.length; i += 4) {
        if (data[i] > 200 && data[i+1] < 50 && data[i+2] < 50 && data[i+3] > 0) {
          return data[i+3];
        }
      }
      return -1;
    })()`) as number;
    assertEquals(opaqueAlpha, 255, "Opaque rect should have alpha=255");

    // Send a frame with gc.ext.opacity = 0.5
    await rClient.sendFrame({
      ops: [{
        op: "rect",
        x0: 10, y0: 10, x1: 200, y1: 150,
        gc: {
          fill: "#ff0000",
          col: "rgba(0,0,0,0)",
          lwd: 0,
          ext: { opacity: 0.5 },
        },
      }],
      device: { width: 400, height: 300, bg: "#ffffff" },
    }, { newPage: true });

    await waitForPlotInfo(page, "2 / 2");

    // With opacity 0.5, the red blends with the white background.
    // On a white bg (#ffffff), a red (#ff0000) at 50% opacity becomes
    // approximately (255, 128, 128) with full alpha, because Canvas2D
    // composites onto the background.  Check that the red channel is
    // reduced compared to the fully opaque case.
    const blendedColor = await page.evaluate(`(function() {
      var c = document.getElementById('plot-canvas');
      var ctx = c.getContext('2d');
      var data = ctx.getImageData(0, 0, c.width, c.height).data;
      // Sample from the center of the rect area
      var x = Math.floor(c.width * 100 / 400);
      var y = Math.floor(c.height * 80 / 300);
      var idx = (y * c.width + x) * 4;
      return { r: data[idx], g: data[idx+1], b: data[idx+2], a: data[idx+3] };
    })()`) as { r: number; g: number; b: number; a: number };

    // With 50% opacity red on white, green channel should be around 128
    // (not 0 as with fully opaque red, nor 255 as with pure white)
    assertEquals(blendedColor.g > 80 && blendedColor.g < 200, true,
      `Green channel should show blending (got ${blendedColor.g})`);
  } finally {
    await e2e.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});

Deno.test("E2E: gc.ext blendMode changes compositing", async () => {
  const server = new TestServer();
  const rClient = new RClient();
  const e2e = new E2EBrowser();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await e2e.launch();

    const page = await e2e.newPage(server.httpBaseUrl);
    await rClient.readMessage<ResizeMessage>();

    // Two overlapping rects: red then green with blendMode "multiply"
    await rClient.sendFrame({
      ops: [
        {
          op: "rect",
          x0: 10, y0: 10, x1: 200, y1: 150,
          gc: { fill: "#ff0000", col: "rgba(0,0,0,0)", lwd: 0 },
        },
        {
          op: "rect",
          x0: 50, y0: 50, x1: 250, y1: 200,
          gc: {
            fill: "#00ff00",
            col: "rgba(0,0,0,0)",
            lwd: 0,
            ext: { blendMode: "multiply" },
          },
        },
      ],
      device: { width: 400, height: 300, bg: "#ffffff" },
    }, { newPage: true });

    await waitForPlotInfo(page, "1 / 1");

    // In the overlap area (50-200, 50-150), multiply of red and green
    // should produce black (or very dark): red(255,0,0) * green(0,255,0) = (0,0,0)
    const overlapColor = await page.evaluate(`(function() {
      var c = document.getElementById('plot-canvas');
      var ctx = c.getContext('2d');
      // Sample from center of overlap
      var x = Math.floor(c.width * 125 / 400);
      var y = Math.floor(c.height * 100 / 300);
      var idx = (y * c.width + x) * 4;
      var data = ctx.getImageData(0, 0, c.width, c.height).data;
      return { r: data[idx], g: data[idx+1], b: data[idx+2] };
    })()`) as { r: number; g: number; b: number };

    // Multiply: R*G = (255*0, 0*255, 0*0) / 255 = (0, 0, 0)
    assertEquals(overlapColor.r < 30, true,
      `Red channel in overlap should be near 0 with multiply (got ${overlapColor.r})`);
    assertEquals(overlapColor.g < 30, true,
      `Green channel in overlap should be near 0 with multiply (got ${overlapColor.g})`);
  } finally {
    await e2e.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});

Deno.test("E2E: gc.ext does not leak to subsequent ops", async () => {
  const server = new TestServer();
  const rClient = new RClient();
  const e2e = new E2EBrowser();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await e2e.launch();

    const page = await e2e.newPage(server.httpBaseUrl);
    await rClient.readMessage<ResizeMessage>();

    // First rect with opacity 0.5, second rect without ext (should be fully opaque)
    await rClient.sendFrame({
      ops: [
        {
          op: "rect",
          x0: 10, y0: 10, x1: 190, y1: 140,
          gc: {
            fill: "#0000ff",
            col: "rgba(0,0,0,0)",
            lwd: 0,
            ext: { opacity: 0.5 },
          },
        },
        {
          op: "rect",
          x0: 210, y0: 10, x1: 390, y1: 140,
          gc: { fill: "#0000ff", col: "rgba(0,0,0,0)", lwd: 0 },
        },
      ],
      device: { width: 400, height: 300, bg: "#ffffff" },
    }, { newPage: true });

    await waitForPlotInfo(page, "1 / 1");

    // The second rect (no ext) should be fully opaque blue on white bg.
    // Sample from center of second rect.
    const secondRectColor = await page.evaluate(`(function() {
      var c = document.getElementById('plot-canvas');
      var ctx = c.getContext('2d');
      var x = Math.floor(c.width * 300 / 400);
      var y = Math.floor(c.height * 75 / 300);
      var idx = (y * c.width + x) * 4;
      var data = ctx.getImageData(0, 0, c.width, c.height).data;
      return { r: data[idx], g: data[idx+1], b: data[idx+2] };
    })()`) as { r: number; g: number; b: number };

    // Fully opaque blue on white should have blue=255, red≈0, green≈0
    assertEquals(secondRectColor.b > 200, true,
      `Second rect blue channel should be >200 (got ${secondRectColor.b})`);
    assertEquals(secondRectColor.r < 30, true,
      `Second rect red should be near 0 if ext didn't leak (got ${secondRectColor.r})`);
  } finally {
    await e2e.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});
