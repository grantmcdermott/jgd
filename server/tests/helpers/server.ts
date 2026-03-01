import { dirname, fromFileUrl, join } from "@std/path";
import type { DiscoveryFile } from "./types.ts";
import { parseSocketUri, socketUri } from "../../socket_uri.ts";

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
  #stderrBuf: string[] = [];

  constructor(opts?: { tcp?: boolean }) {
    this.tmpDir = Deno.makeTempDirSync({ prefix: "jgd-test-" });
    this.useTcp = opts?.tcp ?? false;
    // TCP and named pipe (Windows default) paths are both auto-generated
    // by the server, so we parse them from server output.
    const needsOutputParsing = this.useTcp || Deno.build.os === "windows";
    const rawPath = join(this.tmpDir, `jgd-${crypto.randomUUID().slice(0, 8)}.sock`);
    this.socketPath = needsOutputParsing
      ? ""  // resolved after server starts
      : socketUri.unix(rawPath);
  }

  /** Start the server and wait for it to be ready (retries once on failure). */
  async start(): Promise<void> {
    try {
      await this.#tryStart();
    } catch {
      // Retry once after a brief pause — transient failures (e.g. resource
      // contention when many tests spawn servers in parallel) are resolved
      // by a single retry.
      await this.#killProcess();
      this.httpPort = 0;
      this.pid = 0;
      this.#stderrBuf.length = 0;
      await new Promise((r) => setTimeout(r, 250));
      await this.#tryStart();
    }
  }

  async #tryStart(): Promise<void> {
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
    } else if (this.socketPath) {
      // Unix socket mode only; on Windows socketPath is "" here
      // because the server auto-generates a named pipe.
      const addr = parseSocketUri(this.socketPath);
      if (addr.transport !== "unix") throw new Error(`Expected unix:///path URI, got: ${this.socketPath}`);
      serverArgs.push("-socket", addr.path);
    }
    serverArgs.push("-http", "127.0.0.1:0", "-v");

    const cmd = new Deno.Command(bin, {
      args: serverArgs,
      stdout: "piped",
      stderr: "piped",
      env: { TMPDIR: this.tmpDir, TEMP: this.tmpDir, TMP: this.tmpDir },
    });

    this.#process = cmd.spawn();

    // Drain stderr in the background, always capturing for diagnostics
    const stderrBuf = this.#stderrBuf;
    this.#stderrDone = this.#process.stderr
      .pipeTo(
        new WritableStream({
          write(chunk) {
            stderrBuf.push(new TextDecoder().decode(chunk));
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

    const timeout = AbortSignal.timeout(30_000);
    try {
      while (!timeout.aborted) {
        const { value, done } = await reader.read();
        if (done) {
          // Wait briefly for stderr to flush so we can include it
          await this.#stderrDone?.catch(() => {});
          const stderr = this.#stderrBuf.join("").trim();
          throw new Error(
            "Server exited before becoming ready" +
              (stderr ? `\nstderr:\n${stderr}` : ""),
          );
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

    const needsOutputParsing = this.useTcp || Deno.build.os === "windows";
    if (needsOutputParsing && !this.socketPath) {
      throw new Error("Failed to detect socket path from server output");
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

  /** Kill the current process and clean up streams (used for retry). */
  async #killProcess(): Promise<void> {
    if (!this.#process) return;
    try { this.#process.kill("SIGKILL"); } catch { /* already exited */ }
    try { await this.#process.status; } catch { /* ignore */ }
    await this.#cleanupStreams();
    this.#process = null;
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
