/**
 * Reproduction tests for the newPage duplicate plot regression (trigd-1uj.8).
 *
 * Symptom: Creating plot 2 causes plot 1 to appear duplicated in browser
 * history as [plot1, plot1-copy, plot2] instead of [plot1, plot2].
 * Additionally, earlier plots don't re-render on browser window resize.
 *
 * These tests exercise the server's frame routing at the protocol level,
 * simulating message sequences that arise in real browser+R interactions.
 *
 * The fix relies on two mechanisms:
 *
 * 1. R-side newPage flag: R's device includes "newPage":true in frames
 *    that represent genuinely new plots (first complete flush after
 *    cb_newPage).  The server uses this to skip FIFO/dimension matching
 *    and silently drain any coincidentally-matching pending entry.
 *
 * 2. Initial resize entry: The server now pushes a pendingResizes entry
 *    for the initial browser resize (ws.onopen).  If R processes the
 *    resize after the first plot exists, the replay frame gets tagged.
 *    If R processes it before any plot (empty DL, no replay), the entry
 *    is silently drained by the first newPage frame.
 */

import { assertEquals } from "@std/assert";
import { TestServer } from "./helpers/server.ts";
import { RClient } from "./helpers/r_client.ts";
import { BrowserClient } from "./helpers/browser_client.ts";
import { delay } from "@std/async";
import type { FrameMessage, ResizeMessage } from "./helpers/types.ts";

// ---------------------------------------------------------------------------
// Scenario 1: Baseline — two new plots, no resize between them
// ---------------------------------------------------------------------------

Deno.test("two sequential new plots — both untagged", async (t) => {
  const server = new TestServer();
  const rClient = new RClient();
  const browser = new BrowserClient();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await browser.connect(server.wsUrl);
    await rClient.waitForWelcome();

    // Initial resize from browser (ws.onopen equivalent)
    browser.sendResize(800, 600);
    await rClient.readMessage<ResizeMessage>();

    await t.step("plot 1 — new plot", async () => {
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot1" }],
        device: { width: 800, height: 600 },
      }, { newPage: true });
      const frame = await browser.waitForType<FrameMessage>("frame");
      assertEquals(frame.resize, undefined, "Plot 1 must not be tagged as resize");
    });

    await t.step("plot 2 — new plot, not a duplicate", async () => {
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot2" }],
        device: { width: 800, height: 600 },
      }, { newPage: true });
      const frame = await browser.waitForType<FrameMessage>("frame");
      assertEquals(frame.resize, undefined, "Plot 2 must not be tagged as resize");
    });
  } finally {
    browser.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scenario 2: Deferred resize — replay tagged, subsequent new plot untagged
// ---------------------------------------------------------------------------

Deno.test("deferred resize replay tagged, new plot after replay untagged", async (t) => {
  const server = new TestServer();
  const rClient = new RClient();
  const browser = new BrowserClient();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await browser.connect(server.wsUrl);
    await rClient.waitForWelcome();

    await t.step("initial + deferred resize before first frame", async () => {
      // ws.onopen resize — forwarded to R, pendingResizes entry pushed.
      browser.sendResize(800, 600);
      const msg = await rClient.readMessage<ResizeMessage>();
      assertEquals(msg.type, "resize");

      // ResizeObserver resize (different dims) — deferred by the server.
      browser.sendResize(802, 601);
    });

    await t.step("plot 1 triggers deferred forwarding", async () => {
      // R draws plot 1 at the initial resize dimensions.
      // newPage:true causes the initial entry to be silently drained.
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot1" }],
        device: { width: 800, height: 600 },
      }, { newPage: true });
      const frame = await browser.waitForType<FrameMessage>("frame");
      assertEquals(frame.resize, undefined, "Plot 1 must not be tagged");

      // Server forwards deferred resize after first frame.
      const deferred = await rClient.readMessage<ResizeMessage>();
      assertEquals(deferred.width, 802, "Deferred resize forwarded");
    });

    await t.step("replay of plot 1 at deferred dims — tagged", async () => {
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot1-resized" }],
        device: { width: 802, height: 601 },
      });
      const frame = await browser.waitForType<FrameMessage>("frame");
      assertEquals(frame.resize, true, "Deferred replay must be tagged");
    });

    await t.step("plot 2 — new plot, untagged", async () => {
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot2" }],
        device: { width: 802, height: 601 },
      }, { newPage: true });
      const frame = await browser.waitForType<FrameMessage>("frame");
      assertEquals(frame.resize, undefined, "Plot 2 must be a new plot");
    });
  } finally {
    browser.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scenario 3: Explicit resize between plots — replay tagged, new plot untagged
// ---------------------------------------------------------------------------

Deno.test("resize between plots — replay tagged, new plot untagged", async (t) => {
  const server = new TestServer();
  const rClient = new RClient();
  const browser = new BrowserClient();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await browser.connect(server.wsUrl);
    await rClient.waitForWelcome();

    // Prime: initial resize + first frame
    browser.sendResize(800, 600);
    await rClient.readMessage<ResizeMessage>();
    await rClient.sendFrame({
      ops: [{ op: "text", str: "plot1" }],
      device: { width: 800, height: 600 },
    }, { newPage: true });
    await browser.waitForType<FrameMessage>("frame");

    await t.step("resize after plot 1", async () => {
      browser.sendResize(900, 700);
      const msg = await rClient.readMessage<ResizeMessage>();
      assertEquals(msg.width, 900);
    });

    await t.step("replay of plot 1 — tagged", async () => {
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot1-at-900" }],
        device: { width: 900, height: 700 },
      });
      const frame = await browser.waitForType<FrameMessage>("frame");
      assertEquals(frame.resize, true, "Replay must be tagged");
    });

    await t.step("plot 2 — new plot, untagged", async () => {
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot2" }],
        device: { width: 900, height: 700 },
      }, { newPage: true });
      const frame = await browser.waitForType<FrameMessage>("frame");
      assertEquals(frame.resize, undefined, "Plot 2 must be a new plot");
    });
  } finally {
    browser.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scenario 4 (Race A): R consumes resize in cb_newPage — new-plot frame at
// resize dims.
//
// Timeline:
//   1. Browser sends resize → server pushes pendingResizes, sends to R
//   2. R reads resize in cb_newPage's check_incoming (NOT poll_resize_impl)
//   3. R draws new plot at resize dims → sends frame with newPage:true
//   4. Server sees newPage:true → drains matching entry silently (no tag)
//   5. Browser calls addPlot ✓
// ---------------------------------------------------------------------------

Deno.test("race A: new plot at resize dims should not be tagged (cb_newPage consumed resize)", async (t) => {
  const server = new TestServer();
  const rClient = new RClient();
  const browser = new BrowserClient();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await browser.connect(server.wsUrl);
    await rClient.waitForWelcome();

    // Prime: initial resize + first frame
    browser.sendResize(800, 600);
    await rClient.readMessage<ResizeMessage>();
    await rClient.sendFrame({
      ops: [{ op: "text", str: "plot1" }],
      device: { width: 800, height: 600 },
    }, { newPage: true });
    await browser.waitForType<FrameMessage>("frame");

    await t.step("resize sent to R", async () => {
      browser.sendResize(900, 700);
      const msg = await rClient.readMessage<ResizeMessage>();
      assertEquals(msg.width, 900);
    });

    await t.step("R sends new plot at resize dims (not a replay)", async () => {
      // R consumed the resize in cb_newPage's check_incoming and drew
      // the new plot at the resize dimensions.  No separate replay.
      // The newPage flag tells the server this is a new plot.
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot2-NEW" }],
        device: { width: 900, height: 700 },
      }, { newPage: true });
      const frame = await browser.waitForType<FrameMessage>("frame");

      assertEquals(
        frame.resize,
        undefined,
        "New plot must not be tagged as resize even when dims match pending entry",
      );
    });
  } finally {
    browser.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scenario 5 (Race B): R's recv_metrics_response consumes resize during
// drawing.  New-plot frame arrives at OLD dims with newPage:true.
//
// Timeline:
//   1. Browser sends resize(900,700) → pendingResizes entry pushed
//   2. R is drawing plot 2 with metrics.  recv_metrics_response reads the
//      resize → pending_w/h set but not applied during drawing.
//   3. R flushes plot 2 at OLD dims (800,600) with newPage:true.  Server
//      sees newPage → no dimension/FIFO matching → entry preserved.
//   4. R finishes, returns to prompt.  poll_resize_impl sees pending_w/h,
//      replays plot 2 at 900x700 → frame (no newPage).  Server matches
//      entry → tagged resize:true.  ✓
// ---------------------------------------------------------------------------

Deno.test("race B: new plot at old dims steals entry via FIFO fallback, replay untagged", async (t) => {
  const server = new TestServer();
  const rClient = new RClient();
  const browser = new BrowserClient();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await browser.connect(server.wsUrl);
    await rClient.waitForWelcome();

    // Prime: initial resize + first frame
    browser.sendResize(800, 600);
    await rClient.readMessage<ResizeMessage>();
    await rClient.sendFrame({
      ops: [{ op: "text", str: "plot1" }],
      device: { width: 800, height: 600 },
    }, { newPage: true });
    await browser.waitForType<FrameMessage>("frame");

    await t.step("resize sent to R", async () => {
      browser.sendResize(900, 700);
      const msg = await rClient.readMessage<ResizeMessage>();
      assertEquals(msg.width, 900);
    });

    await t.step("new plot at old dims — should not be tagged", async () => {
      // R was drawing when the resize arrived.  recv_metrics_response
      // consumed the resize message but didn't apply the dimensions.
      // The frame is flushed at the old dimensions with newPage:true.
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot2" }],
        device: { width: 800, height: 600 },
      }, { newPage: true });
      const frame = await browser.waitForType<FrameMessage>("frame");

      assertEquals(
        frame.resize,
        undefined,
        "New plot at old dims must not steal the resize entry",
      );
    });

    await t.step("resize replay at new dims — should be tagged", async () => {
      // R returns to prompt, poll_resize_impl applies pending_w/h and
      // replays the current plot at the new dimensions (no newPage flag).
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot2-resized" }],
        device: { width: 900, height: 700 },
      });
      const frame = await browser.waitForType<FrameMessage>("frame");

      assertEquals(
        frame.resize,
        true,
        "Resize replay must be tagged",
      );
    });
  } finally {
    browser.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scenario 6: Full duplicate sequence — three frames for two plots.
//
// This matches the user-reported symptom exactly:
//   [plot1, plot1-copy, plot2] instead of [plot1, plot2]
//
// Timeline:
//   1. Browser sends initial resize(800,600) → server pushes
//      pendingResizes entry, sends to R.
//   2. R does NOT process the resize before the user creates plot 1
//      (timing: user typed command before input handler fired).
//   3. R draws plot 1 at default dims with newPage:true → frame.
//      Server: newPage → no dim match → entry preserved.  ✓
//   4. R returns to prompt → input handler fires → poll_resize_impl
//      reads resize(800,600) → replays plot 1 at 800x600 → frame
//      (no newPage).  Server matches entry → tagged resize:true.  ✓
//   5. User creates plot 2 → frame with newPage:true → addPlot.  ✓
// ---------------------------------------------------------------------------

Deno.test("initial resize replay after first plot — must be tagged to avoid duplicate", async (t) => {
  const server = new TestServer();
  const rClient = new RClient();
  const browser = new BrowserClient();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await browser.connect(server.wsUrl);
    await rClient.waitForWelcome();

    await t.step("initial resize and plot 1 at default dims", async () => {
      // Browser sends initial resize — server pushes pendingResizes
      // entry and sends to R.
      browser.sendResize(800, 600);
      const msg = await rClient.readMessage<ResizeMessage>();
      assertEquals(msg.type, "resize");

      // R draws plot 1 at DEFAULT dimensions (the resize hasn't been
      // processed yet by R's input handler — user typed fast).
      // newPage:true tells the server this is a new plot.  The pending
      // entry (800,600) doesn't match (672,672) → entry preserved.
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot1" }],
        device: { width: 672, height: 672 },
      }, { newPage: true });
      const frame1 = await browser.waitForType<FrameMessage>("frame");
      assertEquals(frame1.resize, undefined, "Plot 1 is a new plot");
    });

    await t.step("R processes initial resize — replay must be tagged", async () => {
      // R's input handler fires, reads resize(800,600), replays plot 1
      // at 800x600.  The initial resize entry is now consumed and the
      // frame is tagged resize:true.
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot1-at-800" }],
        device: { width: 800, height: 600 },
      });
      const replay = await browser.waitForType<FrameMessage>("frame");

      assertEquals(
        replay.resize,
        true,
        "Initial resize replay must be tagged to prevent duplicate",
      );
    });

    await t.step("plot 2 — must be new plot", async () => {
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot2" }],
        device: { width: 800, height: 600 },
      }, { newPage: true });
      const frame = await browser.waitForType<FrameMessage>("frame");
      assertEquals(frame.resize, undefined, "Plot 2 must be a new plot");
    });
  } finally {
    browser.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scenario 7: Post-frame resize from ResizeObserver — the most common
// real-world sequence.
//
// After the browser renders the first frame, ResizeObserver fires with
// potentially different dims (e.g., scrollbar appeared, font loaded).
// This should produce a tagged replay, and the subsequent new plot
// should NOT be tagged.
// ---------------------------------------------------------------------------

Deno.test("post-frame ResizeObserver resize — no interference with new plot", async (t) => {
  const server = new TestServer();
  const rClient = new RClient();
  const browser = new BrowserClient();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await browser.connect(server.wsUrl);
    await rClient.waitForWelcome();

    // Initial resize
    browser.sendResize(800, 600);
    await rClient.readMessage<ResizeMessage>();

    // Plot 1
    await rClient.sendFrame({
      ops: [{ op: "text", str: "plot1" }],
      device: { width: 800, height: 600 },
    }, { newPage: true });
    const frame1 = await browser.waitForType<FrameMessage>("frame");
    assertEquals(frame1.resize, undefined, "Plot 1 is new");

    await t.step("ResizeObserver fires after render", async () => {
      // After rendering plot 1, ResizeObserver fires with slightly
      // different dims (e.g., scrollbar appeared).
      browser.sendResize(798, 598);
      const msg = await rClient.readMessage<ResizeMessage>();
      assertEquals(msg.width, 798);
    });

    await t.step("replay at ResizeObserver dims — tagged", async () => {
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot1-at-798" }],
        device: { width: 798, height: 598 },
      });
      const frame = await browser.waitForType<FrameMessage>("frame");
      assertEquals(frame.resize, true);
    });

    await t.step("plot 2 — new plot, not affected by resize", async () => {
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot2" }],
        device: { width: 798, height: 598 },
      }, { newPage: true });
      const frame = await browser.waitForType<FrameMessage>("frame");
      assertEquals(frame.resize, undefined, "Plot 2 must be a new plot");
    });
  } finally {
    browser.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scenario 8: Multiple resizes then new plot — all replays tagged,
// new plot untagged.
// ---------------------------------------------------------------------------

Deno.test("multiple resizes then new plot — all replays tagged", async (t) => {
  const server = new TestServer();
  const rClient = new RClient();
  const browser = new BrowserClient();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await browser.connect(server.wsUrl);
    await rClient.waitForWelcome();

    // Prime
    browser.sendResize(800, 600);
    await rClient.readMessage<ResizeMessage>();
    await rClient.sendFrame({
      ops: [{ op: "text", str: "plot1" }],
      device: { width: 800, height: 600 },
    }, { newPage: true });
    await browser.waitForType<FrameMessage>("frame");

    await t.step("two rapid resizes", async () => {
      browser.sendResize(900, 700);
      browser.sendResize(1000, 800);
      const r1 = await rClient.readMessage<ResizeMessage>();
      assertEquals(r1.width, 900);
      const r2 = await rClient.readMessage<ResizeMessage>();
      assertEquals(r2.width, 1000);
    });

    await t.step("both replays tagged", async () => {
      // R replays for first resize
      await rClient.sendFrame({
        ops: [{ op: "rect" }],
        device: { width: 900, height: 700 },
      });
      const f1 = await browser.waitForType<FrameMessage>("frame");
      assertEquals(f1.resize, true, "First replay tagged");

      // R replays for second resize
      await rClient.sendFrame({
        ops: [{ op: "rect" }],
        device: { width: 1000, height: 800 },
      });
      const f2 = await browser.waitForType<FrameMessage>("frame");
      assertEquals(f2.resize, true, "Second replay tagged");
    });

    await t.step("new plot — untagged", async () => {
      await rClient.sendFrame({
        ops: [{ op: "text", str: "plot2" }],
        device: { width: 1000, height: 800 },
      }, { newPage: true });
      const frame = await browser.waitForType<FrameMessage>("frame");
      assertEquals(frame.resize, undefined, "New plot untagged");
    });
  } finally {
    browser.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});
