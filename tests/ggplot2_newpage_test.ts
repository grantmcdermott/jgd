/**
 * Regression test for ggplot2 plot duplication and incomplete snapshot bugs.
 *
 * Unlike base R plot() which sends a single complete frame per plot, ggplot2
 * (via grid) sends many incremental frames during drawing.  When the next
 * plot starts, cb_newPage must flush remaining unflushed ops.
 *
 * Bug 1 (spurious history entry): cb_newPage flushes the remaining ops as a
 * non-incremental frame (incremental:false, newPage:false, resize:false).
 * The browser dispatches this to addPlot, creating a spurious third history
 * entry for only two plots.
 *
 * Bug 2 (white image on plotIndex resize): jgd_capture_snapshot is only
 * called after the first complete frame (the newPage frame with ~7 initial
 * ops).  Subsequent incremental frames never update the snapshot, so the
 * snapshot stored for a ggplot2 plot contains only the initial page setup —
 * producing a white/empty image when replayed via plotIndex resize.
 *
 * These tests require ggplot2 to be installed (skipped otherwise).
 */

import { assert, assertEquals } from "@std/assert";
import { delay } from "@std/async";
import { TestServer } from "../server/tests/helpers/server.ts";
import type { FrameMessage } from "../server/tests/helpers/types.ts";
import { AutoMetricsBrowserClient } from "./helpers/auto_metrics_client.ts";
import { checkRAvailable, startR } from "./helpers/r_process.ts";

const rAvailable = await checkRAvailable();

/** Check if ggplot2 is installed in R. */
async function checkGgplot2Available(): Promise<boolean> {
  try {
    const cmd = new Deno.Command("Rscript", {
      args: ["-e", 'library(ggplot2); cat("ok")'],
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

const ggplot2Available = rAvailable && await checkGgplot2Available();

// ---------------------------------------------------------------------------
// Bug 1: Two ggplot2 plots must produce exactly 2 addPlot-triggering frames
// ---------------------------------------------------------------------------

Deno.test({
  name: "ggplot2: two plots must not create spurious history entry",
  ignore: !ggplot2Available,
  async fn() {
    const server = new TestServer({ tcp: true });
    const browser = new AutoMetricsBrowserClient();

    try {
      await server.start();
      await browser.connect(server.wsUrl);
      browser.sendResize(800, 600);
      await delay(200);

      // Two ggplot2 faceted plots.  facet_wrap produces many incremental
      // frames and leaves some ops unflushed when the second plot starts.
      const r = startR(
        'jgd(width=8, height=6, dpi=96); library(ggplot2); ' +
          'ggplot(mpg, aes(displ, hwy, col=class)) + geom_point() + facet_wrap(~drv) + theme_bw(); ' +
          'ggplot(mpg, aes(displ, hwy, col=class)) + geom_point() + facet_wrap(~drv) + theme_bw(); ' +
          'for (i in 1:200) { .Call(jgd:::C_jgd_poll_resize); Sys.sleep(0.05) }',
        server.socketPath,
      );

      try {
        // Collect frames until we see 2 newPage frames (= 2 plots started)
        const allFrames: FrameMessage[] = [];
        let newPageCount = 0;

        while (newPageCount < 2) {
          const frame = await browser.waitForType<FrameMessage>(
            "frame",
            15000,
          );
          allFrames.push(frame);
          if (frame.newPage) newPageCount++;
        }

        // Drain remaining incremental frames for the second plot
        await delay(2000);
        let draining = true;
        while (draining) {
          try {
            const frame = await browser.waitForType<FrameMessage>(
              "frame",
              1000,
            );
            allFrames.push(frame);
          } catch {
            draining = false;
          }
        }

        // Categorize frames
        const addPlotFrames = allFrames.filter(
          (f) => !f.resize && !f.incremental,
        );
        const newPageFrames = allFrames.filter((f) => f.newPage === true);
        const incrementalFrames = allFrames.filter(
          (f) => f.incremental === true,
        );
        const untaggedCompleteFrames = allFrames.filter(
          (f) => !f.newPage && !f.resize && !f.incremental,
        );

        console.error(
          `\nggplot2 frame summary: total=${allFrames.length}, ` +
            `newPage=${newPageFrames.length}, ` +
            `incremental=${incrementalFrames.length}, ` +
            `addPlot-triggering=${addPlotFrames.length}, ` +
            `untaggedComplete=${untaggedCompleteFrames.length}`,
        );

        // Log non-incremental frames for debugging
        for (let i = 0; i < allFrames.length; i++) {
          const f = allFrames[i];
          if (!f.incremental) {
            console.error(
              `  frame[${i}]: newPage=${f.newPage}, resize=${f.resize}, ` +
                `incremental=${f.incremental}, ops=${f.plot.ops.length}`,
            );
          }
        }

        assertEquals(
          newPageFrames.length,
          2,
          `Expected 2 newPage frames for 2 ggplot2 plots`,
        );

        // Key assertion: no untagged complete frames between the two plots.
        // These would cause addPlot → spurious third history entry.
        assertEquals(
          untaggedCompleteFrames.length,
          0,
          `Untagged complete frames cause spurious history entries: ` +
            `got ${untaggedCompleteFrames.length}. ` +
            `cb_newPage should flush remaining ops as incremental.`,
        );

        // Total addPlot-triggering frames must equal the number of plots.
        assertEquals(
          addPlotFrames.length,
          2,
          `Expected 2 addPlot-triggering frames for 2 plots, ` +
            `got ${addPlotFrames.length} — browser would show ` +
            `${addPlotFrames.length} history entries instead of 2`,
        );
      } finally {
        r.kill();
        try {
          await r.process.output();
        } catch { /* ignore */ }
      }
    } finally {
      browser.close();
      await delay(100);
      await server.shutdown();
      server.cleanup();
    }
  },
});

// ---------------------------------------------------------------------------
// Bug 2: plotIndex resize of a ggplot2 plot must produce a complete replay
// ---------------------------------------------------------------------------

Deno.test({
  name: "ggplot2: plotIndex resize must replay full plot (not just initial ops)",
  ignore: !ggplot2Available,
  async fn() {
    const server = new TestServer({ tcp: true });
    const browser = new AutoMetricsBrowserClient();

    try {
      await server.start();
      await browser.connect(server.wsUrl);
      browser.sendResize(800, 600);
      await delay(200);

      // Two ggplot2 plots, then poll_resize to handle the plotIndex resize.
      const r = startR(
        'jgd(width=8, height=6, dpi=96); library(ggplot2); ' +
          'ggplot(mpg, aes(displ, hwy, col=class)) + geom_point() + facet_wrap(~drv) + theme_bw(); ' +
          'ggplot(mpg, aes(displ, hwy, col=class)) + geom_point() + facet_wrap(~drv) + theme_bw(); ' +
          'for (i in 1:400) { .Call(jgd:::C_jgd_poll_resize); Sys.sleep(0.05) }',
        server.socketPath,
      );

      try {
        // Wait for both plots: collect until we see 2 newPage frames
        let newPageCount = 0;
        let sessionId = "";
        let firstPlotOpsTotal = 0;

        while (newPageCount < 2) {
          const frame = await browser.waitForType<FrameMessage>(
            "frame",
            15000,
          );
          if (frame.newPage) {
            newPageCount++;
            if (newPageCount === 1) {
              sessionId = frame.plot.sessionId || "";
            }
          }
          // Track total ops for the first plot (newPage + incrementals before
          // the second newPage).
          if (newPageCount === 1) {
            firstPlotOpsTotal += frame.plot.ops.length;
          }
        }

        // Drain remaining frames from the second plot
        await delay(2000);
        let draining = true;
        while (draining) {
          try {
            await browser.waitForType<FrameMessage>("frame", 1000);
          } catch {
            draining = false;
          }
        }

        assert(sessionId, "Should have received sessionId from R");
        assert(
          firstPlotOpsTotal > 50,
          `First ggplot2 plot should have many ops, got ${firstPlotOpsTotal}`,
        );

        console.error(
          `\nFirst plot total ops: ${firstPlotOpsTotal}, sessionId: ${sessionId}`,
        );

        // Now send a plotIndex resize for plot 0 (the first ggplot)
        browser.sendResizeWithPlotIndex(640, 480, 0, sessionId);

        // Wait for the plotIndex replay frame
        const replayFrame = await browser.waitForMessage<FrameMessage>(
          (msg) =>
            msg.type === "frame" &&
            !("incremental" in msg && (msg as FrameMessage).incremental),
          10000,
        );

        console.error(
          `\nplotIndex replay: ops=${replayFrame.plot.ops.length}, ` +
            `resize=${replayFrame.resize}, plotIndex=${replayFrame.plotIndex}`,
        );

        assertEquals(
          replayFrame.resize,
          true,
          "plotIndex replay frame must be tagged resize:true",
        );

        // Key assertion: the replay must contain a substantial number of ops.
        // If the snapshot was incomplete (only initial page setup ~7 ops),
        // the replay would have very few ops → white/empty image.
        //
        // A full ggplot2 faceted plot typically has 400+ ops.  We use a
        // conservative threshold of 50 to avoid flakiness while still
        // catching the "only 7 initial ops" bug.
        assert(
          replayFrame.plot.ops.length > 50,
          `plotIndex replay should contain the full plot, ` +
            `got only ${replayFrame.plot.ops.length} ops ` +
            `(first plot had ${firstPlotOpsTotal} total). ` +
            `Snapshot was likely incomplete (only initial page setup).`,
        );
      } finally {
        r.kill();
        try {
          await r.process.output();
        } catch { /* ignore */ }
      }
    } finally {
      browser.close();
      await delay(100);
      await server.shutdown();
      server.cleanup();
    }
  },
});
