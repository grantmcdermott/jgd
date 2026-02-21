/**
 * E2E tests using the platform-default transport (Unix socket on Linux/macOS,
 * named pipe on Windows).
 *
 * Complements e2e_test.ts which forces TCP via { tcp: true }.
 */

import { assert } from "@std/assert";
import { delay } from "@std/async";
import { TestServer } from "../server/tests/helpers/server.ts";
import type {
  CloseMessage,
  FrameMessage,
} from "../server/tests/helpers/types.ts";
import { AutoMetricsBrowserClient } from "./helpers/auto_metrics_client.ts";
import { checkRAvailable, runR } from "./helpers/r_process.ts";

const rAvailable = await checkRAvailable();
const isWindows = Deno.build.os === "windows";

Deno.test({
  name: "E2E default transport: basic frame relay",
  ignore: !rAvailable,
  async fn(t) {
    // No { tcp: true } — uses Unix socket on POSIX, named pipe on Windows.
    const server = new TestServer();
    const browser = new AutoMetricsBrowserClient();

    try {
      await server.start();

      await t.step("server uses platform-default transport", () => {
        if (isWindows) {
          assert(
            server.socketPath.startsWith("npipe:///"),
            `Expected npipe:///..., got ${server.socketPath}`,
          );
        } else {
          assert(
            server.socketPath.endsWith(".sock"),
            `Expected *.sock, got ${server.socketPath}`,
          );
        }
      });

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
  name: "E2E default transport: device close",
  ignore: !rAvailable,
  async fn(t) {
    const server = new TestServer();
    const browser = new AutoMetricsBrowserClient();

    try {
      await server.start();
      await browser.connect(server.wsUrl);
      browser.sendResize(800, 600);
      await delay(200);

      await t.step("dev.off flushes frame and sends close message", async () => {
        const result = await runR(
          'jgd(width=8, height=6, dpi=96); plot.new(); rect(0, 0, 1, 1); dev.off()',
          server.socketPath,
        );
        if (!result.success) {
          throw new Error(`R failed (exit ${result.exitCode}): ${result.stderr}`);
        }

        await browser.waitForType<FrameMessage>("frame");
        const closeMsg = await browser.waitForType<CloseMessage>("close");
        assert(closeMsg.type === "close", "Expected close message");
      });
    } finally {
      browser.close();
      await delay(100);
      await server.shutdown();
      server.cleanup();
    }
  },
});
