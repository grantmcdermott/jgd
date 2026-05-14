/**
 * E2E test: plotIndex resize — verify R re-renders historical plots via snapshots.
 *
 * Sends two sequential plots, then requests plotIndex resizes for each.
 * Verifies:
 *  1. Normal resize re-renders the current (latest) plot without plotIndex.
 *  2. plotIndex=0 resize re-renders the first plot's snapshot.
 *  3. plotIndex=1 resize re-renders the second plot's snapshot.
 *  4. Re-rendered plots produce ops consistent with their original content.
 *  5. Normal resize still works correctly after plotIndex resizes.
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  createTwoBasePlots,
  sendPlotIndexResizeAndPoll,
  sendResizeAndPoll,
  startArfBrowserTest,
  waitForResizeFrame,
} from "./helpers/arf_e2e.ts";
import { extractTextOps } from "./helpers/plot_ops.ts";
import { checkArfTestAvailable } from "./helpers/arf_session.ts";
import { testLog } from "./helpers/test_log.ts";

const arfTestAvailable = await checkArfTestAvailable();
const skip = !arfTestAvailable;

Deno.test({
  name: "E2E: plotIndex resize re-renders historical plot",
  ignore: skip,
  async fn() {
    testLog("test start");
    testLog("plotindex_e2e_test start");
    const ctx = await startArfBrowserTest();

    try {
      testLog("server/browser connected and arf session started");
      testLog("plot generation begin");
      const [frame1, frame2] = await createTwoBasePlots(ctx);
      testLog("R device initialized and two plots generated");
      testLog("received frame1");
      assert(frame2.plot.ops.length > 0, "Second frame should have ops");
      testLog("received frame2");

      // --- Test 1: plotIndex=0 resize re-renders the first plot ---
      const sessionId = frame1.plot.sessionId!;
      await sendPlotIndexResizeAndPoll(ctx, 640, 480, 0, sessionId);
      testLog("sent resize with plotIndex=0; calling poll_resize");
      testLog("poll_resize returned for plotIndex=0");

      const resized0 = await waitForResizeFrame(ctx.browser);
      testLog("received resized frame for plotIndex=0");

      assertEquals(
        resized0.resize,
        true,
        "plotIndex=0 frame should have resize:true",
      );
      assertEquals(
        resized0.plotIndex,
        0,
        "plotIndex=0 frame should have plotIndex:0",
      );
      assert(resized0.plot.ops.length > 0, "plotIndex=0 frame should have ops");

      // The re-rendered frame should contain text from plot(1:3), not plot(4:6)
      const texts0 = extractTextOps(resized0);
      assert(
        texts0.length > 0,
        "plotIndex=0 re-render should contain text ops",
      );

      // --- Test 2: plotIndex=1 is the latest plot (no snapshot exists) ---
      // With 2 plots, R has 1 snapshot (plot 1) and the active display list
      // (plot 2).  plotIndex=1 exceeds the snapshot count, so R falls
      // through to a normal resize of the current display list.  The frame
      // should have resize:true but no plotIndex.
      await sendPlotIndexResizeAndPoll(ctx, 700, 500, 1, sessionId);
      testLog("sent resize with plotIndex=1; calling poll_resize");
      testLog("poll_resize returned for plotIndex=1");

      const resized1 = await waitForResizeFrame(ctx.browser);
      testLog("received resized frame for plotIndex=1/latest");

      assertEquals(
        resized1.resize,
        true,
        "plotIndex=1 frame should have resize:true",
      );
      assertEquals(
        resized1.plotIndex,
        undefined,
        "plotIndex=1 targets the latest plot (no snapshot) — R treats as normal resize",
      );
      assert(resized1.plot.ops.length > 0, "plotIndex=1 frame should have ops");

      const texts1 = extractTextOps(resized1);
      assert(
        texts1.length > 0,
        "plotIndex=1 re-render should contain text ops",
      );

      // plot(1:3) and plot(4:6) produce different axis labels, so the
      // text ops from plotIndex=0 and plotIndex=1 should differ.
      assertNotEquals(
        JSON.stringify(texts0),
        JSON.stringify(texts1),
        "plotIndex=0 and plotIndex=1 should produce different text ops (different plots)",
      );

      // --- Test 3: normal resize (no plotIndex) still works ---
      await sendResizeAndPoll(ctx, 750, 550);
      testLog("sent normal resize; calling poll_resize");
      testLog("poll_resize returned for normal resize");

      const normalResize = await waitForResizeFrame(ctx.browser);
      testLog("received normal resize frame");

      assertEquals(
        normalResize.resize,
        true,
        "Normal resize frame should have resize:true",
      );
      assertEquals(
        normalResize.plotIndex,
        undefined,
        "Normal resize should NOT have plotIndex",
      );
      assert(
        normalResize.plot.ops.length > 0,
        "Normal resize frame should have ops",
      );

      // Normal resize re-renders the current (latest) plot, which is plot(4:6).
      // Its text ops should match the plotIndex=1 response (also the latest plot).
      const textsNormal = extractTextOps(normalResize);
      assertEquals(
        JSON.stringify(textsNormal),
        JSON.stringify(texts1),
        "Normal resize should re-render the current (latest) plot, matching plotIndex=1",
      );
      testLog("plotindex_e2e_test assertions complete");
    } finally {
      testLog("plotindex_e2e_test cleanup start");
      await ctx.close();
      testLog("plotindex_e2e_test server shutdown done");
      testLog("plotindex_e2e_test cleanup done");
    }
  },
});
