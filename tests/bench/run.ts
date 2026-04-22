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
import { toRSocketAddress } from "../helpers/r_process.ts";

const scriptDir = dirname(fromFileUrl(import.meta.url));

const args = parseArgs(Deno.args, {
  boolean: ["no-client"],
  default: { "no-client": false },
});

const noClient = args["no-client"];
const benchTimeoutMs = Number.parseInt(
  Deno.env.get("JGD_BENCH_TIMEOUT_MS") ?? "180000",
  10,
);

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
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    try {
      rProc.kill("SIGKILL");
    } catch {
      // Process already exited.
    }
  }, benchTimeoutMs);

  const rResult = await rProc.output();
  clearTimeout(timeoutId);
  const stdout = new TextDecoder().decode(rResult.stdout);
  const stderr = new TextDecoder().decode(rResult.stderr);

  if (!rResult.success) {
    if (timedOut) {
      console.error(
        `R benchmark timed out after ${benchTimeoutMs}ms (killed process)`,
      );
      if (stdout.trim()) {
        console.error("\n--- Partial R stdout ---");
        console.error(stdout.trim().slice(-4000));
      }
      if (stderr.trim()) {
        console.error("\n--- Partial R stderr ---");
        console.error(stderr.trim().slice(-4000));
      }
      throw new Error(`R benchmark timeout after ${benchTimeoutMs}ms`);
    }
    console.error(`R process exited with code ${rResult.code}`);
    if (stderr.trim()) console.error(stderr.trim());
    throw new Error(`R process failed with code ${rResult.code}`);
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
