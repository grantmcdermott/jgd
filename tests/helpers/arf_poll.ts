import type { ArfSession } from "./arf_session.ts";

export async function pollResize(
  arf: ArfSession,
  iterations = 120,
): Promise<void> {
  if (!Number.isInteger(iterations) || iterations < 0) {
    throw new Error(
      `pollResize: iterations must be a non-negative integer, got ${iterations}`,
    );
  }
  // seq_len() yields integer(0) for 0, so the loop body never runs.
  // (Note: 1:0 in R would unexpectedly produce c(1, 0) and run twice.)
  await arf.eval(
    `for (i in seq_len(${iterations})) { .Call(jgd:::C_jgd_poll_resize); Sys.sleep(0.005) }`,
    60_000,
  );
}
