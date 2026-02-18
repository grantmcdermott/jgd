/**
 * End-to-end integration tests: real R jgd device → real Deno server → browser WebSocket client.
 */

import { assert, assertEquals } from "@std/assert";
import { delay } from "@std/async";
import { TestServer } from "../server/tests/helpers/server.ts";
import type {
  CloseMessage,
  FrameMessage,
} from "../server/tests/helpers/types.ts";
import { AutoMetricsBrowserClient } from "./helpers/auto_metrics_client.ts";
import { checkRAvailable, runR } from "./helpers/r_process.ts";

// Pre-check: skip all tests if R + jgd are not available
const rAvailable = await checkRAvailable();

Deno.test({
  name: "E2E: basic frame relay",
  ignore: !rAvailable,
  async fn(t) {
    const server = new TestServer({ tcp: true });
    const browser = new AutoMetricsBrowserClient();

    try {
      await server.start();
      await browser.connect(server.wsUrl);
      browser.sendResize(800, 600);
      await delay(200);

      await t.step("plot.new + rect produces frame with rect op", async () => {
        const result = await runR(
          'jgd(width=8, height=6, dpi=96); plot.new(); rect(0, 0, 1, 1); dev.off()',
          server.socketPath,
        );
        if (!result.success) {
          throw new Error(`R failed (exit ${result.exitCode}): ${result.stderr}`);
        }

        const frame = await browser.waitForType<FrameMessage>("frame");
        assert(frame.plot.ops.length > 0, "Frame should have ops");

        const ops = frame.plot.ops as Array<Record<string, unknown>>;
        const rectOps = ops.filter((op) => op.op === "rect");
        assert(rectOps.length > 0, "Frame should contain a rect op");

        // Wait for close message
        await browser.waitForType<CloseMessage>("close");
      });
    } finally {
      browser.close();
      await delay(100);
      await server.shutdown();
      server.cleanup();
    }
  },
});

Deno.test({
  name: "E2E: text metrics round-trip",
  ignore: !rAvailable,
  async fn(t) {
    const server = new TestServer({ tcp: true });
    const browser = new AutoMetricsBrowserClient();

    try {
      await server.start();
      await browser.connect(server.wsUrl);
      browser.sendResize(800, 600);
      await delay(200);

      await t.step("text() triggers metrics requests and produces text op", async () => {
        const result = await runR(
          'jgd(width=8, height=6, dpi=96); plot.new(); text(0.5, 0.5, "Hello"); dev.off()',
          server.socketPath,
        );
        if (!result.success) {
          throw new Error(`R failed (exit ${result.exitCode}): ${result.stderr}`);
        }

        const frame = await browser.waitForType<FrameMessage>("frame");
        assert(frame.plot.ops.length > 0, "Frame should have ops");

        const ops = frame.plot.ops as Array<Record<string, unknown>>;
        const textOps = ops.filter((op) => op.op === "text");
        assert(textOps.length > 0, "Frame should contain a text op");

        assert(
          browser.metricsRequests.length > 0,
          "Should have received metrics requests for text rendering",
        );

        await browser.waitForType<CloseMessage>("close");
      });
    } finally {
      browser.close();
      await delay(100);
      await server.shutdown();
      server.cleanup();
    }
  },
});

Deno.test({
  name: "E2E: realistic plot",
  ignore: !rAvailable,
  async fn(t) {
    const server = new TestServer({ tcp: true });
    const browser = new AutoMetricsBrowserClient();

    try {
      await server.start();
      await browser.connect(server.wsUrl);
      browser.sendResize(800, 600);
      await delay(200);

      await t.step("plot(1:5) produces frame with multiple op types", async () => {
        const result = await runR(
          'jgd(width=8, height=6, dpi=96); plot(1:5, 1:5, main="E2E"); dev.off()',
          server.socketPath,
        );
        if (!result.success) {
          throw new Error(`R failed (exit ${result.exitCode}): ${result.stderr}`);
        }

        const frame = await browser.waitForType<FrameMessage>("frame");
        const ops = frame.plot.ops as Array<Record<string, unknown>>;
        const opTypes = new Set(ops.map((op) => op.op));

        // A realistic plot should contain at least clip, line, and text ops
        assert(opTypes.has("clip"), "Plot should have clip ops");
        assert(opTypes.has("line"), "Plot should have line ops");
        assert(opTypes.has("text"), "Plot should have text ops");

        await browser.waitForType<CloseMessage>("close");
      });
    } finally {
      browser.close();
      await delay(100);
      await server.shutdown();
      server.cleanup();
    }
  },
});

Deno.test({
  name: "E2E: device dimensions",
  ignore: !rAvailable,
  async fn(t) {
    const server = new TestServer({ tcp: true });
    const browser = new AutoMetricsBrowserClient();

    try {
      await server.start();
      await browser.connect(server.wsUrl);
      browser.sendResize(800, 600);
      await delay(200);

      await t.step("custom device dimensions are reported in frame", async () => {
        const result = await runR(
          'jgd(width=5, height=4, dpi=72); plot.new(); rect(0, 0, 1, 1); dev.off()',
          server.socketPath,
        );
        if (!result.success) {
          throw new Error(`R failed (exit ${result.exitCode}): ${result.stderr}`);
        }

        const frame = await browser.waitForType<FrameMessage>("frame");
        const device = frame.plot.device as Record<string, number>;
        // Device dimensions are in pixels (width_inches * dpi)
        assertEquals(device.width, 5 * 72, "Device width should be 5in * 72dpi = 360px");
        assertEquals(device.height, 4 * 72, "Device height should be 4in * 72dpi = 288px");
        assertEquals(device.dpi, 72, "Device DPI should be 72");

        await browser.waitForType<CloseMessage>("close");
      });
    } finally {
      browser.close();
      await delay(100);
      await server.shutdown();
      server.cleanup();
    }
  },
});
