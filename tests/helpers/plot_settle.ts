import { delay } from "@std/async";
import {
  type E2EBrowser,
  plotInfoText,
} from "../../server/tests/helpers/e2e_browser.ts";

export async function assertPlotInfoStable(
  page: Awaited<ReturnType<E2EBrowser["newPage"]>>,
  expected: string,
  quietMs = 1_500,
  pollMs = 100,
): Promise<void> {
  const deadline = Date.now() + quietMs;
  while (true) {
    const info = await plotInfoText(page);
    if (info !== expected) {
      throw new Error(
        `plotInfo changed during quiet window: expected "${expected}", got "${info}"`,
      );
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await delay(Math.min(pollMs, remainingMs));
  }
}
