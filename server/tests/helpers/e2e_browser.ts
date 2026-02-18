import { launch } from "@astral/astral";
import type { Browser, Page } from "@astral/astral";
import type { RClient } from "./r_client.ts";
import type { ServerMessage } from "./types.ts";

/**
 * Wraps Astral browser lifecycle for E2E tests.
 * Launches headless Chrome once, creates pages per test.
 */
export class E2EBrowser {
  #browser: Browser | null = null;

  async launch(): Promise<void> {
    this.#browser = await launch({ headless: true });
  }

  async newPage(url: string): Promise<Page> {
    if (!this.#browser) throw new Error("Browser not launched");
    const page = await this.#browser.newPage(url);
    return page;
  }

  async close(): Promise<void> {
    if (this.#browser) {
      await this.#browser.close();
      this.#browser = null;
    }
  }
}

/** Check if canvas at the fixed #plot-canvas element has any non-transparent pixels. */
export async function canvasHasContent(page: Page): Promise<boolean> {
  return await page.evaluate(`(function() {
    var c = document.getElementById('plot-canvas');
    if (!c || c.width === 0 || c.height === 0) return false;
    var ctx = c.getContext('2d');
    var data = ctx.getImageData(0, 0, c.width, c.height).data;
    for (var i = 3; i < data.length; i += 4) {
      if (data[i] > 0) return true;
    }
    return false;
  })()`) as boolean;
}

/** Get the canvas pixel dimensions (accounting for DPR). */
export async function canvasDimensions(page: Page): Promise<{ width: number; height: number }> {
  return await page.evaluate(`(function() {
    var c = document.getElementById('plot-canvas');
    return { width: c ? c.width : 0, height: c ? c.height : 0 };
  })()`) as { width: number; height: number };
}

/** Get toolbar text content. */
export async function plotInfoText(page: Page): Promise<string> {
  return await page.evaluate(`(function() {
    var el = document.getElementById('plot-info');
    return el ? el.textContent : '';
  })()`) as string;
}

/** Read messages from R, skipping any that don't match. Defaults to 5 s timeout. */
export async function readOfType<T extends ServerMessage>(
  rClient: RClient,
  type: string,
  timeoutMs?: number,
  predicate?: (msg: T) => boolean,
): Promise<T>;
export async function readOfType<T extends ServerMessage>(
  rClient: RClient,
  type: string,
  predicate?: (msg: T) => boolean,
): Promise<T>;
export async function readOfType<T extends ServerMessage>(
  rClient: RClient,
  type: string,
  timeoutOrPredicate?: number | ((msg: T) => boolean),
  maybePredicate?: (msg: T) => boolean,
): Promise<T> {
  const timeoutMs = typeof timeoutOrPredicate === "number" ? timeoutOrPredicate : 5000;
  const predicate = typeof timeoutOrPredicate === "function" ? timeoutOrPredicate : maybePredicate;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const msg = await rClient.readMessage<ServerMessage>(remaining);
    if (msg.type === type && (!predicate || predicate(msg as T))) return msg as T;
  }
  throw new Error(`Timed out waiting for message of type "${type}"`);
}
