/**
 * R availability and socket helper functions for E2E tests.
 */

/**
 * Translate TestServer's socket path to R's socket address format.
 * TestServer reports TCP as "tcp:<port>" but R expects "tcp://127.0.0.1:<port>".
 */
export function toRSocketAddress(serverSocketPath: string): string {
  const tcpMatch = serverSocketPath.match(/^tcp:(\d+)$/);
  if (tcpMatch) {
    return `tcp://127.0.0.1:${tcpMatch[1]}`;
  }
  // npipe:////./pipe/NAME and Unix socket paths — pass through as-is
  // (R's transport.c understands both formats directly)
  return serverSocketPath;
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
