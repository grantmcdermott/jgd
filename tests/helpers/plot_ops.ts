import type { FrameMessage } from "../../server/tests/helpers/types.ts";

/**
 * Extract text op strings from a frame's ops for content identification.
 */
export function extractTextOps(frame: FrameMessage): string[] {
  return (frame.plot.ops as Array<Record<string, unknown>>)
    .filter((op) => op.op === "text")
    .map((op) => op.str as string);
}
