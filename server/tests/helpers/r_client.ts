import type {
  CloseMessage,
  FrameMessage,
  MetricsRequestMessage,
  ServerMessage,
} from "./types.ts";
import { PipeConn } from "../../named_pipe.ts";
import type { RConn } from "../../r_session.ts";
import { connect as nodeConnect } from "node:net";

/**
 * Simulates an R session connecting to the server via Unix socket or TCP (NDJSON).
 */
export class RClient {
  #conn: RConn | null = null;
  #reader: ReadableStreamDefaultReader<string> | null = null;
  #writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #encoder = new TextEncoder();
  #buffer = "";

  /** Connect to the server's socket. Supports Unix path, "tcp:PORT", or "npipe:///NAME". */
  async connect(socketPath: string): Promise<void> {
    if (socketPath.startsWith("tcp:")) {
      const port = parseInt(socketPath.slice(4), 10);
      this.#conn = await Deno.connect({
        transport: "tcp",
        hostname: "127.0.0.1",
        port,
      });
    } else if (socketPath.startsWith("npipe:///")) {
      const pipeName = socketPath.slice("npipe:///".length);
      const pipePath = `\\\\.\\pipe\\${pipeName}`;
      const socket = await new Promise<import("node:net").Socket>(
        (resolve, reject) => {
          const s = nodeConnect(pipePath, () => resolve(s));
          s.once("error", reject);
        },
      );
      this.#conn = new PipeConn(socket);
    } else {
      this.#conn = await Deno.connect({
        transport: "unix",
        path: socketPath,
      });
    }

    const stream = this.#conn.readable.pipeThrough(new TextDecoderStream());
    this.#reader = stream.getReader();
    this.#writer = this.#conn.writable.getWriter();
  }

  /** Send a JSON message followed by newline (NDJSON). */
  async send(msg: ServerMessage | Record<string, unknown>): Promise<void> {
    const data = this.#encoder.encode(JSON.stringify(msg) + "\n");
    await this.#writer!.write(data);
  }

  /** Send a frame message. */
  async sendFrame(
    plot: FrameMessage["plot"],
    incremental = false,
  ): Promise<void> {
    await this.send({ type: "frame", plot, incremental });
  }

  /** Send a metrics request. */
  async sendMetricsRequest(id: number, kind: "strWidth" | "metricInfo" = "strWidth"): Promise<void> {
    const msg: MetricsRequestMessage = {
      type: "metrics_request",
      id,
      kind,
      str: kind === "strWidth" ? "test" : undefined,
      c: kind === "metricInfo" ? 77 : undefined,
      gc: { font: { family: "sans", face: 1, size: 12 } },
    };
    await this.send(msg);
  }

  /** Send a close message. */
  async sendClose(): Promise<void> {
    const msg: CloseMessage = { type: "close" };
    await this.send(msg);
  }

  /** Read the next NDJSON line with timeout (ms). */
  async readMessage<T = ServerMessage>(timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const newlineIdx = this.#buffer.indexOf("\n");
      if (newlineIdx >= 0) {
        const line = this.#buffer.slice(0, newlineIdx);
        this.#buffer = this.#buffer.slice(newlineIdx + 1);
        return JSON.parse(line) as T;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      const { promise: timeoutPromise, cancel } = createCancellableTimeout(remaining);
      try {
        const result = await Promise.race([
          this.#reader!.read(),
          timeoutPromise,
        ]);

        if (result === null) break;
        cancel();
        const { value, done } = result as ReadableStreamReadResult<string>;
        if (done) throw new Error("Connection closed while reading");
        this.#buffer += value;
      } catch {
        break;
      }
    }

    throw new Error(`Timed out waiting for message (${timeoutMs}ms)`);
  }

  /** Close the connection. */
  close(): void {
    try {
      this.#writer?.releaseLock();
    } catch {
      // ignore
    }
    try {
      this.#reader?.cancel();
    } catch {
      // ignore
    }
    try {
      this.#conn?.close();
    } catch {
      // ignore
    }
    this.#conn = null;
    this.#reader = null;
    this.#writer = null;
  }
}

/** Create a timeout that can be cancelled to avoid timer leaks. */
function createCancellableTimeout(ms: number): {
  promise: Promise<null>;
  cancel: () => void;
} {
  let timer: number;
  const promise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return {
    promise,
    cancel: () => clearTimeout(timer),
  };
}
