/**
 * Server protocol test: resize state race condition.
 *
 * When the browser sends two resize messages in quick succession (e.g.,
 * ws.onopen resize without plotIndex, then ResizeObserver with plotIndex
 * after 300ms debounce), the server's pendingPlotIndex from the second
 * message can overwrite the first's state.
 *
 * If R processes them separately (likely when 300ms apart), the first
 * frame gets tagged with the second message's plotIndex — corrupting
 * the browser's plot history.
 */

import { assertEquals } from "@std/assert";
import { TestServer } from "./helpers/server.ts";
import { RClient } from "./helpers/r_client.ts";
import { BrowserClient } from "./helpers/browser_client.ts";
import { delay } from "@std/async";
import type { FrameMessage, ResizeMessage } from "./helpers/types.ts";

Deno.test("resize state race — normal then plotIndex", async (t) => {
  const server = new TestServer();
  const rClient = new RClient();
  const browser = new BrowserClient();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await browser.connect(server.wsUrl);
    await rClient.waitForWelcome();

    // Send two initial frames to establish plot history
    await rClient.sendFrame(
      { ops: [{ op: "text", str: "plot1" }], device: { width: 800, height: 600 } },
    );
    await browser.waitForType<FrameMessage>("frame");

    await rClient.sendFrame(
      { ops: [{ op: "text", str: "plot2" }], device: { width: 800, height: 600 } },
    );
    await browser.waitForType<FrameMessage>("frame");

    // Prime dedup state
    browser.sendResize(800, 600);
    await rClient.readMessage<ResizeMessage>();

    await t.step("normal resize frame should not get plotIndex from later message", async () => {
      // Simulate the real browser behavior:
      // 1. Browser sends normal resize (like ws.onopen on reconnect)
      // 2. Shortly after, browser sends plotIndex resize (ResizeObserver)
      //
      // Both arrive at the server before R responds to the first one.
      browser.sendResize(640, 480);
      // Small delay to ensure server processes the first resize
      await delay(50);
      browser.sendResizeWithPlotIndex(640, 480, 0);

      // R receives both resize messages (in order)
      const msg1 = await rClient.readMessage<ResizeMessage>();
      assertEquals(msg1.type, "resize");
      assertEquals(msg1.width, 640);
      assertEquals(msg1.plotIndex, undefined, "First resize should NOT have plotIndex");

      const msg2 = await rClient.readMessage<ResizeMessage>();
      assertEquals(msg2.type, "resize");
      assertEquals(msg2.width, 640);
      assertEquals(msg2.plotIndex, 0, "Second resize should have plotIndex=0");

      // R processes message 1 first (normal resize) and sends a frame.
      // This frame is the current plot (plot 2) re-rendered.
      await rClient.sendFrame(
        { ops: [{ op: "text", str: "plot2-resized" }], device: { width: 640, height: 480 } },
      );

      // The browser should receive this frame as a normal resize (no plotIndex).
      // BUG: The server's pendingPlotIndex was overwritten by message 2 (plotIndex=0),
      // so the frame gets tagged with plotIndex:0 even though it's plot 2's content.
      const frame1 = await browser.waitForType<FrameMessage>("frame");
      assertEquals(frame1.resize, true, "First frame should be a resize response");
      assertEquals(
        frame1.plotIndex,
        undefined,
        "First frame (normal resize of plot 2) should NOT have plotIndex. " +
          "The server tagged it with plotIndex from the SECOND resize message — state race!",
      );

      // R processes message 2 (plotIndex resize) and sends the historical plot.
      await rClient.sendFrame(
        { ops: [{ op: "text", str: "plot1-resized" }], device: { width: 640, height: 480 } },
      );

      // The browser should receive this frame with plotIndex:0.
      // BUG: The server already cleared resizePending for frame 1,
      // so this frame is treated as a new (non-resize) plot.
      const frame2 = await browser.waitForType<FrameMessage>("frame");
      assertEquals(
        frame2.resize,
        true,
        "Second frame (plotIndex resize of plot 1) should have resize:true. " +
          "The server already cleared resizePending for the first frame — lost tag!",
      );
      assertEquals(
        frame2.plotIndex,
        0,
        "Second frame should have plotIndex:0",
      );
    });
  } finally {
    browser.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});
