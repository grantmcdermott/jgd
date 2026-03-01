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

    // Prime dedup state.  Consume the pending resize with a frame so the
    // queue stays in sync (in production, every resize triggers a frame).
    browser.sendResize(1, 1);
    await rClient.readMessage<ResizeMessage>();
    await rClient.sendFrame(
      { ops: [], device: { width: 1, height: 1 } },
    );
    const primingFrame = await browser.waitForType<FrameMessage>("frame");
    const sessionId = primingFrame.plot.sessionId!;

    await t.step("plotIndex passes through to R in resize message", async () => {
      browser.sendResizeWithPlotIndex(800, 600, 2, sessionId);
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
      browser.sendResizeWithPlotIndex(1024, 768, 0, sessionId);
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

      // Current dedup state: 1024x768.
      // Send a plotIndex resize with DIFFERENT dimensions — this should
      // NOT update lastResizeW/H (plotIndex targets a historical plot,
      // not the device viewport).
      browser.sendResizeWithPlotIndex(500, 400, 0, sessionId);
      await rClient.readMessage<ResizeMessage>();
      await rClient.sendFrame(
        { ops: [{ op: "rect" }], device: { width: 500, height: 400 } },
      );
      await browser.waitForType<FrameMessage>("frame");

      // Dedup state should still be 1024x768 (NOT 500x400).
      // A normal resize at 1024x768 should be DEDUPED.
      browser.sendResize(1024, 768); // should be dropped (dedup unchanged)
      browser.sendResize(640, 480);  // should arrive

      const msg = await rClient.readMessage<ResizeMessage>();
      assertEquals(msg.width, 640, "1024x768 should be deduped; 640x480 should arrive");
      assertEquals(msg.height, 480);
    });

    await t.step("normal resize after plotIndex resize uses pre-plotIndex dedup state", async () => {
      // Consume the frame from previous step
      await rClient.sendFrame(
        { ops: [{ op: "line" }], device: { width: 640, height: 480 } },
      );
      await browser.waitForType<FrameMessage>("frame");

      // Current dedup state is 640x480.
      // Send a plotIndex resize with different dimensions — this bypasses
      // dedup but does NOT update lastResizeW/H.
      browser.sendResizeWithPlotIndex(500, 400, 0, sessionId);
      const plotIndexMsg = await rClient.readMessage<ResizeMessage>();
      assertEquals(plotIndexMsg.plotIndex, 0);

      // Consume the plotIndex frame
      await rClient.sendFrame(
        { ops: [{ op: "rect" }], device: { width: 500, height: 400 } },
      );
      await browser.waitForType<FrameMessage>("frame");

      // Dedup state is STILL 640x480 (not changed by plotIndex resize).
      // 640x480 should be deduped; 750x550 should arrive.
      browser.sendResize(640, 480);
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

    await t.step("normal resize with same dims as before plotIndex is still deduped", async () => {
      // Current dedup state is 750x550 from previous step.
      // Send a plotIndex resize — dedup state stays 750x550.
      browser.sendResizeWithPlotIndex(600, 400, 1, sessionId);
      const plotIndexMsg = await rClient.readMessage<ResizeMessage>();
      assertEquals(plotIndexMsg.plotIndex, 1);

      // Consume the plotIndex frame
      await rClient.sendFrame(
        { ops: [{ op: "rect" }], device: { width: 600, height: 400 } },
      );
      await browser.waitForType<FrameMessage>("frame");

      // Normal resize at 750x550 — dedup state is STILL 750x550 (not
      // changed by the plotIndex resize), so this is DEDUPED.
      browser.sendResize(750, 550);
      browser.sendResize(900, 700);

      const msg = await rClient.readMessage<ResizeMessage>();
      assertEquals(msg.width, 900, "750x550 should be deduped; 900x700 should arrive");
      assertEquals(msg.height, 700);
    });
  } finally {
    browser.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});
