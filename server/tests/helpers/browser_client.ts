import type { MetricsResponseMessage, ResizeMessage, ServerMessage } from "./types.ts";

/**
 * Simulates a browser connecting to the server via WebSocket.
 */
export class BrowserClient {
  #ws: WebSocket | null = null;
  #queue: ServerMessage[] = [];
  #waiters: Array<{
    predicate: (msg: ServerMessage) => boolean;
    resolve: (msg: ServerMessage) => void;
    timer: number;
  }> = [];

  /** Connect to the server's WebSocket endpoint. */
  connect(wsUrl: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#ws = new WebSocket(wsUrl);

      this.#ws.onopen = () => resolve();
      this.#ws.onerror = (e) =>
        reject(new Error(`WebSocket error: ${e}`));

      this.#ws.onmessage = (event: MessageEvent) => {
        const msg: ServerMessage = JSON.parse(event.data as string);

        // Check if any waiter matches
        for (let i = 0; i < this.#waiters.length; i++) {
          if (this.#waiters[i].predicate(msg)) {
            const waiter = this.#waiters.splice(i, 1)[0];
            waiter.resolve(msg);
            return;
          }
        }

        // No waiter matched, queue the message
        this.#queue.push(msg);
      };
    });
  }

  /** Wait for a message matching the predicate. */
  waitForMessage<T extends ServerMessage = ServerMessage>(
    predicate: (msg: ServerMessage) => boolean,
    timeoutMs = 5000,
  ): Promise<T> {
    // Check the queue first
    for (let i = 0; i < this.#queue.length; i++) {
      if (predicate(this.#queue[i])) {
        return Promise.resolve(this.#queue.splice(i, 1)[0] as T);
      }
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.#waiters.findIndex((w) => w.resolve === typedResolve);
        if (idx >= 0) this.#waiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for message (${timeoutMs}ms)`));
      }, timeoutMs);

      const typedResolve = (msg: ServerMessage) => {
        clearTimeout(timer);
        resolve(msg as T);
      };

      this.#waiters.push({ predicate, resolve: typedResolve, timer });
    });
  }

  /** Wait for a message of a specific type. */
  waitForType<T extends ServerMessage = ServerMessage>(
    type: string,
    timeoutMs = 5000,
  ): Promise<T> {
    return this.waitForMessage<T>(
      (msg) => msg.type === type,
      timeoutMs,
    );
  }

  /** Send a resize message. */
  send(msg: ServerMessage | Record<string, unknown>): void {
    this.#ws!.send(JSON.stringify(msg));
  }

  /** Send a resize message. */
  sendResize(width: number, height: number): void {
    const msg: ResizeMessage = { type: "resize", width, height };
    this.send(msg);
  }

  /** Send a resize message with a plotIndex for historical plot resizing. */
  sendResizeWithPlotIndex(width: number, height: number, plotIndex: number): void {
    this.send({ type: "resize", width, height, plotIndex });
  }

  /** Send a metrics response. */
  sendMetricsResponse(
    id: number,
    width: number,
    ascent: number,
    descent: number,
  ): void {
    const msg: MetricsResponseMessage = {
      type: "metrics_response",
      id,
      width,
      ascent,
      descent,
    };
    this.send(msg);
  }

  /** Close the connection and cancel pending waiters. */
  close(): void {
    for (const w of this.#waiters) {
      clearTimeout(w.timer);
    }
    this.#waiters = [];
    try {
      this.#ws?.close();
    } catch {
      // ignore
    }
    this.#ws = null;
  }
}
