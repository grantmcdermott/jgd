import { assertEquals } from "@std/assert";
import { TestServer } from "./helpers/server.ts";
import { RClient } from "./helpers/r_client.ts";
import { BrowserClient } from "./helpers/browser_client.ts";
import { delay } from "@std/async";
import type { FrameMessage, ResizeMessage } from "./helpers/types.ts";

Deno.test("plotIndex resize — pass-through and frame tagging", async (t) => {
  const server = new TestServer();
  const rClient = new RClient();
  const browser = new BrowserClient();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await browser.connect(server.wsUrl);

    // Prime dedup state
    browser.sendResize(1, 1);
    await rClient.readMessage<ResizeMessage>();

    await t.step("plotIndex passes through to R in resize message", async () => {
      browser.sendResizeWithPlotIndex(800, 600, 2);
      const msg = await rClient.readMessage<ResizeMessage>();
      assertEquals(msg.type, "resize");
      assertEquals(msg.width, 800);
      assertEquals(msg.height, 600);
      assertEquals(msg.plotIndex, 2);
    });

    await t.step("frame response has both resize:true and plotIndex", async () => {
      // R responds with a frame after the plotIndex resize
      await rClient.sendFrame(
        { ops: [{ op: "rect" }], device: { width: 800, height: 600 } },
      );
      const frame = await browser.waitForType<FrameMessage>("frame");
      assertEquals(frame.resize, true);
      assertEquals(frame.plotIndex, 2);
    });

    await t.step("normal resize frame has no plotIndex", async () => {
      browser.sendResize(1024, 768);
      await rClient.readMessage<ResizeMessage>();

      await rClient.sendFrame(
        { ops: [{ op: "circle" }], device: { width: 1024, height: 768 } },
      );
      const frame = await browser.waitForType<FrameMessage>("frame");
      assertEquals(frame.resize, true);
      assertEquals(frame.plotIndex, undefined);
    });

    await t.step("plotIndex resize bypasses dedup (same dims, different plotIndex)", async () => {
      // Send a normal resize to set dedup state to 1024x768
      // (already done in previous step)

      // Now send plotIndex resize with SAME dimensions — should NOT be deduped
      browser.sendResizeWithPlotIndex(1024, 768, 0);
      const msg = await rClient.readMessage<ResizeMessage>();
      assertEquals(msg.type, "resize");
      assertEquals(msg.width, 1024);
      assertEquals(msg.plotIndex, 0);
    });

    await t.step("plotIndex resize does NOT update dedup state", async () => {
      // Consume the frame from previous step
      await rClient.sendFrame(
        { ops: [{ op: "rect" }], device: { width: 1024, height: 768 } },
      );
      await browser.waitForType<FrameMessage>("frame");

      // Send a normal resize with the same dims as the dedup state (1024x768)
      // This should be DROPPED because plotIndex resize didn't update lastResize
      // Follow with a different size to verify
      browser.sendResize(1024, 768); // should be dropped (dedup)
      browser.sendResize(640, 480);  // should arrive

      const msg = await rClient.readMessage<ResizeMessage>();
      assertEquals(msg.width, 640, "1024x768 should be deduped; 640x480 should arrive");
      assertEquals(msg.height, 480);
    });
  } finally {
    browser.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});
