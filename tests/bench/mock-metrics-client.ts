/**
 * Mock WebSocket client that auto-responds to metrics_request messages.
 *
 * Connects to the jgd server's WebSocket endpoint and provides instant
 * approximate text metrics, removing browser latency from benchmarks.
 *
 * Usage:
 *   deno run --allow-net mock-metrics-client.ts <ws_url>
 *
 * Or import and use programmatically:
 *   const client = new MockMetricsClient(wsUrl);
 *   await client.connect();
 *   // ... run benchmarks ...
 *   const stats = client.stats();
 *   client.close();
 */

import type {
  FrameMessage,
  MetricsRequestMessage,
  ServerMessage,
} from "../../server/tests/helpers/types.ts";

export interface MockMetricsStats {
  metricsRequests: number;
  strWidthRequests: number;
  metricInfoRequests: number;
  framesReceived: number;
  totalOps: number;
  lastFrameOps: number;
}

export class MockMetricsClient {
  #ws: WebSocket | null = null;
  #metricsRequests = 0;
  #strWidthRequests = 0;
  #metricInfoRequests = 0;
  #framesReceived = 0;
  #totalOps = 0;
  #lastFrameOps = 0;
  #onFrame: ((msg: FrameMessage) => void) | null = null;

  constructor(private url: string) {}

  /** Set a callback for frame messages. */
  onFrame(cb: (msg: FrameMessage) => void): void {
    this.#onFrame = cb;
  }

  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#ws = new WebSocket(this.url);
      this.#ws.onopen = () => {
        // Send initial resize so R knows the viewport size
        this.#ws!.send(
          JSON.stringify({ type: "resize", width: 800, height: 600 }),
        );
        resolve();
      };
      this.#ws.onerror = (e) => reject(new Error(`WebSocket error: ${e}`));
      this.#ws.onmessage = (event: MessageEvent) => {
        this.#handleMessage(JSON.parse(event.data as string));
      };
    });
  }

  #handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "metrics_request":
        this.#handleMetrics(msg as MetricsRequestMessage);
        break;
      case "frame": {
        this.#framesReceived++;
        const ops = (msg as FrameMessage).plot?.ops?.length ?? 0;
        this.#totalOps += ops;
        this.#lastFrameOps = ops;
        this.#onFrame?.(msg as FrameMessage);
        break;
      }
    }
  }

  #handleMetrics(msg: MetricsRequestMessage): void {
    this.#metricsRequests++;
    const size = msg.gc?.font?.size ?? 12;

    if (msg.kind === "strWidth") {
      this.#strWidthRequests++;
      const str = msg.str ?? "";
      this.#ws!.send(
        JSON.stringify({
          type: "metrics_response",
          id: msg.id,
          width: str.length * size * 0.55,
          ascent: 0,
          descent: 0,
        }),
      );
    } else if (msg.kind === "metricInfo") {
      this.#metricInfoRequests++;
      this.#ws!.send(
        JSON.stringify({
          type: "metrics_response",
          id: msg.id,
          width: size * 0.55,
          ascent: size * 0.75,
          descent: size * 0.25,
        }),
      );
    }
  }

  stats(): MockMetricsStats {
    return {
      metricsRequests: this.#metricsRequests,
      strWidthRequests: this.#strWidthRequests,
      metricInfoRequests: this.#metricInfoRequests,
      framesReceived: this.#framesReceived,
      totalOps: this.#totalOps,
      lastFrameOps: this.#lastFrameOps,
    };
  }

  reset(): void {
    this.#metricsRequests = 0;
    this.#strWidthRequests = 0;
    this.#metricInfoRequests = 0;
    this.#framesReceived = 0;
    this.#totalOps = 0;
    this.#lastFrameOps = 0;
  }

  close(): void {
    try {
      this.#ws?.close();
    } catch {
      // ignore
    }
    this.#ws = null;
  }
}

// CLI mode: run standalone
if (import.meta.main) {
  const url = Deno.args[0];
  if (!url) {
    console.error("Usage: deno run --allow-net mock-metrics-client.ts <ws_url>");
    Deno.exit(1);
  }

  const client = new MockMetricsClient(url);
  client.onFrame((msg) => {
    const ops = msg.plot?.ops?.length ?? 0;
    console.log(
      `frame: ${ops} ops, incremental=${msg.incremental}`,
    );
  });

  await client.connect();
  console.log(`Connected to ${url}`);

  Deno.addSignalListener("SIGINT", () => {
    const s = client.stats();
    console.log(`\nStats: ${JSON.stringify(s, null, 2)}`);
    client.close();
    Deno.exit(0);
  });

  // Keep alive
  await new Promise(() => {});
}
