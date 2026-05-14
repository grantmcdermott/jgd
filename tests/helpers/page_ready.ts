import { delay } from "@std/async";
import type { E2EBrowser } from "../../server/tests/helpers/e2e_browser.ts";

type Page = Awaited<ReturnType<E2EBrowser["newPage"]>>;

/**
 * Wait until the page's WebSocket has opened (the web client sets
 * `#ws-status.className = 'connected'` in its `ws.onopen` handler).
 *
 * Replaces fixed `await delay(...)` calls that were used as a proxy for
 * "the page is connected"; under slow CI those fixed waits can resolve
 * before `onopen` fires, causing initial frames to be lost.
 */
export async function waitForWsConnected(
  page: Page,
  timeoutMs = 10_000,
  pollMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await page.evaluate(`(function() {
      var el = document.getElementById('ws-status');
      return !!el && el.className === 'connected';
    })()`) as boolean;
    if (connected) return;
    await delay(pollMs);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for #ws-status.connected`,
  );
}
