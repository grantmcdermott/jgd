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

    await t.step("normal resize after plotIndex resize is forwarded (regression)", async () => {
      // Consume the frame from previous step
      await rClient.sendFrame(
        { ops: [{ op: "line" }], device: { width: 640, height: 480 } },
      );
      await browser.waitForType<FrameMessage>("frame");

      // Current dedup state is 640x480 from previous step.
      // Send a plotIndex resize with different dimensions — this bypasses
      // dedup and does NOT update lastResizeW/H.
      browser.sendResizeWithPlotIndex(500, 400, 0);
      const plotIndexMsg = await rClient.readMessage<ResizeMessage>();
      assertEquals(plotIndexMsg.plotIndex, 0);

      // Consume the plotIndex frame
      await rClient.sendFrame(
        { ops: [{ op: "rect" }], device: { width: 500, height: 400 } },
      );
      await browser.waitForType<FrameMessage>("frame");

      // Now send a normal resize with NEW dimensions (750x550).
      // This differs from lastResizeW/H (640x480), so it should be forwarded.
      browser.sendResize(750, 550);
      const normalMsg = await rClient.readMessage<ResizeMessage>();
      assertEquals(normalMsg.type, "resize");
      assertEquals(normalMsg.width, 750);
      assertEquals(normalMsg.height, 550);
      assertEquals(normalMsg.plotIndex, undefined, "Normal resize should not have plotIndex");

      // Verify the frame is tagged correctly
      await rClient.sendFrame(
        { ops: [{ op: "circle" }], device: { width: 750, height: 550 } },
      );
      const frame = await browser.waitForType<FrameMessage>("frame");
      assertEquals(frame.resize, true, "Should be tagged as resize");
      assertEquals(frame.plotIndex, undefined, "Should NOT have plotIndex");
    });

    await t.step("normal resize after plotIndex resize is not deduped even with same dims", async () => {
      // Current dedup state is 750x550 from previous step.
      // Send a plotIndex resize — this changes R's device dimensions
      // but should also invalidate the dedup state.
      browser.sendResizeWithPlotIndex(600, 400, 1);
      const plotIndexMsg = await rClient.readMessage<ResizeMessage>();
      assertEquals(plotIndexMsg.plotIndex, 1);

      // Consume the plotIndex frame
      await rClient.sendFrame(
        { ops: [{ op: "rect" }], device: { width: 600, height: 400 } },
      );
      await browser.waitForType<FrameMessage>("frame");

      // Now send a normal resize with the SAME dims as pre-plotIndex (750x550).
      // R's device is actually at 600x400 now due to the plotIndex resize,
      // so this 750x550 resize MUST be forwarded, not deduped.
      browser.sendResize(750, 550);

      const msg = await rClient.readMessage<ResizeMessage>();
      assertEquals(msg.width, 750, "750x550 should be forwarded after plotIndex resize invalidated dedup");
      assertEquals(msg.height, 550);
    });
  } finally {
    browser.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});
