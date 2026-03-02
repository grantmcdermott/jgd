import type { Hub } from "./hub.ts";
import type { ServerInfoMessage } from "./types.ts";

/**
 * Narrow interface covering only the members that RSession and test helpers
 * need from a connection.  Both Deno.Conn and PipeConn satisfy this, so the
 * accept loop and test code can pass either without unsafe casts.
 */
export interface RConn {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  write(p: Uint8Array): Promise<number>;
  close(): void;
}

let sessionCounter = 0;

/**
 * RSession represents a connected R process communicating over a Unix socket
 * using NDJSON (newline-delimited JSON).
 */
export class RSession {
  id: string;
  /**
   * Queue of pending resize entries.  Each browser resize message pushes one
   * entry; each R frame consumes matching entries.  Entries store the resize
   * dimensions so the frame handler can use dimension matching to correctly
   * handle R-side coalescing (where R processes only the last of several
   * rapid resizes and sends a single replay frame).
   */
  pendingResizes: Array<{ plotIndex?: number; width?: number; height?: number }> = [];
  lastResizeW = 0;
  lastResizeH = 0;
  /** True after the first "frame" message has been received from R. */
  hasReceivedFrame = false;
  /** Whether the initial (ws.onopen) resize has been forwarded to R. */
  initialResizeSent = false;
  /**
   * Deferred resize (data + dimensions).  Resizes that arrive after the
   * initial one but before R's first frame are stored here instead of being
   * forwarded.  This prevents recv_metrics_response from stashing the
   * resize during text-metric waits, which would produce an untagged replay
   * frame (duplicate plot bug).  The deferred resize is forwarded after the
   * first frame arrives (see Hub.handleRMessage).
   */
  deferredResize: { data: string; width: number; height: number } | null = null;
  /** True when the server remapped this session's ID (retired ID dedup). */
  remappedSessionId = false;
  private conn: RConn;
  private hub: Hub;
  private encoder = new TextEncoder();
  /** Promise chain that serialises writes so they never interleave. */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(conn: RConn, hub: Hub) {
    sessionCounter++;
    this.id = `conn-${sessionCounter}`;
    this.conn = conn;
    this.hub = hub;
  }

  /** Send a message string to R, followed by a newline. */
  send(data: string): Promise<void> {
    const bytes = this.encoder.encode(data + "\n");
    const p = this.writeQueue.then(() => writeAll(this.conn, bytes));
    // Keep the chain going even if a write fails, so subsequent
    // sends don't wait on a rejected promise forever.
    this.writeQueue = p.catch(() => {});
    return p;
  }

  /** Send a message to R, logging and swallowing send errors. */
  trySend(data: string): void {
    this.send(data).catch((e) => {
      console.error(`failed to send to R session ${this.id}: ${e}`);
    });
  }

  /** Close the underlying connection. */
  close(): void {
    try {
      this.conn.close();
    } catch { /* ignore if already closed */ }
  }

  /**
   * Read NDJSON messages from the connection and route through the hub.
   * Returns when the connection is closed or an error occurs.
   */
  async run(): Promise<void> {
    this.hub.registerSession(this);

    try {
      const reader = this.conn.readable
        .pipeThrough(new TextDecoderStream());

      let buffer = "";
      let firstMessage = true;
      let welcomeSent = false;

      for await (const chunk of reader) {
        buffer += chunk;
        let newlineIdx: number;

        while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);

          if (line.length === 0) continue;

          // Send welcome after the first line is received.  On Windows
          // named pipes, writing to the socket before the first read
          // completes can cause Deno's node:net layer to drop subsequent
          // read data.  Deferring the write until we have proof the read
          // side works avoids this race entirely.
          if (!welcomeSent) {
            welcomeSent = true;
            const welcome: ServerInfoMessage = {
              type: "server_info",
              serverName: "jgd-http-server",
              protocolVersion: 1,
              transport: this.hub.transport,
              serverInfo: {
                httpUrl: `http://127.0.0.1:${this.hub.httpPort}/`,
              },
            };
            this.send(JSON.stringify(welcome)).catch((e) => {
              if (
                !(e instanceof Deno.errors.BrokenPipe) &&
                !(e instanceof Deno.errors.ConnectionReset) &&
                !(e instanceof Deno.errors.BadResource)
              ) {
                console.error(`welcome send error: ${e}`);
              }
            });
          }

          // Extract session ID from first message that contains one.
          // Messages without a sessionId (e.g. pings) are skipped so
          // the real first frame still gets its ID extracted.
          if (firstMessage) {
            const sid = extractSessionId(line);
            if (sid) {
              firstMessage = false;
              const oldId = this.id;
              this.id = sid;
              this.hub.updateSessionId(oldId, sid, this);
              console.error(`R session ${oldId} identified as ${sid}`);
            }
          }

          this.hub.handleRMessage(this, line);
        }
      }

      console.error(`R session ${this.id} disconnected`);
    } catch (e) {
      // BadResource means the connection was closed (normal during shutdown)
      if (!(e instanceof Deno.errors.BadResource)) {
        console.error(`R session ${this.id} read error: ${e}`);
      } else {
        console.error(`R session ${this.id} disconnected`);
      }
    } finally {
      this.hub.unregisterSession(this.id);
    }
  }
}

/**
 * Extract plot.sessionId from a JSON message line.
 * Returns empty string if not found or not parseable.
 */
function extractSessionId(line: string): string {
  try {
    const msg = JSON.parse(line);
    return msg?.plot?.sessionId || "";
  } catch {
    return "";
  }
}

/** Write all bytes to a writer, handling partial writes. */
async function writeAll(w: RConn, data: Uint8Array): Promise<void> {
  let written = 0;
  while (written < data.byteLength) {
    written += await w.write(data.subarray(written));
  }
}
