/**
 * R subprocess manager for E2E tests.
 * Spawns Rscript with plotting commands that use the real jgd device.
 */

export interface RProcessResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Translate TestServer's socket path to R's socket address format.
 * TestServer reports TCP as "tcp:<port>" but R expects "tcp://127.0.0.1:<port>".
 */
export function toRSocketAddress(serverSocketPath: string): string {
  const tcpMatch = serverSocketPath.match(/^tcp:(\d+)$/);
  if (tcpMatch) {
    return `tcp://127.0.0.1:${tcpMatch[1]}`;
  }
  // npipe:///NAME and Unix socket paths — pass through as-is
  // (R's transport.c understands both formats directly)
  return serverSocketPath;
}

/**
 * Run an R expression that uses jgd() to produce plots.
 *
 * @param rCode R code to execute (will be wrapped in appropriate setup)
 * @param serverSocketPath Socket path from TestServer (e.g. "tcp:12345" or "/tmp/jgd.sock")
 * @param timeoutMs Maximum time to wait for R process (default 30s)
 */
export async function runR(
  rCode: string,
  serverSocketPath: string,
  timeoutMs = 30_000,
): Promise<RProcessResult> {
  const socketAddr = toRSocketAddress(serverSocketPath);

  // Build the full R expression: load jgd, set socket, run user code
  const fullCode = `options(jgd.socket = "${socketAddr}"); library(jgd); ${rCode}`;

  const cmd = new Deno.Command("Rscript", {
    args: ["-e", fullCode],
    stdout: "piped",
    stderr: "piped",
  });

  const process = cmd.spawn();

  // Timeout with SIGKILL fallback
  const timeoutId = setTimeout(() => {
    try {
      process.kill("SIGKILL");
    } catch {
      // Already exited
    }
  }, timeoutMs);

  try {
    const output = await process.output();
    const decoder = new TextDecoder();
    return {
      success: output.success,
      exitCode: output.code,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Check if Rscript is available and the jgd package is installed. */
export async function checkRAvailable(): Promise<boolean> {
  try {
    const cmd = new Deno.Command("Rscript", {
      args: ["-e", 'library(jgd); cat("ok")'],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    const stdout = new TextDecoder().decode(output.stdout);
    return output.success && stdout.includes("ok");
  } catch {
    return false;
  }
}
