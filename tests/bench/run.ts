#!/usr/bin/env -S deno run --allow-all
/**
 * Benchmark orchestrator for jgd plot rendering performance.
 *
 * Starts the server, connects a mock metrics client,
 * runs R benchmarks, and reports results.
 *
 * Usage:
 *   deno run --allow-all run.ts                  # run benchmarks
 *   deno run --allow-all run.ts --no-client      # run without mock client (timeout mode)
 */

import { dirname, fromFileUrl, join } from "@std/path";
import { parseArgs } from "@std/cli/parse-args";
import { TestServer } from "../../server/tests/helpers/server.ts";
import { MockMetricsClient } from "./mock-metrics-client.ts";
import { raceWithTimeout } from "./timeout.ts";
import { toRSocketAddress } from "../helpers/r_process.ts";

const scriptDir = dirname(fromFileUrl(import.meta.url));

const args = parseArgs(Deno.args, {
  boolean: ["no-client"],
  default: { "no-client": false },
});

const noClient = args["no-client"];
const timeoutRecoveryWaitMs = 3000;

function parseBenchTimeoutMs(): number {
  const raw = Deno.env.get("JGD_BENCH_TIMEOUT_MS");
  if (raw === undefined || raw.trim() === "") return 30000;

  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    const timeoutMs = Math.floor(parsed);
    if (timeoutMs >= 1) return timeoutMs;
  }

  throw new Error(
    `Invalid JGD_BENCH_TIMEOUT_MS="${raw}". Expected a positive number (milliseconds).`,
  );
}

function createStreamCollector(stream: ReadableStream<Uint8Array> | null) {
  let text = "";
  const decoder = new TextDecoder();
  const done = (async () => {
    if (!stream) return;
    const reader = stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.length > 200_000) text = text.slice(-200_000);
      }
      text += decoder.decode();
    } catch {
      // Best effort collection only.
    }
  })();
  return {
    done,
    snapshot: () => text,
  };
}

async function waitUpTo<T>(promise: Promise<T>, waitMs: number): Promise<void> {
  let timeoutId: number | undefined;
  await Promise.race([
    promise.then(() => undefined),
    new Promise<void>((resolve) => {
      timeoutId = setTimeout(resolve, waitMs);
    }),
  ]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
}

export async function settleTimeoutPath(
  timeoutCleanup: Promise<void>,
  collectors: Array<Promise<unknown>>,
  waitMs = timeoutRecoveryWaitMs,
): Promise<void> {
  await waitUpTo(timeoutCleanup, waitMs);
  await waitUpTo(Promise.all(collectors), waitMs);
}

async function main() {
  const benchTimeoutMs = parseBenchTimeoutMs();

  // --- Main ---
  console.log(`\n${"=".repeat(60)}`);
  console.log("  jgd Benchmark Suite");
  console.log(`${"=".repeat(60)}`);

  // Start server
  console.log("==> Starting server...");
  const server = new TestServer();
  await server.start();
  console.log(`    Socket: ${server.socketPath}`);
  console.log(`    HTTP:   ${server.httpBaseUrl}`);

  let client: MockMetricsClient | null = null;
  try {
    // Connect mock client
    if (!noClient) {
      console.log("==> Connecting mock metrics client...");
      client = new MockMetricsClient(server.wsUrl);
      await client.connect();
      await new Promise((r) => setTimeout(r, 500));
      console.log("    Connected");
    }

    // Run R benchmarks
    console.log("==> Running R benchmarks...");
    const benchScript = join(scriptDir, "bench-plot.R");
    const socketAddr = toRSocketAddress(server.socketPath);
    const rCmd = new Deno.Command("Rscript", {
      args: [benchScript],
      stdout: "piped",
      stderr: "piped",
      env: { ...Deno.env.toObject(), JGD_BENCH_SOCKET: socketAddr },
    });
    const rProc = rCmd.spawn();
    const stdoutCollector = createStreamCollector(rProc.stdout);
    const stderrCollector = createStreamCollector(rProc.stderr);
    let timeoutTriggered = false;
    let timeoutCleanup: Promise<void> | null = null;
    const killRProcess = async (): Promise<boolean> => {
      let killRequested = false;
      try {
        rProc.kill();
        killRequested = true;
      } catch {
        // Continue to platform-specific hard kill below.
      }
      if (Deno.build.os === "windows") {
        try {
          const result = await new Deno.Command("taskkill", {
            args: ["/PID", String(rProc.pid), "/T", "/F"],
            stdout: "null",
            stderr: "null",
          }).output();
          killRequested = killRequested || result.success;
        } catch {
          // Best effort only.
        }
      }
      return killRequested;
    };
    let rStatus: Deno.CommandStatus;
    try {
      rStatus = await raceWithTimeout(
        rProc.status,
        benchTimeoutMs,
        () => {
          timeoutTriggered = true;
          timeoutCleanup = (async () => {
            const killRequested = await killRProcess();
            const stdout = stdoutCollector.snapshot();
            const stderr = stderrCollector.snapshot();
            console.error(
              `R benchmark timed out after ${benchTimeoutMs}ms` +
                (killRequested ? " (kill requested)" : ""),
            );
            if (stdout.trim()) {
              console.error("\n--- Partial R stdout ---");
              console.error(stdout.trim().slice(-4000));
            }
            if (stderr.trim()) {
              console.error("\n--- Partial R stderr ---");
              console.error(stderr.trim().slice(-4000));
            }
          })();
          return timeoutCleanup;
        },
        `R benchmark timeout after ${benchTimeoutMs}ms`,
      );
    } catch (error) {
      if (timeoutTriggered && timeoutCleanup) {
        await settleTimeoutPath(timeoutCleanup, [
          stdoutCollector.done,
          stderrCollector.done,
        ]);
      }
      throw error;
    }
    await Promise.all([stdoutCollector.done, stderrCollector.done]);
    const stdout = stdoutCollector.snapshot();
    const stderr = stderrCollector.snapshot();

    if (!rStatus.success) {
      console.error(`R process exited with code ${rStatus.code}`);
      if (stderr.trim()) console.error(stderr.trim());
      throw new Error(`R process failed with code ${rStatus.code}`);
    }

    if (stderr.trim()) {
      console.log("\n--- R stderr ---");
      console.log(stderr.trim());
    }

    console.log("\n--- R output ---");
    console.log(stdout.trim());

    // Client stats
    if (client) {
      const stats = client.stats();
      console.log("\n=== Mock Client Stats ===");
      console.log(
        `  Metrics requests: ${stats.metricsRequests} (strWidth: ${stats.strWidthRequests}, metricInfo: ${stats.metricInfoRequests})`,
      );
      console.log(`  Frames received:  ${stats.framesReceived}`);
      console.log(`  Total ops:        ${stats.totalOps}`);
    }
  } finally {
    if (client) client.close();
    await server.shutdown();
    server.cleanup();
  }

  console.log("\n==> Done.");
}

if (import.meta.main) {
  await main();
}
