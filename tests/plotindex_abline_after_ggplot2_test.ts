/**
 * E2E test: abline must survive plotIndex resize when ggplot2 is the next plot.
 *
 * Regression test for a bug where interactive annotations (abline, lines)
 * drawn without dev.hold() are missing from the snapshot's display list.
 * R's GErecordGraphicOperation runs AFTER the device's mode(0) callback,
 * so the snapshot captured in cb_mode(0) is one DL entry short.
 *
 * For base→base transitions, the next plot's dev.hold() re-captures a
 * complete snapshot (holdflush_captured path).  For base→grid transitions
 * (e.g. abline followed by ggplot2), grid.newpage() skips dev.hold()
 * and the incomplete snapshot is stored as-is.
 *
 * Sequence:
 *   1. plot(cars) + abline (base graphics with annotation)
 *   2. ggplot2 plot (grid-based, no dev.hold before grid.newpage)
 *   3. another base plot (pushes plot 1 to snapshot history)
 *   4. plotIndex resize of plot 1 → must include abline's line op
 */

import { assert, assertEquals } from "@std/assert";
import { delay } from "@std/async";
import { TestServer } from "../server/tests/helpers/server.ts";
import type { FrameMessage } from "../server/tests/helpers/types.ts";
import { AutoMetricsBrowserClient } from "./helpers/auto_metrics_client.ts";
import { checkRAvailable, startR } from "./helpers/r_process.ts";

const rAvailable = await checkRAvailable();

Deno.test({
  name: "E2E: abline survives plotIndex resize when ggplot2 is the next plot",
  ignore: !rAvailable,
  async fn() {
    const server = new TestServer({ tcp: true });
    const browser = new AutoMetricsBrowserClient();

    try {
      await server.start();
      await browser.connect(server.wsUrl);
      browser.sendResize(800, 600);
      await delay(200);

      // Plot 1: plot(cars) + abline (base graphics with line annotation)
      // Plot 2: ggplot2 (grid-based — triggers the bug path)
      // Plot 3: another base plot (pushes plot 1 to snapshot history)
      // Then poll for resize.
      const rCode = [
        "library(ggplot2)",
        "jgd(width=8, height=6, dpi=96)",
        "plot(cars)",
        "abline(lm(dist ~ speed, data = cars), col = 'red', lwd = 2)",
        "ggplot(mpg, aes(displ, hwy)) + geom_point()",
        "plot(1:5)",
        "for (i in 1:200) { .Call(jgd:::C_jgd_poll_resize); Sys.sleep(0.05) }",
      ].join("; ");

      const r = startR(rCode, server.socketPath);

      try {
        // Collect frames until we have at least 3 newPage frames
        const frames: FrameMessage[] = [];
        let newPageCount = 0;
        const deadline = Date.now() + 30000;

        while (newPageCount < 3 && Date.now() < deadline) {
          const msg = await browser.waitForType<FrameMessage>("frame", 15000);
          frames.push(msg);
          if (msg.newPage) newPageCount++;
        }

        assert(
          newPageCount >= 3,
          `Expected at least 3 newPage frames, got ${newPageCount}`,
        );

        // Find newPage frames: [plot(cars), ggplot2, plot(1:5)]
        const newPageFrames = frames.filter((f) => f.newPage);
        const carsFrame = newPageFrames[0]; // plot(cars) is the first newPage

        assert(carsFrame, "cars plot frame should exist");

        // Get sessionId for plotIndex resize
        const sessionId = carsFrame.plot.sessionId!;

        // plotIndex 0 = plot(cars)+abline, plotIndex 1 = ggplot2
        // Use plotIndex 0 to resize the base plot with abline.
        browser.sendResizeWithPlotIndex(640, 480, 0, sessionId);

        const resized = await browser.waitForMessage<FrameMessage>(
          (msg) =>
            msg.type === "frame" && (msg as FrameMessage).resize === true &&
            (msg as FrameMessage).plotIndex === 0,
          15000,
        );

        assertEquals(
          resized.resize,
          true,
          "Resized frame should have resize:true",
        );
        assertEquals(
          resized.plotIndex,
          0,
          "Resized frame should have plotIndex=0",
        );

        // The resized frame MUST contain abline's red line.
        // The snapshot's display list must include the abline annotation,
        // not just the base plot(cars) scatter and tick marks.
        const resizedOps = resized.plot.ops as Array<Record<string, unknown>>;
        const redLineOps = resizedOps.filter((op) => {
          if (op.op !== "line") return false;
          const gc = op.gc as Record<string, unknown> | undefined;
          const col = (gc?.col as string | undefined) ?? "";
          // Color may be "#ff0000", "rgba(255,0,0,1)", etc.
          return col.toLowerCase().includes("ff0000") ||
            col.includes("255,0,0");
        });
        assert(
          redLineOps.length > 0,
          `Resized plot(cars) must contain red line op from abline(), ` +
            `got line colors: ${JSON.stringify(
              resizedOps
                .filter((o) => o.op === "line")
                .map((o) => (o.gc as Record<string, unknown>)?.col),
            )}`,
        );
      } finally {
        r.kill();
        await r.process.stdout.cancel();
        await r.process.stderr.cancel();
      }
    } finally {
      await browser.close();
      await server.shutdown();
    }
  },
});
