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
  /** Whether the next frame should be tagged as a resize response. */
  resizePending = false;
  lastResizeW = 0;
  lastResizeH = 0;
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
      // Set up reader before sending welcome so the readable stream is
      // piped before R can finish and close the connection.  On Unix
      // sockets, reading from a connection whose remote end already
      // closed may miss buffered data if the stream wasn't set up yet.
      const reader = this.conn.readable
        .pipeThrough(new TextDecoderStream());

      // Send welcome message.  The readable stream is already piped above,
      // so the await here won't cause data loss even if R replies quickly.
      // If R has already closed the connection (fast plot + dev.off()),
      // the write fails with BrokenPipe — catch it so the read loop below
      // can still process any buffered data R sent before closing.
      const welcome: ServerInfoMessage = {
        type: "server_info",
        serverName: "jgd-http-server",
        protocolVersion: 1,
        serverInfo: {
          httpUrl: `http://127.0.0.1:${this.hub.httpPort}/`,
        },
      };
      try {
        await this.send(JSON.stringify(welcome));
      } catch (e) {
        if (
          !(e instanceof Deno.errors.BrokenPipe) &&
          !(e instanceof Deno.errors.ConnectionReset) &&
          !(e instanceof Deno.errors.BadResource)
        ) {
          throw e;
        }
        // Connection closed — continue to drain buffered data
      }

      let buffer = "";
      let firstMessage = true;

      for await (const chunk of reader) {
        buffer += chunk;
        let newlineIdx: number;

        while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);

          if (line.length === 0) continue;

          // Extract session ID from first message's plot.sessionId
          if (firstMessage) {
            firstMessage = false;
            const sid = extractSessionId(line);
            if (sid) {
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
