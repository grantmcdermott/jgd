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
import { pollResize } from "./helpers/arf_poll.ts";
import { ArfSession, checkArfTestAvailable } from "./helpers/arf_session.ts";
import { toRSocketAddress } from "./helpers/r_process.ts";
import { testLog } from "./helpers/test_log.ts";

const arfTestAvailable = await checkArfTestAvailable();
const skip = !arfTestAvailable;

Deno.test({
  name:
    "Real R: three sequential plots must produce exactly 3 non-resize frames",
  ignore: skip,
  async fn() {
    testLog("test start");
    const server = new TestServer({ tcp: true });
    const browser = new AutoMetricsBrowserClient();
    const arf = new ArfSession();

    try {
      await server.start();
      await browser.connect(server.wsUrl);
      browser.sendResize(800, 600);
      await delay(100);

      await arf.start();
      const socketAddr = toRSocketAddress(server.socketPath);
      await arf.eval(
        `options(jgd.socket = "${socketAddr}"); library(jgd); jgd(width=8, height=6, dpi=96)`,
      );
      await arf.eval("plot(1:3); plot(4:6); plot(7:9)");
      await pollResize(arf, 120);

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
            2000,
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
      await delay(300);

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
      browser.close();
      await delay(100);
      await server.shutdown();
      server.cleanup();
      await arf.shutdown();
    }
  },
});

Deno.test({
  name:
    "Real R: three sequential plots must produce exactly 3 non-resize frames (no poll_resize)",
  ignore: skip,
  async fn() {
    testLog("test start");
    const server = new TestServer({ tcp: true });
    const browser = new AutoMetricsBrowserClient();
    const arf = new ArfSession();

    try {
      await server.start();
      await browser.connect(server.wsUrl);
      browser.sendResize(800, 600);
      await delay(100);

      await arf.start();
      const socketAddr = toRSocketAddress(server.socketPath);
      await arf.eval(
        `options(jgd.socket = "${socketAddr}"); library(jgd); jgd(width=8, height=6, dpi=96)`,
      );
      await arf.eval("plot(1:3); plot(4:6); plot(7:9)");

      const allFrames: FrameMessage[] = [];
      const deadline = Date.now() + 15_000;
      let plotCount = 0;

      while (Date.now() < deadline && plotCount < 3) {
        try {
          const frame = await browser.waitForType<FrameMessage>(
            "frame",
            2000,
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
      await delay(300);
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
      browser.close();
      await delay(100);
      await server.shutdown();
      server.cleanup();
      await arf.shutdown();
    }
  },
});
