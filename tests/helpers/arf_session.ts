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
  #tempLogFile: string | null = null;

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
    this.#tempLogFile = opts.logFile ? null : logFile;

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
    } catch (error) {
      // If startup fails after spawn (timeout/invalid ready JSON), ensure
      // the child is torn down so it cannot leak into later tests.
      await this.shutdown();
      throw error;
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
   * By default, throws on both IPC failures and R evaluation errors.
   * Set opts.throwOnRError=false to inspect result.error manually.
   *
   * @param code      R code to evaluate
   * @param timeoutMs IPC response timeout in ms (default: 30000)
   */
  async eval(
    code: string,
    timeoutMs = 30_000,
    opts: { throwOnRError?: boolean } = {},
  ): Promise<ArfEvalResult> {
    const { throwOnRError = true } = opts;
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

    const result = JSON.parse(
      new TextDecoder().decode(output.stdout),
    ) as ArfEvalResult;
    if (throwOnRError && result.error !== null) {
      throw new Error(`R eval failed: ${result.error}`);
    }
    return result;
  }

  /**
   * Shut down the arf session gracefully, with SIGKILL fallback after 5s.
   */
  async shutdown(): Promise<void> {
    const pid = this.#pid;
    const process = this.#process;
    const tempLogFile = this.#tempLogFile;
    this.#pid = null;
    this.#process = null;
    this.#tempLogFile = null;

    if (process === null) {
      if (tempLogFile !== null) {
        try {
          await Deno.remove(tempLogFile);
        } catch {
          // already removed or inaccessible
        }
      }
      return;
    }

    const timeoutId = setTimeout(() => {
      try {
        process.kill("SIGKILL");
      } catch { /* already exited */ }
    }, 5_000);

    try {
      if (pid !== null) {
        try {
          await new Deno.Command("arf", {
            args: ["ipc", "shutdown", "--pid", String(pid)],
            stdout: "null",
            stderr: "null",
          }).output();
        } catch {
          // ignore — fallback kill above
        }
      }
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
      if (tempLogFile !== null) {
        try {
          await Deno.remove(tempLogFile);
        } catch {
          // already removed or inaccessible
        }
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
  if (!await ArfSession.isAvailable()) return false;
  try {
    const output = await new Deno.Command("arf", {
      args: ["--version"],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!output.success) return false;
    const versionText = new TextDecoder().decode(output.stdout);
    const match = versionText.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) return false;
    const [major, minor, patch] = match.slice(1).map((x) => Number(x));
    if (major > 0) return true;
    if (minor > 3) return true;
    return minor === 3 && patch >= 0;
  } catch {
    return false;
  }
}

/** True when tests can run via arf (arf binary + R + jgd package available). */
export async function checkArfTestAvailable(): Promise<boolean> {
  return await checkArfAvailable() && await checkRAvailable();
}
