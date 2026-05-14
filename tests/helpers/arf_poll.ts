import type { ArfSession } from "./arf_session.ts";

export async function pollResize(
  arf: ArfSession,
  iterations = 120,
): Promise<void> {
  await arf.eval(
    `for (i in 1:${iterations}) { .Call(jgd:::C_jgd_poll_resize); Sys.sleep(0.005) }`,
    60_000,
  );
}
