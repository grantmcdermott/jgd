/**
 * Server protocol test: sessionId reuse across device instances.
 *
 * When R uses PID-based sessionId (e.g. "r-12345"), closing and
 * reopening the jgd device within the same R process reuses the
 * sessionId.  The browser's per-session PlotHistory merges plots
 * from both device instances under the same session key, allowing
 * the user to navigate to old plots.
 *
 * A plotIndex resize targeting the old plot reaches the NEW device
 * connection (because the server routes by sessionId), which has
 * different snapshots.  The new device renders its own plot at
 * the requested plotIndex, corrupting the browser's history.
 *
 * Fix: R should use a unique sessionId per device instance
 * (e.g. "r-<pid>-<counter>"), or the server should track connection
 * identity separately from sessionId.
 */

import { assertEquals } from "@std/assert";
import { TestServer } from "./helpers/server.ts";
import { RClient } from "./helpers/r_client.ts";
import { BrowserClient } from "./helpers/browser_client.ts";
import { delay } from "@std/async";
import type { FrameMessage, ResizeMessage } from "./helpers/types.ts";

Deno.test("sessionId reuse — plotIndex resize must not reach new device instance", async (t) => {
  const server = new TestServer();
  const browser = new BrowserClient();

  try {
    await server.start();
    await browser.connect(server.wsUrl);

    await t.step("reused sessionId causes plotIndex resize to reach wrong device", async () => {
      // --- R device instance 1 connects with sessionId "r-100" ---
      // In real R, sessionId is "r-<pid>", so same PID = same sessionId.
      const r1 = new RClient();
      await r1.connect(server.socketPath);
      await r1.waitForWelcome();

      // R1 sends a frame.  The server extracts sessionId from plot.sessionId
      // and renames the session from "conn-N" to "r-100".
      await r1.sendFrame({
        sessionId: "r-100",
        ops: [{ op: "text", str: "plot1-from-device1" }],
        device: { width: 800, height: 600 },
      });
      await browser.waitForType<FrameMessage>("frame");

      // --- R device instance 1 closes (dev.off() in R) ---
      r1.close();
      await delay(300);

      // --- R device instance 2 connects with SAME sessionId "r-100" ---
      // This happens when user does dev.off() + jgd() in the same R process.
      const r2 = new RClient();
      try {
        await r2.connect(server.socketPath);
        await r2.waitForWelcome();

        // R2 sends a frame with the same sessionId.
        // Server renames this connection to "r-100" as well.
        // Browser adds this plot to the SAME session "r-100" in PlotHistory:
        //   session "r-100": [plot1-from-device1, plot2-from-device2]
        await r2.sendFrame({
          sessionId: "r-100",
          ops: [{ op: "text", str: "plot2-from-device2" }],
          device: { width: 800, height: 600 },
        });
        await browser.waitForType<FrameMessage>("frame");

        // Prime dedup state for the new session
        browser.sendResize(800, 600);
        await r2.readMessage<ResizeMessage>();
        await r2.sendFrame({
          sessionId: "r-100",
          ops: [{ op: "text", str: "plot2-from-device2" }],
          device: { width: 800, height: 600 },
        });
        await browser.waitForType<FrameMessage>("frame");

        // --- Browser sends plotIndex=0 resize targeting plot 1 ---
        // The browser thinks both plots are from the same session "r-100"
        // and sends sessionId="r-100" with the resize.
        // Plot 1 was drawn by device instance 1 (dead).
        browser.sendResizeWithPlotIndex(640, 480, 0, "r-100");

        // Expected: The resize should be dropped because device instance 1
        // is dead and device instance 2 doesn't have plot 1's snapshot.
        //
        // Actual (BUG): Device instance 2 receives the resize because the
        // server matches sessionId "r-100" to the alive connection.
        // Device 2 renders its own snapshot at plotIndex=0 (which is
        // device 2's first plot), corrupting the browser's history.
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
          "R device 2 must NOT receive plotIndex=0 resize. " +
            "plotIndex=0 targets plot 1 drawn by device 1 (dead). " +
            "Device 2 reuses sessionId 'r-100', so the server " +
            "incorrectly routes the resize to the wrong device instance.",
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
