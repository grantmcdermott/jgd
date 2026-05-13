/**
 * arf headless session manager for E2E tests.
 *
 * Wraps `arf headless` + `arf ipc eval/shutdown` to enable step-by-step
 * R command injection between browser interactions.
 */
import { checkRAvailable } from "./r_process.ts";

export interface ArfEvalResult {
  stdout: string | null;
  stderr: string | null;
  value: string | null;
  error: string | null;
}

export class ArfSession {
  #process: Deno.ChildProcess | null = null;
  #pid: number | null = null;

  /**
   * Start an arf headless session and wait until R is ready for IPC.
   *
   * @param opts.timeoutMs Startup timeout in ms (default: 30000)
   * @param opts.logFile   Path for arf log output (default: OS temp file)
   */
  async start(
    opts: { timeoutMs?: number; logFile?: string } = {},
  ): Promise<void> {
    const { timeoutMs = 30_000 } = opts;
    const logFile = opts.logFile ??
      await Deno.makeTempFile({ prefix: "arf-", suffix: ".log" });

    const cmd = new Deno.Command("arf", {
      args: ["headless", "--json", "--log-file", logFile],
      stdout: "piped",
      stderr: "null",
    });

    this.#process = cmd.spawn();

    let timeoutId: number | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () =>
          reject(
            new Error(`arf headless startup timed out after ${timeoutMs}ms`),
          ),
        timeoutMs,
      );
    });

    try {
      await Promise.race([this.#readReadyJson(), timeout]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  async #readReadyJson(): Promise<void> {
    const reader = this.#process!.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          throw new Error("arf headless exited before printing ready JSON");
        }
        buffer += decoder.decode(value, { stream: true });
        const nl = buffer.indexOf("\n");
        if (nl !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) {
            const info = JSON.parse(line) as { pid: number };
            this.#pid = info.pid;
            return;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Evaluate R code in the session.
   *
   * R evaluation errors are returned in `result.error` (exit code 0).
   * Throws only on IPC/transport failures (non-zero exit code).
   *
   * @param code      R code to evaluate
   * @param timeoutMs IPC response timeout in ms (default: 30000)
   */
  async eval(code: string, timeoutMs = 30_000): Promise<ArfEvalResult> {
    if (this.#pid === null) throw new Error("ArfSession not started");

    const cmd = new Deno.Command("arf", {
      args: [
        "ipc",
        "eval",
        "--pid",
        String(this.#pid),
        "--timeout",
        String(timeoutMs),
        code,
      ],
      stdout: "piped",
      stderr: "piped",
    });

    const output = await cmd.output();
    if (!output.success) {
      const stderr = new TextDecoder().decode(output.stderr);
      throw new Error(`arf ipc eval failed (exit ${output.code}): ${stderr}`);
    }

    return JSON.parse(new TextDecoder().decode(output.stdout)) as ArfEvalResult;
  }

  /**
   * Shut down the arf session gracefully, with SIGKILL fallback after 5s.
   */
  async shutdown(): Promise<void> {
    const pid = this.#pid;
    const process = this.#process;
    this.#pid = null;
    this.#process = null;

    if (process === null) return;

    if (pid !== null) {
      try {
        await new Deno.Command("arf", {
          args: ["ipc", "shutdown", "--pid", String(pid)],
          stdout: "null",
          stderr: "null",
        }).output();
      } catch {
        // ignore — fallback kill below
      }
    }

    const timeoutId = setTimeout(() => {
      try {
        process.kill("SIGKILL");
      } catch { /* already exited */ }
    }, 5_000);

    try {
      await process.status;
    } catch {
      // ignore
    } finally {
      clearTimeout(timeoutId);
      try {
        await process.stdout.cancel();
      } catch {
        // already closed
      }
    }
  }

  /** Return true if the `arf` binary is available on this system. */
  static async isAvailable(): Promise<boolean> {
    try {
      const output = await new Deno.Command("arf", {
        args: ["--version"],
        stdout: "null",
        stderr: "null",
      }).output();
      return output.success;
    } catch {
      return false;
    }
  }
}

/**
 * Convenience wrapper for use with `ignore: !arfTestAvailable` in Deno.test.
 */
export async function checkArfAvailable(): Promise<boolean> {
  return ArfSession.isAvailable();
}

/** True when tests can run via arf (arf binary + R + jgd package available). */
export async function checkArfTestAvailable(): Promise<boolean> {
  return await checkArfAvailable() && await checkRAvailable();
}
