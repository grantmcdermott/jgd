import { assertEquals } from "@std/assert";
import { TestServer } from "./helpers/server.ts";
import { RClient } from "./helpers/r_client.ts";
import { BrowserClient } from "./helpers/browser_client.ts";
import { delay } from "@std/async";
import type { FrameMessage, ResizeMessage } from "./helpers/types.ts";

/**
 * Regression test: duplicate resizes with the same dimensions must NOT be
 * forwarded to R.  Without dedup, ws.onopen + ResizeObserver both send the
 * same {width, height} — R responds to each, but only the first frame gets
 * resize:true.  The second, untagged frame is treated as addPlot, corrupting
 * plot history (ghost/overlap bug).
 */
Deno.test("resize dedup — same dimensions are dropped", async (t) => {
  const server = new TestServer();
  const rClient = new RClient();
  const browser = new BrowserClient();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await browser.connect(server.wsUrl);

    // Prime dedup state with an initial (unique) resize
    browser.sendResize(1, 1);
    await rClient.readMessage<ResizeMessage>();

    await t.step("duplicate resize is silently dropped", async () => {
      // First resize with new dimensions — should reach R
      browser.sendResize(800, 600);
      const msg1 = await rClient.readMessage<ResizeMessage>();
      assertEquals(msg1.type, "resize");
      assertEquals(msg1.width, 800);

      // Send duplicate with SAME dimensions, then immediately send
      // a resize with DIFFERENT dimensions.  If the duplicate were
      // forwarded, R would see two messages (800x600 then 1024x768).
      // With proper dedup, only 1024x768 arrives.
      browser.sendResize(800, 600); // duplicate — should be dropped
      browser.sendResize(1024, 768); // new dims — should arrive

      const msg2 = await rClient.readMessage<ResizeMessage>();
      assertEquals(msg2.width, 1024, "R should receive 1024, not a duplicate 800");
      assertEquals(msg2.height, 768);
    });

    await t.step("tagged resize:true frame after dedup", async () => {
      // resizePending should be armed from the 1024x768 resize above
      await rClient.sendFrame(
        { ops: [{ op: "rect" }], device: { width: 1024, height: 768 } },
      );
      const frame = await browser.waitForType<FrameMessage>("frame");
      assertEquals(frame.resize, true, "frame after resize should be tagged");
    });

    await t.step("subsequent frame without resize has no tag", async () => {
      await rClient.sendFrame(
        { ops: [{ op: "circle" }], device: { width: 1024, height: 768 } },
      );
      const frame = await browser.waitForType<FrameMessage>("frame");
      assertEquals(frame.resize, undefined, "regular frame should not be tagged");
    });

    await t.step("simulated ws.onopen + ResizeObserver race", async () => {
      // Simulate what happens when browser connects: ws.onopen sends
      // resize, then ResizeObserver fires with the same dimensions.
      // Only the first should reach R.
      browser.sendResize(640, 480); // "ws.onopen"
      const first = await rClient.readMessage<ResizeMessage>();
      assertEquals(first.width, 640);

      // "ResizeObserver" fires with identical dims — should be dropped.
      // Follow with a distinguishable resize to verify the duplicate
      // didn't arrive.
      browser.sendResize(640, 480); // duplicate — dropped
      browser.sendResize(320, 240); // distinguishable

      const second = await rClient.readMessage<ResizeMessage>();
      assertEquals(second.width, 320, "duplicate 640 should be dropped; 320 should arrive");
    });
  } finally {
    browser.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});
