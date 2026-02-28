/**
 * Server protocol test: sessionId reuse across device instances.
 *
 * When R uses PID-based sessionId (e.g. "r-12345"), closing and
 * reopening the jgd device within the same R process would reuse the
 * sessionId.  The server detects this and remaps the new connection
 * to a unique sessionId, so the browser keeps plot histories separate
 * and plotIndex resizes for old plots don't reach the new connection.
 *
 * R-side fix: each device instance uses a unique sessionId
 * (e.g. "r-<pid>-<counter>").
 * Server-side defense: Hub.updateSessionId detects retired sessionIds
 * and appends a suffix to disambiguate.
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { TestServer } from "./helpers/server.ts";
import { RClient } from "./helpers/r_client.ts";
import { BrowserClient } from "./helpers/browser_client.ts";
import { delay } from "@std/async";
import type { FrameMessage, ResizeMessage } from "./helpers/types.ts";

Deno.test("sessionId reuse — server disambiguates retired sessionIds", async (t) => {
  const server = new TestServer();
  const browser = new BrowserClient();

  try {
    await server.start();
    await browser.connect(server.wsUrl);

    await t.step("plotIndex resize for retired sessionId does not reach new device", async () => {
      // --- R device instance 1 connects with sessionId "r-100" ---
      const r1 = new RClient();
      await r1.connect(server.socketPath);
      await r1.waitForWelcome();

      await r1.sendFrame({
        sessionId: "r-100",
        ops: [{ op: "text", str: "plot1-from-device1" }],
        device: { width: 800, height: 600 },
      });
      const frame1 = await browser.waitForType<FrameMessage>("frame");
      const session1Id = frame1.plot.sessionId!;
      assertEquals(session1Id, "r-100", "First connection keeps its sessionId");

      // --- R device instance 1 closes ---
      r1.close();
      await delay(300);

      // --- R device instance 2 connects with SAME sessionId "r-100" ---
      const r2 = new RClient();
      try {
        await r2.connect(server.socketPath);
        await r2.waitForWelcome();

        await r2.sendFrame({
          sessionId: "r-100",
          ops: [{ op: "text", str: "plot2-from-device2" }],
          device: { width: 800, height: 600 },
        });
        const frame2 = await browser.waitForType<FrameMessage>("frame");
        const session2Id = frame2.plot.sessionId!;

        // Server should have remapped the sessionId to avoid collision
        assertNotEquals(
          session2Id,
          "r-100",
          "Server must remap reused sessionId to a unique value",
        );

        // Prime dedup state for R2's session
        browser.sendResize(800, 600);
        await r2.readMessage<ResizeMessage>();
        await r2.sendFrame({
          sessionId: "r-100",
          ops: [{ op: "text", str: "plot2-from-device2" }],
          device: { width: 800, height: 600 },
        });
        await browser.waitForType<FrameMessage>("frame");

        // Browser sends plotIndex=0 resize targeting "r-100" (device 1's sessionId).
        // Device 1 is dead.  The server should drop this resize.
        browser.sendResizeWithPlotIndex(640, 480, 0, "r-100");

        let receivedPlotIndexResize = false;
        try {
          const msg = await r2.readMessage<ResizeMessage>(2000);
          if (msg.type === "resize" && msg.plotIndex !== undefined) {
            receivedPlotIndexResize = true;
          }
        } catch {
          // Timeout — R2 didn't receive the resize.  Correct behavior.
        }

        assertEquals(
          receivedPlotIndexResize,
          false,
          "R device 2 must NOT receive plotIndex=0 resize targeting retired sessionId",
        );
      } finally {
        r2.close();
      }
    });
  } finally {
    browser.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});
