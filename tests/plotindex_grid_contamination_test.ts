/**
 * E2E test: plotIndex resize must not contaminate base graphics with grid state.
 *
 * Regression test for a bug where replaying a base-graphics snapshot whose
 * base display list happened to have the same op count as the previous page
 * caused replay_snapshot() to incorrectly detect "grid/ggplot2 case"
 * (new_ops == 0) and call grid.refresh(), drawing lingering ggplot2 grid
 * content over the base plot.
 *
 * Sequence:
 *   1. ggplot2 plot (grid-only, populates grid state)
 *   2. base-graphics plot(1:3) with jgd_ext (populates base DL)
 *   3. plotIndex resize of plot 2 → must render base plot, not ggplot2
 */

import { assert, assertEquals } from "@std/assert";
import { delay } from "@std/async";
import { TestServer } from "../server/tests/helpers/server.ts";
import type { FrameMessage } from "../server/tests/helpers/types.ts";
import { AutoMetricsBrowserClient } from "./helpers/auto_metrics_client.ts";
import { extractTextOps } from "./helpers/plot_ops.ts";
import { ArfSession, checkArfTestAvailable } from "./helpers/arf_session.ts";
import { toRSocketAddress } from "./helpers/r_process.ts";
import { checkGgplot2Available } from "./helpers/r_packages.ts";
import { testLog } from "./helpers/test_log.ts";

const arfTestAvailable = await checkArfTestAvailable();
const ggplot2Available = arfTestAvailable && await checkGgplot2Available();
const skip = !ggplot2Available;

Deno.test({
  name:
    "E2E: plotIndex resize of base plot after ggplot2 shows correct content",
  ignore: skip,
  async fn() {
    testLog("test start");
    const server = new TestServer({ tcp: true });
    const browser = new AutoMetricsBrowserClient();
    const arf = new ArfSession();

    try {
      await server.start();
      await browser.connect(server.wsUrl);
      browser.sendResize(800, 600);
      await delay(100);

      await arf.start();
      const socketAddr = toRSocketAddress(server.socketPath);

      // Setup: connect jgd device
      await arf.eval(
        `options(jgd.socket = "${socketAddr}"); library(jgd); jgd(width=8, height=6, dpi=96)`,
      );

      // Plot 1: ggplot2 (grid-based, populates grid state)
      await arf.eval(
        "library(ggplot2); print(ggplot(mpg, aes(displ, hwy)) + geom_point())",
      );

      // Plot 2: base-graphics plot(1:3) with ext; Plot 3: another base plot
      await arf.eval(
        'jgd_ext(\'{"shadow":{"blur":5}}\'); plot(1:3); jgd_ext(NULL); plot(4:6)',
      );

      // Collect all frames until we have at least 3 newPage frames
      // (ggplot2 sends many incremental frames before the base plot's newPage)
      const frames: FrameMessage[] = [];
      let newPageCount = 0;
      const deadline = Date.now() + 20000;

      while (newPageCount < 3 && Date.now() < deadline) {
        const msg = await browser.waitForType<FrameMessage>("frame", 6000);
        frames.push(msg);
        if (msg.newPage) newPageCount++;
      }

      assert(
        newPageCount >= 3,
        `Expected at least 3 newPage frames, got ${newPageCount}`,
      );

      // Find the newPage frames: [ggplot2, base plot(1:3), plot(4:6)]
      const newPageFrames = frames.filter((f) => f.newPage);
      const basePlotFrame = newPageFrames[1]; // plot(1:3) is the second newPage

      // The base plot (plot(1:3)) should have text labels "1", "2", "3"
      const baseTexts = extractTextOps(basePlotFrame);
      assert(
        baseTexts.some((t) => t.includes("1")),
        `Base plot frame should contain "1", got: ${JSON.stringify(baseTexts)}`,
      );

      // Get sessionId for plotIndex resize
      const sessionId = basePlotFrame.plot.sessionId!;

      // plotIndex 0 = ggplot2 (plot 1), plotIndex 1 = base plot (plot 2)
      // Use plotIndex 1 to resize the base plot.
      browser.sendResizeWithPlotIndex(640, 480, 1, sessionId);
      await delay(100);
      await arf.eval(".Call(jgd:::C_jgd_poll_resize)");

      const resized = await browser.waitForMessage<FrameMessage>(
        (msg) => msg.type === "frame" && (msg as FrameMessage).resize === true,
        6000,
      );

      assertEquals(
        resized.resize,
        true,
        "Resized frame should have resize:true",
      );
      assertEquals(
        resized.plotIndex,
        1,
        "Resized frame should have plotIndex=1",
      );

      // The resized frame must contain base plot text ops ("1", "2", "3"),
      // NOT ggplot2 content ("displ", "hwy", etc.)
      const resizedTexts = extractTextOps(resized);
      assert(
        resizedTexts.some((t) => t.includes("1")),
        `Resized plot should contain "1", got: ${JSON.stringify(resizedTexts)}`,
      );

      // Must NOT contain ggplot2 axis labels
      const hasGgplotContent = resizedTexts.some(
        (t) => t.includes("displ") || t.includes("hwy"),
      );
      assertEquals(
        hasGgplotContent,
        false,
        `Resized plot must NOT contain ggplot2 content, got: ${
          JSON.stringify(resizedTexts)
        }`,
      );
    } finally {
      await browser.close();
      await server.shutdown();
      await arf.shutdown();
    }
  },
});
