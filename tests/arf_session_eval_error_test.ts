import { assert, assertRejects } from "@std/assert";
import { ArfSession, checkArfTestAvailable } from "./helpers/arf_session.ts";
import { testLog } from "./helpers/test_log.ts";

const arfTestAvailable = await checkArfTestAvailable();
const skip = !arfTestAvailable;

Deno.test({
  name: "ArfSession.start: resets starting state after temp log creation fails",
  async fn() {
    const arf = new ArfSession();
    const originalMakeTempFile = Deno.makeTempFile;
    const originalCommand = Deno.Command;
    const originalRemove = Deno.remove;
    // Stub Deno.remove so the temp-log cleanup path does not touch the
    // real filesystem if a developer happens to have a file at the
    // hard-coded mock path on their machine.
    const removedPaths: string[] = [];
    try {
      Object.defineProperty(Deno, "makeTempFile", {
        value: async () => {
          throw new Error("temp log unavailable");
        },
        configurable: true,
      });
      await assertRejects(
        () => arf.start(),
        Error,
        "temp log unavailable",
      );

      const stubLogPath = "/tmp/arf-session-test.log";
      Object.defineProperty(Deno, "makeTempFile", {
        value: async () => stubLogPath,
        configurable: true,
      });
      Object.defineProperty(Deno, "Command", {
        value: class {
          spawn(): Deno.ChildProcess {
            throw new Error("spawn reached after temp log failure");
          }
        },
        configurable: true,
      });
      Object.defineProperty(Deno, "remove", {
        value: async (path: string | URL) => {
          removedPaths.push(String(path));
        },
        configurable: true,
      });
      await assertRejects(
        () => arf.start(),
        Error,
        "spawn reached after temp log failure",
      );
      assert(
        removedPaths.includes(stubLogPath),
        `Expected stub log cleanup to be attempted, removed: ${
          removedPaths.join(", ")
        }`,
      );
    } finally {
      Object.defineProperty(Deno, "makeTempFile", {
        value: originalMakeTempFile,
        configurable: true,
      });
      Object.defineProperty(Deno, "Command", {
        value: originalCommand,
        configurable: true,
      });
      Object.defineProperty(Deno, "remove", {
        value: originalRemove,
        configurable: true,
      });
      await arf.shutdown();
    }
  },
});

Deno.test({
  name:
    "ArfSession.start: preserves caller-provided log file after startup failure",
  async fn() {
    const arf = new ArfSession();
    const originalCommand = Deno.Command;
    const originalRemove = Deno.remove;
    const callerLogFile = "/tmp/arf-session-caller.log";
    const removedPaths: string[] = [];

    try {
      Object.defineProperty(Deno, "Command", {
        value: class {
          spawn(): Deno.ChildProcess {
            return {
              stdout: {
                getReader: () => ({
                  read: () => new Promise(() => {}),
                  releaseLock: () => {},
                }),
                cancel: async () => {},
              },
              kill: () => {},
              status: Promise.resolve({
                success: false,
                code: null,
                signal: "SIGKILL",
              }),
            } as unknown as Deno.ChildProcess;
          }
        },
        configurable: true,
      });
      Object.defineProperty(Deno, "remove", {
        value: async (path: string | URL) => {
          removedPaths.push(String(path));
        },
        configurable: true,
      });

      await assertRejects(
        () => arf.start({ logFile: callerLogFile, timeoutMs: 1 }),
        Error,
        "startup timed out",
      );
      assert(
        !removedPaths.includes(callerLogFile),
        `Expected caller log to be preserved, removed: ${
          removedPaths.join(", ")
        }`,
      );
    } finally {
      Object.defineProperty(Deno, "Command", {
        value: originalCommand,
        configurable: true,
      });
      Object.defineProperty(Deno, "remove", {
        value: originalRemove,
        configurable: true,
      });
      await arf.shutdown();
    }
  },
});

Deno.test({
  name:
    "ArfSession.shutdown: kills headless process and cleans temp log when IPC shutdown spawn fails",
  async fn() {
    const arf = new ArfSession();
    const originalCommand = Deno.Command;
    const originalMakeTempFile = Deno.makeTempFile;
    const originalRemove = Deno.remove;
    const killCalls: string[] = [];
    const removedPaths: string[] = [];
    const stubLogPath = "/tmp/arf-session-shutdown-fallback.log";

    try {
      Object.defineProperty(Deno, "makeTempFile", {
        value: async () => stubLogPath,
        configurable: true,
      });
      Object.defineProperty(Deno, "remove", {
        value: async (path: string | URL) => {
          removedPaths.push(String(path));
        },
        configurable: true,
      });
      Object.defineProperty(Deno, "Command", {
        value: class {
          #args: string[];
          constructor(_cmd: string, opts: { args?: string[] }) {
            this.#args = opts.args ?? [];
          }
          spawn(): Deno.ChildProcess {
            if (this.#args.includes("shutdown")) {
              // Simulate `arf ipc shutdown` failing to spawn (e.g. arf
              // binary disappeared mid-test). #shutdownByIpc must surface
              // this without leaving the headless child running.
              throw new Error("arf ipc shutdown spawn failed");
            }
            // `arf headless` mock: emit a valid ready JSON line, accept a
            // kill() call, and resolve its status so shutdown() can await it.
            const encoder = new TextEncoder();
            let emitted = false;
            return {
              stdout: {
                getReader: () => ({
                  read: () =>
                    emitted
                      ? Promise.resolve({ value: undefined, done: true })
                      : (emitted = true,
                        Promise.resolve({
                          value: encoder.encode(`{"pid":12345}\n`),
                          done: false,
                        })),
                  releaseLock: () => {},
                }),
                cancel: async () => {},
              },
              kill: (signal: string) => {
                killCalls.push(signal);
              },
              status: Promise.resolve({
                success: false,
                code: null,
                signal: "SIGKILL",
              }),
            } as unknown as Deno.ChildProcess;
          }
        },
        configurable: true,
      });

      await arf.start();
      // Should not throw: shutdown swallows the IPC spawn failure, but the
      // headless process MUST still be killed and the temp log MUST be
      // cleaned up so neither leaks past this call.
      await arf.shutdown();

      assert(
        killCalls.includes("SIGKILL"),
        `Expected headless process to receive SIGKILL when IPC shutdown ` +
          `spawn fails, got kill signals: ${killCalls.join(", ") || "(none)"}`,
      );
      assert(
        removedPaths.includes(stubLogPath),
        `Expected temp log cleanup, removed: ${
          removedPaths.join(", ") || "(none)"
        }`,
      );
    } finally {
      Object.defineProperty(Deno, "Command", {
        value: originalCommand,
        configurable: true,
      });
      Object.defineProperty(Deno, "makeTempFile", {
        value: originalMakeTempFile,
        configurable: true,
      });
      Object.defineProperty(Deno, "remove", {
        value: originalRemove,
        configurable: true,
      });
    }
  },
});

Deno.test({
  name: "ArfSession.eval: throws on R evaluation error by default",
  ignore: skip,
  async fn() {
    testLog("test start");
    const arf = new ArfSession();
    try {
      await arf.start();
      await assertRejects(
        () => arf.eval("stop('boom-from-test')"),
        Error,
        "R eval failed:",
      );
    } finally {
      await arf.shutdown();
    }
  },
});

Deno.test({
  name: "ArfSession.eval: throwOnRError=false returns error payload",
  ignore: skip,
  async fn() {
    testLog("test start");
    const arf = new ArfSession();
    try {
      await arf.start();
      const result = await arf.eval("stop('boom-from-test')", 30_000, {
        throwOnRError: false,
      });
      assert(
        result.error !== null &&
          result.error.includes("boom-from-test"),
        `Expected result.error to include boom-from-test, got: ${result.error}`,
      );
    } finally {
      await arf.shutdown();
    }
  },
});

Deno.test({
  name: "ArfSession.start: rejects accidental double start",
  ignore: skip,
  async fn() {
    testLog("test start");
    const arf = new ArfSession();
    try {
      await arf.start();
      await assertRejects(
        () => arf.start(),
        Error,
        "ArfSession already started",
      );
    } finally {
      await arf.shutdown();
    }
  },
});

Deno.test({
  name: "ArfSession.start: rejects concurrent start calls",
  ignore: skip,
  async fn() {
    testLog("test start");
    const arf = new ArfSession();
    try {
      const start = arf.start();
      await assertRejects(
        () => arf.start(),
        Error,
        "ArfSession already started",
      );
      await start;
    } finally {
      await arf.shutdown();
    }
  },
});
