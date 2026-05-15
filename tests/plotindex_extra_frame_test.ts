/**
 * E2E test: plotIndex resize must produce exactly one frame.
 *
 * Reproduces Bug 1:
 *  1. plot(1:3)  → plot 1 displayed
 *  2. plot(4:6)  → plot 2 displayed
 *  3. Navigate to plot 1 in history
 *  4. Resize browser window
 *  5. Expected: plot 1 re-rendered at new size (single frame)
 *  6. Actual (bug): plot 2 is resized, AND a new plot 3 appears
 *     with plot 2's pre-resize content.
 *
 * This test checks at the protocol level:
 *  - The resize response frame contains plot 1's content (not plot 2)
 *  - No extra frame leaks after the resize
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  assertNoExtraFrameBeforePong,
  createTwoBasePlots,
  sendPlotIndexResizeAndPoll,
  startArfBrowserTest,
  waitForResizeFrame,
} from "./helpers/arf_e2e.ts";
import { extractTextOps } from "./helpers/plot_ops.ts";
import { checkArfTestAvailable } from "./helpers/arf_session.ts";
import { testLog } from "./helpers/test_log.ts";

const arfTestAvailable = await checkArfTestAvailable();
const skip = !arfTestAvailable;

Deno.test({
  name: "E2E: plotIndex resize produces exactly one frame with correct content",
  ignore: skip,
  async fn() {
    testLog("test start");
    const ctx = await startArfBrowserTest();
    const { browser } = ctx;

    try {
      const [frame1, frame2] = await createTwoBasePlots(ctx);
      const texts1 = extractTextOps(frame1);
      const texts2 = extractTextOps(frame2);

      // Verify the two plots are different
      assertNotEquals(
        JSON.stringify(texts1),
        JSON.stringify(texts2),
        "Plot 1 and plot 2 should have different text ops",
      );

      // Simulate: navigate to plot 1, then resize.
      // At the protocol level, this is a resize with plotIndex=0.
      const sessionId = frame1.plot.sessionId!;
      await sendPlotIndexResizeAndPoll(ctx, 640, 480, 0, sessionId);

      // Wait for the resize response frame
      const resized = await waitForResizeFrame(browser);

      assertEquals(resized.resize, true, "Should have resize:true");
      assertEquals(resized.plotIndex, 0, "Should have plotIndex:0");

      // CRITICAL: The resized frame must contain plot 1's content, not plot 2's.
      // Bug 1 manifests as the frame containing plot 2's content because the
      // snapshot replay produces the wrong plot.
      const textsResized = extractTextOps(resized);
      assertEquals(
        JSON.stringify(textsResized),
        JSON.stringify(texts1),
        "plotIndex=0 resize should render plot 1's content, not plot 2's",
      );

      // CRITICAL: No extra frames should arrive after the resize.
      // Bug 1 also manifests as the current plot restoration leaking an
      // extra untagged frame, which the browser would treat as a new plot 3.
      //
      // Send a ping sentinel: because WebSocket messages are ordered, any
      // frame queued before the pong will arrive first.  Race the pong
      // against a frame waiter — if the pong wins, no extra frame arrived.
      // AbortController cancels the losing waiter so it doesn't consume
      // later messages.
      await assertNoExtraFrameBeforePong(
        browser,
        "No extra frame should arrive after plotIndex resize (would create spurious plot 3)",
      );
    } finally {
      await ctx.close();
    }
  },
});
