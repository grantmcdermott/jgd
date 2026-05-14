/**
 * Test using interactive R (via stdin pipe) instead of Rscript.
 *
 * In interactive R, the event loop runs between commands, and
 * jgd's input handler fires automatically.  This is the closest
 * simulation to the user's manual testing scenario.
 */

import { assertEquals } from "@std/assert";
import { delay } from "@std/async";
import { TestServer } from "../server/tests/helpers/server.ts";
import { testLog } from "./helpers/test_log.ts";
import {
  E2EBrowser,
  plotInfoText,
  waitForPlotCount,
} from "../server/tests/helpers/e2e_browser.ts";
import { assertPlotInfoStable } from "./helpers/plot_settle.ts";
import { checkRAvailable, toRSocketAddress } from "./helpers/r_process.ts";

const rAvailable = await checkRAvailable();

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await Deno.stat(path);
      return;
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${path}`);
      }
      await delay(50);
    }
  }
}

Deno.test({
  name: "Interactive R: plots via stdin must not duplicate",
  ignore: !rAvailable,
  async fn() {
    testLog("test start");
    const server = new TestServer({ tcp: true });
    const e2e = new E2EBrowser();
    const readyFile = await Deno.makeTempFile({
      prefix: "jgd-interactive-ready-",
    });
    await Deno.remove(readyFile);

    try {
      await server.start();
      const socketAddr = toRSocketAddress(server.socketPath);

      // Launch R in interactive mode with stdin pipe
      const cmd = new Deno.Command("R", {
        args: ["--vanilla", "--no-save", "--no-restore"],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      });
      const proc = cmd.spawn();
      const writer = proc.stdin.getWriter();
      const encoder = new TextEncoder();

      // Drain stdout/stderr in background
      const stdoutDrained = proc.stdout.pipeTo(
        new WritableStream({ write() {} }),
      ).catch(() => {});
      const stderrDrained = proc.stderr.pipeTo(
        new WritableStream({
          write(chunk) {
            if (Deno.env.get("JGD_TEST_VERBOSE")) {
              Deno.stderr.writeSync(chunk);
            }
          },
        }),
      ).catch(() => {});

      const send = async (code: string) => {
        await writer.write(encoder.encode(code + "\n"));
      };

      try {
        // Load jgd and open device
        await send(`options(jgd.socket = "${socketAddr}")`);
        await send("library(jgd)");
        await send("jgd(width=8, height=6, dpi=96)");
        await send(`cat("ready", file = ${JSON.stringify(readyFile)})`);
        await waitForFile(readyFile);

        // NOW open browser — R is connected
        await e2e.launch();
        const page = await e2e.newPage(server.httpBaseUrl);
        await delay(300);

        // Plot 1 — typed interactively (R event loop processes events between commands)
        await send("plot(1:3)");

        let info = await waitForPlotCount(page, 1, 8_000);
        console.error(`After plot 1: "${info}"`);

        // Observe quiet window to catch delayed ghost entries.
        await assertPlotInfoStable(page, "1 / 1");
        info = await plotInfoText(page);
        console.error(`After plot 1 + quiet window: "${info}"`);

        // Plot 2 — typed interactively
        await send("plot(4:6)");

        info = await waitForPlotCount(page, 2, 8_000);
        console.error(`After plot 2: "${info}"`);
        assertEquals(
          info,
          "2 / 2",
          `After 2 plots, should show 2 / 2, got "${info}" — ` +
            "plot duplication bug detected",
        );

        // Plot 3
        await send("plot(7:9)");

        info = await waitForPlotCount(page, 3, 8_000);
        console.error(`After plot 3: "${info}"`);
        assertEquals(
          info,
          "3 / 3",
          `After 3 plots, should show 3 / 3, got "${info}" — ` +
            "plot duplication bug detected",
        );
      } finally {
        try {
          writer.releaseLock();
        } catch { /* ignore */ }
        try {
          await proc.stdin.close();
        } catch { /* ignore */ }
        try {
          proc.kill("SIGKILL");
        } catch { /* ignore */ }
        try {
          await proc.status;
        } catch { /* ignore */ }
        await Promise.allSettled([stdoutDrained, stderrDrained]);
      }
    } finally {
      await e2e.close();
      await delay(100);
      await server.shutdown();
      server.cleanup();
      try {
        await Deno.remove(readyFile);
      } catch { /* already removed */ }
    }
  },
});
