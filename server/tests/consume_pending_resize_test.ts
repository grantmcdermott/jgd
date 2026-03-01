/**
 * Unit tests for consumePendingResize — the pure function that decides
 * which pendingResizes entry to consume for a given frame.
 */

import { assertEquals } from "@std/assert";
import { consumePendingResize } from "../hub.ts";

// Helper to build a normal entry.
function normal(w: number, h: number) {
  return { plotIndex: undefined, width: w, height: h };
}

// Helper to build a plotIndex entry.
function indexed(plotIndex: number, w: number, h: number) {
  return { plotIndex, width: w, height: h };
}

// ---------------------------------------------------------------------------
// Empty queue
// ---------------------------------------------------------------------------

Deno.test("empty queue returns undefined", () => {
  const queue: Array<{ plotIndex?: number; width?: number; height?: number }> = [];
  assertEquals(consumePendingResize(queue, { width: 800, height: 600 }), undefined);
  assertEquals(queue.length, 0);
});

// ---------------------------------------------------------------------------
// plotIndex entries — strict FIFO
// ---------------------------------------------------------------------------

Deno.test("plotIndex entry consumed FIFO regardless of dimensions", () => {
  const queue = [indexed(0, 800, 600), indexed(1, 900, 700)];
  const entry = consumePendingResize(queue, { width: 900, height: 700 });
  assertEquals(entry?.plotIndex, 0);
  assertEquals(queue.length, 1);
});

Deno.test("plotIndex entry consumed even when frameDims is null", () => {
  const queue = [indexed(2, 800, 600)];
  const entry = consumePendingResize(queue, null);
  assertEquals(entry?.plotIndex, 2);
  assertEquals(queue.length, 0);
});

// ---------------------------------------------------------------------------
// Normal entries — first-match FIFO
// ---------------------------------------------------------------------------

Deno.test("first entry matches — consumed directly (FIFO)", () => {
  const queue = [normal(800, 600), normal(900, 700)];
  const entry = consumePendingResize(queue, { width: 800, height: 600 });
  assertEquals(entry?.plotIndex, undefined);
  assertEquals(queue.length, 1);
  assertEquals(queue[0].width, 900);
});

// ---------------------------------------------------------------------------
// Normal entries — A, B, A pattern (first-match prevents over-consumption)
// ---------------------------------------------------------------------------

Deno.test("A, B, A pattern — first match consumed, rest preserved", () => {
  const queue = [normal(800, 600), normal(900, 700), normal(800, 600)];

  // Frame 1: 800x600 — matches first entry, consume only it.
  const e1 = consumePendingResize(queue, { width: 800, height: 600 });
  assertEquals(e1?.plotIndex, undefined);
  assertEquals(queue.length, 2);
  assertEquals(queue[0].width, 900);

  // Frame 2: 900x700 — matches first remaining entry.
  const e2 = consumePendingResize(queue, { width: 900, height: 700 });
  assertEquals(e2?.plotIndex, undefined);
  assertEquals(queue.length, 1);

  // Frame 3: 800x600 — matches last remaining entry.
  const e3 = consumePendingResize(queue, { width: 800, height: 600 });
  assertEquals(e3?.plotIndex, undefined);
  assertEquals(queue.length, 0);
});

// ---------------------------------------------------------------------------
// Normal entries — R-side coalescing (first entry does NOT match)
// ---------------------------------------------------------------------------

Deno.test("coalescing: R skips first two, responds at last dims", () => {
  const queue = [normal(800, 600), normal(900, 700), normal(1024, 768)];

  // R coalesces all three and sends one frame at 1024x768.
  const entry = consumePendingResize(queue, { width: 1024, height: 768 });
  assertEquals(entry?.plotIndex, undefined);
  assertEquals(queue.length, 0, "all three entries should be drained");
});

Deno.test("coalescing: R skips first, responds at second dims", () => {
  const queue = [normal(800, 600), normal(900, 700)];

  const entry = consumePendingResize(queue, { width: 900, height: 700 });
  assertEquals(entry?.plotIndex, undefined);
  assertEquals(queue.length, 0);
});

// ---------------------------------------------------------------------------
// Normal entries — no dimension match (fallback FIFO)
// ---------------------------------------------------------------------------

Deno.test("no match — falls back to FIFO", () => {
  const queue = [normal(800, 600)];
  const entry = consumePendingResize(queue, { width: 1024, height: 768 });
  assertEquals(entry?.plotIndex, undefined);
  assertEquals(queue.length, 0);
});

// ---------------------------------------------------------------------------
// Null frameDims — fallback FIFO
// ---------------------------------------------------------------------------

Deno.test("null frameDims on normal entry — falls back to FIFO", () => {
  const queue = [normal(800, 600), normal(900, 700)];
  const entry = consumePendingResize(queue, null);
  assertEquals(entry?.plotIndex, undefined);
  assertEquals(queue.length, 1);
  assertEquals(queue[0].width, 900);
});

// ---------------------------------------------------------------------------
// Mixed normal + plotIndex — plotIndex boundary stops coalescing search
// ---------------------------------------------------------------------------

Deno.test("coalescing search stops at plotIndex boundary", () => {
  const queue = [
    normal(800, 600),
    indexed(0, 640, 480),
    normal(1024, 768),
  ];

  // Frame at 1024x768: the search for a match should stop at the
  // plotIndex entry, so it won't find the 1024x768 entry beyond it.
  // Falls back to FIFO (consume 800x600).
  const entry = consumePendingResize(queue, { width: 1024, height: 768 });
  assertEquals(entry?.plotIndex, undefined);
  assertEquals(queue.length, 2);
  assertEquals(queue[0].plotIndex, 0, "plotIndex entry should remain");
});
