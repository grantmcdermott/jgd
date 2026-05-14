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
  #starting = false;
  #process: Deno.ChildProcess | null = null;
  #pid: number | null = null;
  #tempLogFile: string | null = null;
  #startupId = 0;

  /**
   * Start an arf headless session and wait until R is ready for IPC.
   *
   * @param opts.timeoutMs Startup timeout in ms (default: 30000)
   * @param opts.logFile   Path for arf log output (default: OS temp file)
   */
  async start(
    opts: { timeoutMs?: number; logFile?: string } = {},
  ): Promise<void> {
    if (this.#starting || this.#process !== null || this.#pid !== null) {
      throw new Error("ArfSession already started");
    }
    this.#starting = true;

    try {
      const { timeoutMs = 30_000 } = opts;
      const logFile = opts.logFile ??
        await Deno.makeTempFile({ prefix: "arf-", suffix: ".log" });
      const tempLogFile = opts.logFile ? null : logFile;
      this.#tempLogFile = tempLogFile;

      const cmd = new Deno.Command("arf", {
        args: ["headless", "--json", "--log-file", logFile],
        stdout: "piped",
        stderr: "null",
      });

      let process: Deno.ChildProcess;
      try {
        process = cmd.spawn();
      } catch (error) {
        await this.#removeTempLogFile();
        throw error;
      }

      this.#process = process;
      const startupId = ++this.#startupId;

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
        await Promise.race([this.#readReadyJson(process, startupId), timeout]);
      } catch (error) {
        // If startup fails after spawn (timeout/invalid ready JSON), ensure
        // the child is torn down so it cannot leak into later tests.
        await this.#cleanupStartupProcess(process, tempLogFile);
        throw error;
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    } finally {
      this.#starting = false;
    }
  }

  async #readReadyJson(
    process: Deno.ChildProcess,
    startupId: number,
  ): Promise<void> {
    const reader = process.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          throw new Error("arf headless exited before printing ready JSON");
        }
        buffer += decoder.decode(value, { stream: true });
        // Drain every complete line in this chunk before reading again — a
        // single read() can return a blank line and the ready JSON together,
        // and pausing for another read after only the blank would hang.
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const info = JSON.parse(line) as { pid: number };
          if (this.#process !== process || this.#startupId !== startupId) {
            throw new Error("arf headless startup was aborted");
          }
          if (!Number.isFinite(info.pid)) {
            throw new Error(
              `arf headless ready JSON did not contain a numeric pid: ${line}`,
            );
          }
          this.#pid = info.pid;
          return;
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
    this.#starting = false;
    this.#startupId++;

    if (process === null) {
      if (tempLogFile !== null) {
        await this.#removeLogFile(tempLogFile);
      }
      return;
    }

    const timeoutId = setTimeout(() => {
      try {
        process.kill("SIGKILL");
      } catch { /* already exited */ }
    }, 5_000);

    if (pid !== null) {
      try {
        await this.#shutdownByIpc(pid, 5_000);
      } catch {
        // IPC shutdown could not even be initiated (e.g. `arf` binary
        // missing). Kill the headless process directly so it does not
        // outlive this call when the SIGKILL fallback is cleared below.
        try {
          process.kill("SIGKILL");
        } catch { /* already exited */ }
      }
    }

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
      if (tempLogFile !== null) {
        await this.#removeLogFile(tempLogFile);
      }
    }
  }

  async #shutdownByIpc(pid: number, timeoutMs: number): Promise<void> {
    const shutdown = new Deno.Command("arf", {
      args: ["ipc", "shutdown", "--pid", String(pid)],
      stdout: "null",
      stderr: "null",
    }).spawn();

    let timeoutId: number | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        try {
          shutdown.kill("SIGKILL");
        } catch { /* already exited */ }
        reject(
          new Error(`arf ipc shutdown timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);
    });

    try {
      await Promise.race([shutdown.status, timeout]);
    } catch {
      // ignore — headless process fallback kill is handled by shutdown()
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      try {
        await shutdown.status;
      } catch {
        // already reaped or unavailable
      }
    }
  }

  async #cleanupStartupProcess(
    process: Deno.ChildProcess,
    tempLogFile: string | null,
  ): Promise<void> {
    if (this.#process === process) {
      this.#pid = null;
      this.#process = null;
      this.#tempLogFile = null;
      this.#startupId++;
    }

    try {
      process.kill("SIGKILL");
    } catch {
      // already exited
    }
    try {
      await process.status;
    } catch {
      // ignore
    }
    try {
      await process.stdout.cancel();
    } catch {
      // already closed
    }
    if (tempLogFile !== null) await this.#removeLogFile(tempLogFile);
  }

  async #removeTempLogFile(): Promise<void> {
    const tempLogFile = this.#tempLogFile;
    this.#tempLogFile = null;
    if (tempLogFile !== null) await this.#removeLogFile(tempLogFile);
  }

  async #removeLogFile(path: string): Promise<void> {
    try {
      await Deno.remove(path);
    } catch {
      // already removed or inaccessible
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
 * Check only the `arf` binary/version. Use checkArfTestAvailable() for tests.
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
