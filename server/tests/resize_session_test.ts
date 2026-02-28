/**
 * Server protocol test: plotIndex resize should not cross session boundaries.
 *
 * When R session 1 disconnects and R session 2 connects, a plotIndex resize
 * intended for session 1's plot should not be forwarded to session 2 (which
 * doesn't have that plot's snapshot).
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { TestServer } from "./helpers/server.ts";
import { RClient } from "./helpers/r_client.ts";
import { BrowserClient } from "./helpers/browser_client.ts";
import { delay } from "@std/async";
import type { FrameMessage, ResizeMessage } from "./helpers/types.ts";

Deno.test("plotIndex resize — session isolation after reconnect", async (t) => {
  const server = new TestServer();
  const browser = new BrowserClient();

  try {
    await server.start();
    await browser.connect(server.wsUrl);

    await t.step("plotIndex resize should not reach unrelated session", async () => {
      // --- R client 1 connects and sends a frame ---
      const r1 = new RClient();
      await r1.connect(server.socketPath);
      await r1.waitForWelcome();
      await r1.sendFrame(
        { ops: [{ op: "rect" }, { op: "text", str: "plot1" }], device: { width: 800, height: 600 } },
      );
      const frame1 = await browser.waitForType<FrameMessage>("frame");
      const session1Id = frame1.plot.sessionId;

      // --- R client 1 disconnects ---
      r1.close();
      await delay(300);

      // --- R client 2 connects and sends a frame ---
      const r2 = new RClient();
      try {
        await r2.connect(server.socketPath);
        await r2.waitForWelcome();
        await r2.sendFrame(
          { ops: [{ op: "circle" }, { op: "text", str: "plot2" }], device: { width: 800, height: 600 } },
        );
        const frame2 = await browser.waitForType<FrameMessage>("frame");
        const session2Id = frame2.plot.sessionId;

        assertNotEquals(session1Id, session2Id, "Sessions should have different IDs");

        // Prime dedup state for the new session
        browser.sendResize(800, 600);
        await r2.readMessage<ResizeMessage>();

        // --- Browser sends plotIndex=0 resize (targeting plot 1 from session 1) ---
        // Include session1Id so the server routes to the correct (dead) session.
        browser.sendResizeWithPlotIndex(640, 480, 0, session1Id);

        // The server should drop this resize because session 1 is dead.
        // R session 2 must NOT receive a plotIndex resize for another session's plot.
        let receivedPlotIndexResize = false;
        try {
          const msg = await r2.readMessage<ResizeMessage>(2000);
          if (msg.type === "resize" && msg.plotIndex !== undefined) {
            receivedPlotIndexResize = true;
          }
        } catch {
          // Timeout — R2 didn't receive the resize.  This is correct behavior.
        }

        assertEquals(
          receivedPlotIndexResize,
          false,
          "R session 2 should not receive plotIndex=0 resize (session 1 is dead)",
        );
      } finally {
        r2.close();
      }
    });

    await t.step("plotIndex resize reaches correct session when alive", async () => {
      // This is the positive case: plotIndex resize should work correctly
      // when the target session is still alive.
      const r = new RClient();
      try {
        await r.connect(server.socketPath);
        await r.waitForWelcome();

        // Send two frames (simulating two plots from the same session)
        await r.sendFrame(
          { ops: [{ op: "text", str: "plotA" }], device: { width: 800, height: 600 } },
        );
        const frameA = await browser.waitForType<FrameMessage>("frame");
        const rSessionId = frameA.plot.sessionId!;

        await r.sendFrame(
          { ops: [{ op: "text", str: "plotB" }], device: { width: 800, height: 600 } },
        );
        await browser.waitForType<FrameMessage>("frame");

        // Prime dedup state
        browser.sendResize(800, 600);
        await r.readMessage<ResizeMessage>();

        // plotIndex=0 resize — targeting the first plot from THIS session
        browser.sendResizeWithPlotIndex(640, 480, 0, rSessionId);
        const msg = await r.readMessage<ResizeMessage>();
        assertEquals(msg.type, "resize");
        assertEquals(msg.plotIndex, 0, "Same-session plotIndex resize should arrive");
      } finally {
        r.close();
      }
    });
  } finally {
    browser.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});
