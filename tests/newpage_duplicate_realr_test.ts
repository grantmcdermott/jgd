/**
 * Reproduction test for plot duplication bug with real R.
 *
 * Root cause (suspected): R sends extra frames without proper newPage
 * tagging when creating new plots after the plotIndex/snapshot feature
 * was added. Each new plot causes the previous plot to appear
 * duplicated in the browser history.
 *
 * This test uses a real R process to verify:
 *  1. Creating 3 plots produces exactly 3 newPage frames.
 *  2. No extra untagged complete frames appear between new plots.
 *  3. The total frame count (excluding resize frames) matches plot count.
 */

import { assert, assertEquals } from "@std/assert";
import { delay } from "@std/async";
import { TestServer } from "../server/tests/helpers/server.ts";
import type { FrameMessage } from "../server/tests/helpers/types.ts";
import { AutoMetricsBrowserClient } from "./helpers/auto_metrics_client.ts";
import { checkRAvailable, startR } from "./helpers/r_process.ts";

const rAvailable = await checkRAvailable();

Deno.test({
  name: "Real R: three sequential plots must produce exactly 3 non-resize frames",
  ignore: !rAvailable,
  async fn() {
    const server = new TestServer({ tcp: true });
    const browser = new AutoMetricsBrowserClient();

    try {
      await server.start();
      await browser.connect(server.wsUrl);
      browser.sendResize(800, 600);
      await delay(200);

      // Three plots with a polling loop to keep R alive
      const r = startR(
        'jgd(width=8, height=6, dpi=96); plot(1:3); plot(4:6); plot(7:9); for (i in 1:200) { .Call(jgd:::C_jgd_poll_resize); Sys.sleep(0.05) }',
        server.socketPath,
      );

      try {
        // Collect all frames that arrive within a reasonable window.
        // We expect 3 newPage frames (one per plot) plus possibly
        // resize replay frames and incremental frames.
        const allFrames: FrameMessage[] = [];
        const deadline = Date.now() + 20_000;
        let plotCount = 0;

        while (Date.now() < deadline && plotCount < 3) {
          try {
            const frame = await browser.waitForType<FrameMessage>(
              "frame",
              5000,
            );
            allFrames.push(frame);
            if (frame.newPage) {
              plotCount++;
            }
          } catch {
            // Timeout — no more frames
            break;
          }
        }

        // Wait a bit for any trailing frames
        await delay(1000);

        // Try to read one more frame (should timeout if no extras)
        let extraFrame: FrameMessage | null = null;
        try {
          extraFrame = await browser.waitForType<FrameMessage>("frame", 1000);
          if (extraFrame) allFrames.push(extraFrame);
        } catch {
          // Expected: no extra frames
        }

        // Categorize frames
        const newPageFrames = allFrames.filter((f) => f.newPage === true);
        const resizeFrames = allFrames.filter((f) => f.resize === true);
        const incrementalFrames = allFrames.filter(
          (f) => f.incremental === true,
        );
        const untaggedFrames = allFrames.filter(
          (f) => !f.newPage && !f.resize && !f.incremental,
        );

        // Log frame details for debugging
        console.error(
          `\nFrame summary: total=${allFrames.length}, ` +
            `newPage=${newPageFrames.length}, resize=${resizeFrames.length}, ` +
            `incremental=${incrementalFrames.length}, untagged=${untaggedFrames.length}`,
        );
        for (let i = 0; i < allFrames.length; i++) {
          const f = allFrames[i];
          console.error(
            `  frame[${i}]: newPage=${f.newPage}, resize=${f.resize}, ` +
              `incremental=${f.incremental}, ops=${f.plot.ops.length}`,
          );
        }

        // 3 plots = 3 newPage frames
        assertEquals(
          newPageFrames.length,
          3,
          `Expected 3 newPage frames for 3 plots, got ${newPageFrames.length}`,
        );

        // No untagged complete frames (these would cause plot duplication)
        assertEquals(
          untaggedFrames.length,
          0,
          `Expected 0 untagged complete frames, got ${untaggedFrames.length} — ` +
            "these cause plot duplication in the browser",
        );

        // Each newPage frame should have ops
        for (let i = 0; i < newPageFrames.length; i++) {
          assert(
            newPageFrames[i].plot.ops.length > 0,
            `newPage frame ${i} should have ops`,
          );
        }
      } finally {
        r.kill();
        try {
          await r.process.output();
        } catch { /* ignore */ }
      }
    } finally {
      browser.close();
      await delay(100);
      await server.shutdown();
      server.cleanup();
    }
  },
});

Deno.test({
  name: "Real R: three sequential plots must produce exactly 3 non-resize frames (no poll_resize)",
  ignore: !rAvailable,
  async fn() {
    const server = new TestServer({ tcp: true });
    const browser = new AutoMetricsBrowserClient();

    try {
      await server.start();
      await browser.connect(server.wsUrl);
      browser.sendResize(800, 600);
      await delay(200);

      // Three plots WITHOUT a polling loop — simpler scenario.
      // R will exit after the plots, but the frames should arrive
      // before R terminates (R flushes on dev.off/close).
      const r = startR(
        'jgd(width=8, height=6, dpi=96); plot(1:3); plot(4:6); plot(7:9); Sys.sleep(2)',
        server.socketPath,
      );

      try {
        const allFrames: FrameMessage[] = [];
        const deadline = Date.now() + 15_000;
        let plotCount = 0;

        while (Date.now() < deadline && plotCount < 3) {
          try {
            const frame = await browser.waitForType<FrameMessage>(
              "frame",
              5000,
            );
            allFrames.push(frame);
            if (frame.newPage) {
              plotCount++;
            }
          } catch {
            break;
          }
        }

        // Wait for any trailing frames
        await delay(1000);
        try {
          const extra = await browser.waitForType<FrameMessage>("frame", 1000);
          if (extra) allFrames.push(extra);
        } catch {
          // Expected
        }

        const newPageFrames = allFrames.filter((f) => f.newPage === true);
        const untaggedFrames = allFrames.filter(
          (f) => !f.newPage && !f.resize && !f.incremental,
        );

        console.error(
          `\nFrame summary (no poll): total=${allFrames.length}, ` +
            `newPage=${newPageFrames.length}, untagged=${untaggedFrames.length}`,
        );
        for (let i = 0; i < allFrames.length; i++) {
          const f = allFrames[i];
          console.error(
            `  frame[${i}]: newPage=${f.newPage}, resize=${f.resize}, ` +
              `incremental=${f.incremental}, ops=${f.plot.ops.length}`,
          );
        }

        assertEquals(
          newPageFrames.length,
          3,
          `Expected 3 newPage frames, got ${newPageFrames.length}`,
        );

        assertEquals(
          untaggedFrames.length,
          0,
          `Untagged frames cause duplication: got ${untaggedFrames.length}`,
        );
      } finally {
        r.kill();
        try {
          await r.process.output();
        } catch { /* ignore */ }
      }
    } finally {
      browser.close();
      await delay(100);
      await server.shutdown();
      server.cleanup();
    }
  },
});
