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
import { E2EBrowser, plotInfoText } from "../server/tests/helpers/e2e_browser.ts";
import { checkRAvailable } from "./helpers/r_process.ts";
import { toRSocketAddress } from "./helpers/r_process.ts";

const rAvailable = await checkRAvailable();

/** Poll until plotInfo shows expected count or timeout. */
async function waitForPlotCount(
  page: Awaited<ReturnType<E2EBrowser["newPage"]>>,
  expectedCount: number,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let info = "";
  while (Date.now() < deadline) {
    info = await plotInfoText(page);
    const count = parseInt(info.split("/")[1]?.trim() ?? "0");
    if (count >= expectedCount) return info;
    await delay(200);
  }
  return info;
}

Deno.test({
  name: "Interactive R: plots via stdin must not duplicate",
  ignore: !rAvailable,
  async fn() {
    const server = new TestServer({ tcp: true });
    const e2e = new E2EBrowser();

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
      proc.stdout.pipeTo(new WritableStream({ write() {} })).catch(() => {});
      proc.stderr.pipeTo(new WritableStream({
        write(chunk) {
          if (Deno.env.get("JGD_TEST_VERBOSE")) {
            Deno.stderr.writeSync(chunk);
          }
        },
      })).catch(() => {});

      const send = async (code: string) => {
        await writer.write(encoder.encode(code + "\n"));
      };

      try {
        // Load jgd and open device
        await send(`options(jgd.socket = "${socketAddr}")`);
        await send("library(jgd)");
        await send("jgd(width=8, height=6, dpi=96)");
        await delay(1000);

        // NOW open browser — R is connected
        await e2e.launch();
        const page = await e2e.newPage(server.httpBaseUrl);
        await delay(1000);

        // Plot 1 — typed interactively (R event loop processes events between commands)
        await send("plot(1:3)");

        let info = await waitForPlotCount(page, 1, 10_000);
        console.error(`After plot 1: "${info}"`);

        // Settle — check for ghost entries from resize replay
        await delay(2000);
        info = await plotInfoText(page);
        console.error(`After plot 1 + settle: "${info}"`);
        assertEquals(
          info,
          "1 / 1",
          `After plot 1 + settle, should be 1 / 1, got "${info}" — ` +
            "resize replay created ghost entry",
        );

        // Plot 2 — typed interactively
        await send("plot(4:6)");

        info = await waitForPlotCount(page, 2, 10_000);
        console.error(`After plot 2: "${info}"`);
        assertEquals(
          info,
          "2 / 2",
          `After 2 plots, should show 2 / 2, got "${info}" — ` +
            "plot duplication bug detected",
        );

        // Plot 3
        await send("plot(7:9)");

        info = await waitForPlotCount(page, 3, 10_000);
        console.error(`After plot 3: "${info}"`);
        assertEquals(
          info,
          "3 / 3",
          `After 3 plots, should show 3 / 3, got "${info}" — ` +
            "plot duplication bug detected",
        );

      } finally {
        try {
          await send("dev.off()");
          await send("q('no')");
          writer.releaseLock();
          await proc.stdin.close();
        } catch { /* ignore */ }
        try {
          proc.kill("SIGKILL");
        } catch { /* ignore */ }
        try {
          await proc.output();
        } catch { /* ignore */ }
      }
    } finally {
      await e2e.close();
      await delay(100);
      await server.shutdown();
      server.cleanup();
    }
  },
});
