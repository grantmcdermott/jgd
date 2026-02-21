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

const scriptDir = dirname(fromFileUrl(import.meta.url));

const args = parseArgs(Deno.args, {
  boolean: ["no-client"],
  default: { "no-client": false },
});

const noClient = args["no-client"];

/**
 * Translate TestServer's socket path to R's socket address format.
 * TestServer reports TCP as "tcp:<port>" but R expects "tcp://127.0.0.1:<port>".
 */
function toRSocketAddress(serverSocketPath: string): string {
  const tcpMatch = serverSocketPath.match(/^tcp:(\d+)$/);
  if (tcpMatch) {
    return `tcp://127.0.0.1:${tcpMatch[1]}`;
  }
  return serverSocketPath;
}

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

// Connect mock client
let client: MockMetricsClient | null = null;
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
  args: ["-e", `options(jgd.socket = "${socketAddr}"); source("${benchScript}")`],
  stdout: "piped",
  stderr: "piped",
});

const rResult = await rCmd.output();
const stdout = new TextDecoder().decode(rResult.stdout);
const stderr = new TextDecoder().decode(rResult.stderr);

if (!rResult.success) {
  console.error(`R process exited with code ${rResult.code}`);
  if (stderr.trim()) console.error(stderr.trim());
  await server.shutdown();
  server.cleanup();
  Deno.exit(1);
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
  client.close();
}

// Cleanup
await server.shutdown();
server.cleanup();

console.log("\n==> Done.");
