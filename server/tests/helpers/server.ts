import { dirname, fromFileUrl, join } from "@std/path";
import type { DiscoveryFile } from "./types.ts";

/**
 * Manages a jgd server process for testing.
 * Each instance gets its own socket, HTTP port, and TMPDIR.
 */
export class TestServer {
  socketPath: string;
  readonly tmpDir: string;
  readonly useTcp: boolean;

  httpPort = 0;
  pid = 0;

  #process: Deno.ChildProcess | null = null;
  #stdout: ReadableStream<string> | null = null;
  #stderrDone: Promise<void> | null = null;

  constructor(opts?: { tcp?: boolean }) {
    this.tmpDir = Deno.makeTempDirSync({ prefix: "jgd-test-" });
    this.useTcp = opts?.tcp ?? (Deno.build.os === "windows");
    this.socketPath = this.useTcp
      ? ""  // resolved after server starts
      : join(this.tmpDir, `jgd-${crypto.randomUUID().slice(0, 8)}.sock`);
  }

  /** Start the server and wait for it to be ready. */
  async start(): Promise<void> {
    const binEnv = Deno.env.get("JGD_TEST_SERVER_BIN");
    let bin: string;
    let prefixArgs: string[];
    if (binEnv) {
      const parts = binEnv.trim().split(/\s+/);
      if (!parts[0]) {
        throw new Error("JGD_TEST_SERVER_BIN is set but empty");
      }
      bin = parts[0];
      prefixArgs = parts.slice(1);
    } else {
      // When no explicit binary, run via deno
      bin = "deno";
      prefixArgs = [
        "run",
        "--allow-net=127.0.0.1",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        join(dirname(fromFileUrl(import.meta.url)), "..", "..", "main.ts"),
      ];
    }

    const serverArgs = [...prefixArgs];
    if (this.useTcp) {
      serverArgs.push("-tcp", "0");
    } else {
      serverArgs.push("-socket", this.socketPath);
    }
    serverArgs.push("-http", "127.0.0.1:0", "-v");

    const cmd = new Deno.Command(bin, {
      args: serverArgs,
      stdout: "piped",
      stderr: "piped",
      env: { TMPDIR: this.tmpDir, TEMP: this.tmpDir, TMP: this.tmpDir },
    });

    this.#process = cmd.spawn();

    // Drain stderr in the background (avoid blocking)
    this.#stderrDone = this.#process.stderr
      .pipeTo(
        new WritableStream({
          write(chunk) {
            if (Deno.env.get("JGD_TEST_VERBOSE")) {
              Deno.stderr.writeSync(chunk);
            }
          },
        }),
      )
      .catch(() => {});

    // Read stdout line by line looking for the ready sentinel
    this.#stdout = this.#process.stdout.pipeThrough(new TextDecoderStream());

    const reader = this.#stdout.getReader();
    let buffer = "";

    const timeout = AbortSignal.timeout(10_000);
    try {
      while (!timeout.aborted) {
        const { value, done } = await reader.read();
        if (done) {
          throw new Error("Server exited before becoming ready");
        }
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop()!;

        for (const line of lines) {
          if (line.startsWith("jgd server ready")) {
            continue;
          }
          // Parse R socket path (needed for TCP mode where port is auto-assigned)
          const socketMatch = line.match(/R socket:\s+(.+)/);
          if (socketMatch) {
            this.socketPath = socketMatch[1].trim();
          }
          const httpMatch = line.match(
            /HTTP:\s+http:\/\/127\.0\.0\.1:(\d+)/,
          );
          if (httpMatch) {
            this.httpPort = parseInt(httpMatch[1], 10);
          }
        }

        if (this.httpPort > 0) {
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (this.httpPort === 0) {
      throw new Error("Failed to detect HTTP port from server output");
    }

    this.pid = this.#process.pid;
  }

  get httpBaseUrl(): string {
    return `http://127.0.0.1:${this.httpPort}`;
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${this.httpPort}/ws`;
  }

  /** Read the discovery file written by the server. */
  async readDiscovery(): Promise<DiscoveryFile> {
    const path = join(this.tmpDir, "jgd-discovery.json");
    const text = await Deno.readTextFile(path);
    return JSON.parse(text);
  }

  /**
   * Send SIGTERM and wait for exit. Falls back to SIGKILL after timeout.
   * Returns true if the process exited gracefully (not force-killed).
   *
   * On Windows, SIGTERM maps to TerminateProcess (immediate kill) so the
   * server's cleanup handlers don't run — always returns false.
   */
  async shutdown(): Promise<boolean> {
    if (!this.#process) return true;

    try {
      this.#process.kill("SIGTERM");
    } catch {
      // Process may have already exited
      await this.#cleanupStreams();
      return true;
    }

    // On Windows, SIGTERM terminates immediately — no graceful cleanup.
    if (Deno.build.os === "windows") {
      await this.#process.status;
      await this.#cleanupStreams();
      return false;
    }

    let forceKilled = false;
    const timeoutId = setTimeout(() => {
      forceKilled = true;
      try {
        this.#process!.kill("SIGKILL");
      } catch {
        // Already exited
      }
    }, 10_000);

    try {
      await this.#process.status;
      return !forceKilled;
    } finally {
      clearTimeout(timeoutId);
      await this.#cleanupStreams();
    }
  }

  /** Cancel stdout and wait for stderr pipe to finish. */
  async #cleanupStreams(): Promise<void> {
    try { await this.#stdout?.cancel(); } catch { /* ignore */ }
    this.#stdout = null;
    try { await this.#stderrDone; } catch { /* ignore */ }
    this.#stderrDone = null;
  }

  /** Clean up temp files. */
  cleanup(): void {
    try {
      Deno.removeSync(this.tmpDir, { recursive: true });
    } catch {
      // Best effort
    }
  }
}
