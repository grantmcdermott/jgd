/**
 * Reproduction test for plot duplication after resize.
 *
 * Tests the scenario that occurs in manual testing:
 * 1. Browser sends resize after connecting
 * 2. R creates plot 1 → frame with newPage:true
 * 3. R processes resize → replay frame (tagged resize:true)
 * 4. R creates plot 2 → should produce exactly 1 newPage frame
 *
 * The bug: after the resize replay in step 3, creating plot 2
 * causes the previous plot to be duplicated (extra untagged frame).
 */

import { assert, assertEquals } from "@std/assert";
import { delay } from "@std/async";
import { TestServer } from "../server/tests/helpers/server.ts";
import type { FrameMessage } from "../server/tests/helpers/types.ts";
import { AutoMetricsBrowserClient } from "./helpers/auto_metrics_client.ts";
import { ArfSession, checkArfTestAvailable } from "./helpers/arf_session.ts";
import { toRSocketAddress } from "./helpers/r_process.ts";

const arfTestAvailable = await checkArfTestAvailable();
const skip = !arfTestAvailable;

Deno.test({
  name: "Real R: resize between plots must not cause duplication",
  ignore: skip,
  async fn() {
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

      await arf.eval(`options(jgd.socket = "${socketAddr}"); library(jgd)`);
      await arf.eval("jgd(width=8, height=6, dpi=96)");
      await arf.eval("plot(1:3)");

      // Wait for plot 1
      const frame1 = await browser.waitForType<FrameMessage>("frame", 8000);
      assert(frame1.plot.ops.length > 0, "Plot 1 should have ops");
      console.error(
        `frame1: newPage=${frame1.newPage}, resize=${frame1.resize}, ` +
          `incremental=${frame1.incremental}, ops=${frame1.plot.ops.length}`,
      );

      // Send a resize with DIFFERENT dimensions to trigger a replay
      browser.sendResize(640, 480);
      await delay(100);
      await arf.eval(".Call(jgd:::C_jgd_poll_resize)");

      // Collect all frames until we get 3 newPage frames
      const allFrames: FrameMessage[] = [frame1];
      const deadline = Date.now() + 20_000;
      let plotCount = frame1.newPage ? 1 : 0;

      // Collect resize frame first
      while (Date.now() < deadline) {
        try {
          const frame = await browser.waitForType<FrameMessage>("frame", 2000);
          allFrames.push(frame);
          if (frame.newPage) plotCount++;
          console.error(
            `frame[${allFrames.length - 1}]: newPage=${frame.newPage}, ` +
              `resize=${frame.resize}, incremental=${frame.incremental}, ` +
              `ops=${frame.plot.ops.length}`,
          );
          if (frame.resize) break; // got resize frame, now draw plot 2
        } catch {
          break;
        }
      }

      await arf.eval("plot(4:6)");

      while (Date.now() < deadline && plotCount < 2) {
        try {
          const frame = await browser.waitForType<FrameMessage>("frame", 2000);
          allFrames.push(frame);
          if (frame.newPage) plotCount++;
          console.error(
            `frame[${allFrames.length - 1}]: newPage=${frame.newPage}, ` +
              `resize=${frame.resize}, incremental=${frame.incremental}, ` +
              `ops=${frame.plot.ops.length}`,
          );
        } catch {
          break;
        }
      }

      await arf.eval("plot(7:9)");

      while (Date.now() < deadline && plotCount < 3) {
        try {
          const frame = await browser.waitForType<FrameMessage>("frame", 2000);
          allFrames.push(frame);
          if (frame.newPage) plotCount++;
          console.error(
            `frame[${allFrames.length - 1}]: newPage=${frame.newPage}, ` +
              `resize=${frame.resize}, incremental=${frame.incremental}, ` +
              `ops=${frame.plot.ops.length}`,
          );
        } catch {
          break;
        }
      }

      // Wait for trailing frames
      await delay(300);
      try {
        const extra = await browser.waitForType<FrameMessage>("frame", 1000);
        allFrames.push(extra);
        console.error(
          `extra frame: newPage=${extra.newPage}, resize=${extra.resize}, ` +
            `incremental=${extra.incremental}, ops=${extra.plot.ops.length}`,
        );
      } catch {
        // Expected
      }

      // Categorize
      const newPageFrames = allFrames.filter((f) => f.newPage === true);
      const resizeFrames = allFrames.filter((f) => f.resize === true);
      const incrementalFrames = allFrames.filter(
        (f) => f.incremental === true,
      );
      const untaggedFrames = allFrames.filter(
        (f) => !f.newPage && !f.resize && !f.incremental,
      );

      console.error(
        `\nSummary: total=${allFrames.length}, newPage=${newPageFrames.length}, ` +
          `resize=${resizeFrames.length}, incremental=${incrementalFrames.length}, ` +
          `untagged=${untaggedFrames.length}`,
      );

      // Must have exactly 3 newPage frames
      assertEquals(
        newPageFrames.length,
        3,
        `Expected 3 newPage frames, got ${newPageFrames.length}`,
      );

      // Should have at least 1 resize frame (from our explicit resize)
      assert(
        resizeFrames.length >= 1,
        `Expected at least 1 resize frame, got ${resizeFrames.length}`,
      );

      // No untagged complete frames
      assertEquals(
        untaggedFrames.length,
        0,
        `Untagged complete frames cause duplication: got ${untaggedFrames.length}`,
      );
    } finally {
      browser.close();
      await delay(100);
      await arf.shutdown();
      await server.shutdown();
      server.cleanup();
    }
  },
});

Deno.test({
  name:
    "Real R: resize between each plot must not cause cumulative duplication",
  ignore: skip,
  async fn() {
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

      await arf.eval(`options(jgd.socket = "${socketAddr}"); library(jgd)`);
      await arf.eval("jgd(width=8, height=6, dpi=96)");
      await arf.eval("plot(1:3)");

      // Wait for plot 1
      const f1 = await browser.waitForType<FrameMessage>("frame", 8000);
      assertEquals(f1.newPage, true, "First frame must be newPage");

      // Send resize after plot 1
      browser.sendResize(640, 480);
      await delay(100);
      await arf.eval(".Call(jgd:::C_jgd_poll_resize)");

      // Wait for resize frame
      let gotResize1 = false;
      const postPlot1Frames: FrameMessage[] = [];
      for (let i = 0; i < 5; i++) {
        try {
          const f = await browser.waitForType<FrameMessage>("frame", 1500);
          postPlot1Frames.push(f);
          if (f.resize) {
            gotResize1 = true;
            break;
          }
          if (f.newPage) break; // plot 2 arrived before resize
        } catch {
          break;
        }
      }
      assert(gotResize1, "Should receive resize frame after plot 1");

      // Count untagged frames between plot 1 and resize
      const untaggedBetween = postPlot1Frames.filter(
        (f) => !f.newPage && !f.resize && !f.incremental,
      );
      assertEquals(
        untaggedBetween.length,
        0,
        `No untagged frames should appear between plot 1 and plot 2, ` +
          `got ${untaggedBetween.length}`,
      );

      await arf.eval("plot(4:6)");

      // Wait for plot 2
      const f2 = await browser.waitForType<FrameMessage>("frame", 6000);
      assertEquals(f2.newPage, true, "Plot 2 frame must have newPage");

      // Send resize after plot 2
      browser.sendResize(700, 500);
      await delay(100);
      await arf.eval(".Call(jgd:::C_jgd_poll_resize)");

      // Wait for resize frame
      let gotResize2 = false;
      const postPlot2Frames: FrameMessage[] = [];
      for (let i = 0; i < 5; i++) {
        try {
          const f = await browser.waitForType<FrameMessage>("frame", 1500);
          postPlot2Frames.push(f);
          if (f.resize) {
            gotResize2 = true;
            break;
          }
          if (f.newPage) break;
        } catch {
          break;
        }
      }
      assert(gotResize2, "Should receive resize frame after plot 2");

      // Count untagged frames between plot 2 and resize
      const untaggedBetween2 = postPlot2Frames.filter(
        (f) => !f.newPage && !f.resize && !f.incremental,
      );
      assertEquals(
        untaggedBetween2.length,
        0,
        `No untagged frames should appear between plot 2 and plot 3, ` +
          `got ${untaggedBetween2.length}`,
      );

      await arf.eval("plot(7:9)");

      // Wait for plot 3
      const f3 = await browser.waitForType<FrameMessage>("frame", 6000);
      assertEquals(f3.newPage, true, "Plot 3 frame must have newPage");
    } finally {
      browser.close();
      await delay(100);
      await arf.shutdown();
      await server.shutdown();
      server.cleanup();
    }
  },
});
