/**
 * BrowserClient wrapper that automatically responds to metrics_request messages.
 *
 * Uses composition (not subclass) since BrowserClient's WebSocket is private.
 * Runs an async loop that waits for metrics_request messages and responds with
 * stub metric values, allowing frame/close waiters to coexist without conflict.
 */

import { BrowserClient } from "../../server/tests/helpers/browser_client.ts";
import type {
  MetricsRequestMessage,
  ServerMessage,
} from "../../server/tests/helpers/types.ts";

export class AutoMetricsBrowserClient {
  #inner: BrowserClient;
  #loopPromise: Promise<void> | null = null;
  #stopped = false;

  /** Collected metrics requests for test inspection. */
  metricsRequests: MetricsRequestMessage[] = [];

  constructor() {
    this.#inner = new BrowserClient();
  }

  /** Connect to the server and start the auto-response loop. */
  async connect(wsUrl: string): Promise<void> {
    await this.#inner.connect(wsUrl);
    this.#loopPromise = this.#metricsLoop().catch(() => {});
  }

  /** Auto-respond to metrics_request messages until closed. */
  async #metricsLoop(): Promise<void> {
    while (!this.#stopped) {
      try {
        const msg = await this.#inner.waitForType<MetricsRequestMessage>(
          "metrics_request",
          60_000,
        );
        this.metricsRequests.push(msg);

        const fontSize = msg.gc?.font?.size ?? 12;

        if (msg.kind === "strWidth") {
          const charWidth = fontSize * 0.53;
          const width = (msg.str?.length ?? 0) * charWidth;
          this.#inner.sendMetricsResponse(msg.id, width, 0, 0);
        } else {
          // metricInfo
          const ascent = fontSize * 0.8;
          const descent = fontSize * 0.2;
          const width = fontSize * 0.53;
          this.#inner.sendMetricsResponse(msg.id, width, ascent, descent);
        }
      } catch {
        // Timeout or close — exit loop
        break;
      }
    }
  }

  /** Wait for a non-metrics message by type (delegates to inner BrowserClient). */
  waitForType<T extends ServerMessage = ServerMessage>(
    type: string,
    timeoutMs = 10_000,
  ): Promise<T> {
    return this.#inner.waitForType<T>(type, timeoutMs);
  }

  /** Send a resize message. */
  sendResize(width: number, height: number): void {
    this.#inner.sendResize(width, height);
  }

  /** Close the connection and stop the metrics loop. */
  close(): void {
    this.#stopped = true;
    this.#inner.close();
  }
}
