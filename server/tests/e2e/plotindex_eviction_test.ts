/**
 * Protocol-level test: plotIndex passthrough after snapshot eviction boundary.
 *
 * Creates more plots than JGD_MAX_SNAPSHOTS (50) and then resizes historical
 * plots.  Verifies that the *server* correctly forwards the absolute
 * plotIndex (plotNumber) to R and back to the browser, unchanged.
 *
 * Note: this is a mock-R test — R's C-side store_idx = plotIndex - evicted_count
 * conversion is not exercised here; that requires a real R E2E test.
 */

import { assert, assertEquals } from "@std/assert";
import { TestServer } from "../helpers/server.ts";
import { RClient } from "../helpers/r_client.ts";
import { BrowserClient } from "../helpers/browser_client.ts";
import { delay } from "@std/async";
import type { FrameMessage, ResizeMessage } from "../helpers/types.ts";

const MAX_SNAPSHOTS = 50;

Deno.test("plotIndex resize routes correctly after >50 plots (eviction boundary)", async () => {
  const server = new TestServer();
  const rClient = new RClient();
  const browser = new BrowserClient();

  try {
    await server.start();
    await browser.connect(server.wsUrl);
    await rClient.connect(server.socketPath);
    await rClient.waitForWelcome();

    // Send MAX_SNAPSHOTS + 2 plots.  After eviction on R side:
    //   evicted_count = 1
    //   snapshot_store[0] = plot 1's snapshot
    //   snapshot_store[49] = plot 50's snapshot
    //   plot 51 = active display list (no snapshot)
    const totalPlots = MAX_SNAPSHOTS + 2;
    let sessionId = "";

    for (let i = 0; i < totalPlots; i++) {
      await rClient.sendFrame({
        ops: [{ op: "rect", gc: { fill: `#${String(i).padStart(6, "0")}` } }],
        device: { width: 400, height: 300, bg: `plot-${i}` },
      }, { newPage: true, plotNumber: i });

      // Read the forwarded frame and capture sessionId
      const frame = await browser.waitForMessage<FrameMessage>(
        (msg) => msg.type === "frame",
        2000,
      );
      if (i === 0 && frame.plot?.sessionId) {
        sessionId = frame.plot.sessionId;
      }
    }

    assert(sessionId, "Should have captured sessionId from frames");

    // --- Test 1: resize targeting plot 1 (plotNumber=1) ---
    // After eviction, R's store_idx = 1 - 1 = 0.
    // The server should pass plotIndex=1 through to R unchanged.
    browser.sendResizeWithPlotIndex(600, 400, 1, sessionId);

    const resizeMsg = await rClient.readMessage<ResizeMessage>();
    assertEquals(resizeMsg.type, "resize");
    assertEquals(resizeMsg.width, 600);
    assertEquals(
      (resizeMsg as Record<string, unknown>).plotIndex, 1,
      "Server should forward plotIndex=1 (absolute plotNumber) to R",
    );

    // R replays and responds
    await rClient.sendFrame({
      ops: [{ op: "rect", gc: { fill: "#000001" } }],
      device: { width: 600, height: 400, bg: "plot-1-resized" },
    }, { resizeReplay: true, plotIndex: 1 });

    const resized = await browser.waitForMessage<FrameMessage>(
      (msg) => msg.type === "frame" && !!(msg as Record<string, unknown>).resize,
      5000,
    );

    assert(resized, "Should receive resize frame");
    assertEquals(
      (resized as Record<string, unknown>).plotIndex, 1,
      "Resize response should carry plotIndex=1",
    );
    assertEquals(
      (resized as Record<string, unknown>).plotNumber, undefined,
      "Resize-replay frame should not include plotNumber",
    );

    // --- Test 2: resize targeting plot 50 (plotNumber=50) ---
    // After eviction, R's store_idx = 50 - 1 = 49.
    browser.sendResizeWithPlotIndex(700, 500, 50, sessionId);

    const resizeMsg2 = await rClient.readMessage<ResizeMessage>();
    assertEquals(
      (resizeMsg2 as Record<string, unknown>).plotIndex, 50,
      "Server should forward plotIndex=50 to R",
    );

    await rClient.sendFrame({
      ops: [{ op: "rect", gc: { fill: "#000050" } }],
      device: { width: 700, height: 500, bg: "plot-50-resized" },
    }, { resizeReplay: true, plotIndex: 50 });

    const resized2 = await browser.waitForMessage<FrameMessage>(
      (msg) => msg.type === "frame" && !!(msg as Record<string, unknown>).resize,
      5000,
    );

    assert(resized2, "Should receive resize frame for plot 50");
    assertEquals(
      (resized2 as Record<string, unknown>).plotIndex, 50,
      "Resize response should carry plotIndex=50",
    );
    assertEquals(
      (resized2 as Record<string, unknown>).plotNumber, undefined,
      "Resize-replay frame should not include plotNumber",
    );

  } finally {
    browser.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});
