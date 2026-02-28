/**
 * Server protocol test: R coalescing multiple resize messages.
 *
 * In real R, poll_resize_impl() reads ALL available messages from the
 * transport socket in a while(transport_has_data) loop and produces a
 * single resize + frame.  The server's FIFO queue assumes one frame
 * per resize message.  When R coalesces, the queue goes out of sync:
 *
 * 1. Browser sends normal resize → server queues {plotIndex: undefined}
 * 2. Browser sends plotIndex resize → server queues {plotIndex: 0}
 * 3. R reads BOTH, renders historical plot, sends ONE frame
 * 4. Server shifts first entry → frame tagged as normal resize (WRONG)
 * 5. R sends a new regular frame
 * 6. Server shifts stale second entry → new frame tagged plotIndex:0 (WRONG)
 *
 * This test simulates R's coalescing by reading both resize messages
 * but responding with only one frame.
 */

import { assertEquals } from "@std/assert";
import { TestServer } from "./helpers/server.ts";
import { RClient } from "./helpers/r_client.ts";
import { BrowserClient } from "./helpers/browser_client.ts";
import { delay } from "@std/async";
import type { FrameMessage, ResizeMessage } from "./helpers/types.ts";

Deno.test("coalesced resize — stale queue entry must not tag subsequent frame", async (t) => {
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
    const frame1 = await browser.waitForType<FrameMessage>("frame");
    const sessionId = frame1.plot.sessionId!;

    await rClient.sendFrame(
      { ops: [{ op: "text", str: "plot2" }], device: { width: 800, height: 600 } },
    );
    await browser.waitForType<FrameMessage>("frame");

    // Prime dedup state: send a resize at initial dims so the server
    // records lastResize.  Consume the pending resize with a frame.
    browser.sendResize(800, 600);
    await rClient.readMessage<ResizeMessage>();
    await rClient.sendFrame(
      { ops: [{ op: "text", str: "plot2" }], device: { width: 800, height: 600 } },
    );
    await browser.waitForType<FrameMessage>("frame");

    await t.step("stale queue entry should not tag a new plot as resize response", async () => {
      // Browser sends two resize messages in quick succession:
      // 1. Normal resize (no plotIndex) — e.g. ws.onopen
      // 2. plotIndex resize — e.g. ResizeObserver after debounce
      browser.sendResize(640, 480);
      await delay(50);
      browser.sendResizeWithPlotIndex(640, 480, 0, sessionId);

      // R receives both resize messages (in order)
      const msg1 = await rClient.readMessage<ResizeMessage>();
      assertEquals(msg1.type, "resize");
      assertEquals(msg1.plotIndex, undefined, "First resize should not have plotIndex");

      const msg2 = await rClient.readMessage<ResizeMessage>();
      assertEquals(msg2.type, "resize");
      assertEquals(msg2.plotIndex, 0, "Second resize should have plotIndex=0");

      // R COALESCES both messages: its poll_resize_impl reads all available
      // messages, takes the last plotIndex, and produces a single frame.
      // We simulate this by sending only ONE frame in response to both resizes.
      await rClient.sendFrame(
        { ops: [{ op: "text", str: "plot1-resized" }], device: { width: 640, height: 480 } },
      );

      // Browser receives the coalesced frame (tagged from the first queue entry).
      const coalescedFrame = await browser.waitForType<FrameMessage>("frame");
      assertEquals(coalescedFrame.resize, true, "Coalesced frame should be a resize response");

      // Now R sends a NEW regular frame — user draws a new plot.
      // This is NOT a resize response; it's a fresh plot.
      await rClient.sendFrame(
        { ops: [{ op: "text", str: "plot3-new" }], device: { width: 640, height: 480 } },
      );

      const newFrame = await browser.waitForType<FrameMessage>("frame");

      // CRITICAL ASSERTION: The new plot frame must NOT be tagged as a
      // resize response.  If the server has a stale queue entry from the
      // unconsumed second resize, it will incorrectly tag this frame with
      // resize:true and plotIndex:0, causing the browser to overwrite
      // plot history instead of adding a new plot.
      assertEquals(
        newFrame.resize,
        undefined,
        "New plot frame must NOT be tagged as resize response. " +
          "Server has a stale queue entry from the coalesced resize.",
      );
      assertEquals(
        newFrame.plotIndex,
        undefined,
        "New plot frame must NOT have plotIndex. " +
          "Stale queue entry corrupts frame metadata.",
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
