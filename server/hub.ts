import type { RSession } from "./r_session.ts";

/** Placeholder for browser clients (implemented in be2.2). */
export interface BrowserClient {
  send(data: string): void;
  close(): void;
}

/**
 * Hub routes messages between R sessions and browser clients.
 * JS is single-threaded so no mutex is needed — Map/Set suffice.
 */
export class Hub {
  sessions = new Map<string, RSession>();
  clients = new Set<BrowserClient>();
  /** Maps metrics request ID → R session ID for routing responses. */
  metricsRouting = new Map<number, string>();
  /** HTTP server port, set after the HTTP server starts. */
  httpPort = 0;
  /** R transport type: "tcp", "unix", or "npipe". */
  transport: "tcp" | "unix" | "npipe" = "tcp";
  verbose = false;

  registerSession(session: RSession): void {
    this.sessions.set(session.id, session);
    console.error(
      `R session registered: ${session.id} (total: ${this.sessions.size})`,
    );
  }

  unregisterSession(id: string): void {
    this.sessions.delete(id);
    // Clean up any pending metrics routing entries for this session
    for (const [reqId, sessId] of this.metricsRouting) {
      if (sessId === id) {
        this.metricsRouting.delete(reqId);
      }
    }
    console.error(
      `R session unregistered: ${id} (total: ${this.sessions.size})`,
    );
  }

  /**
   * Update a session's ID (when the real sessionId is extracted from the
   * first frame message).
   */
  updateSessionId(oldId: string, newId: string, session: RSession): void {
    this.sessions.delete(oldId);
    this.sessions.set(newId, session);
    // Update any pending metrics routing entries to use the new session ID
    for (const [reqId, sessId] of this.metricsRouting) {
      if (sessId === oldId) {
        this.metricsRouting.set(reqId, newId);
      }
    }
  }

  /** Broadcast a message string to all connected browser clients. */
  broadcastToClients(data: string): void {
    for (const client of this.clients) {
      try {
        client.send(data);
      } catch {
        // Slow/dead client — ignore
      }
    }
  }

  /** Broadcast a message string to all connected R sessions. */
  broadcastToR(data: string): void {
    for (const session of this.sessions.values()) {
      session.send(data).catch((e) => {
        console.error(
          `failed to send to R session ${session.id}: ${e}`,
        );
      });
    }
  }

  /**
   * Broadcast a resize message to all R sessions, marking each so the
   * next frame can be tagged as a resize response.
   * Duplicate resizes with identical dimensions are silently dropped.
   */
  broadcastResizeToR(data: string): void {
    let dims: { width: number; height: number; plotIndex?: number } | null = null;
    try {
      const parsed = JSON.parse(data);
      if (typeof parsed.width === "number" && typeof parsed.height === "number" &&
          (parsed.width > 0 || parsed.height > 0)) {
        dims = parsed;
      }
    } catch { /* malformed — skip dedup, always arm */ }

    const hasPlotIndex = dims !== null && typeof dims.plotIndex === "number";

    for (const session of this.sessions.values()) {
      if (hasPlotIndex) {
        // plotIndex resizes bypass dedup — always forward, don't update
        // lastResize dims so subsequent normal resizes still dedup correctly.
        session.resizePending = true;
        session.pendingPlotIndex = dims!.plotIndex;
      } else if (dims) {
        // When dimensions haven't changed, skip entirely — don't forward
        // to R and don't arm the flag.  This prevents duplicate resizes
        // (ws.onopen + ResizeObserver with same dims) from generating
        // untagged frames that corrupt plot history.
        if (dims.width === session.lastResizeW && dims.height === session.lastResizeH) {
          continue;
        }
        session.resizePending = true;
        session.pendingPlotIndex = undefined;
        session.lastResizeW = dims.width;
        session.lastResizeH = dims.height;
      } else {
        session.resizePending = true;
      }
      session.send(data).catch((e) => {
        console.error(
          `failed to send to R session ${session.id}: ${e}`,
        );
      });
    }
  }

  /**
   * Process a message from an R session.
   * Routes based on message type (frame, metrics_request, close, etc.).
   */
  handleRMessage(session: RSession, line: string): void {
    const type = extractType(line);

    switch (type) {
      case "frame": {
        let data = line;
        // Tag resize-triggered frames so the browser can update in place
        if (session.resizePending) {
          session.resizePending = false;
          data = injectResizeFlag(data);
          // If this resize targeted a historical plot, tag the frame
          if (session.pendingPlotIndex !== undefined) {
            data = injectPlotIndex(data, session.pendingPlotIndex);
            session.pendingPlotIndex = undefined;
          }
        }
        // Inject sessionId into the plot object if not present
        if (session.id && !data.includes('"sessionId"')) {
          data = injectSessionId(data, session.id);
        }
        this.broadcastToClients(data);
        if (this.verbose) {
          console.error(
            `frame from R session ${session.id} (${data.length} bytes)`,
          );
        }
        break;
      }

      case "metrics_request":
        this.handleMetricsRequest(session, line);
        break;

      case "close":
        if (this.verbose) {
          console.error(`device close from R session ${session.id}`);
        }
        this.broadcastToClients(line);
        break;

      default:
        // Unknown message type — forward to browsers
        this.broadcastToClients(line);
        break;
    }
  }

  /**
   * Route a metrics request from R to browsers, with timeout fallback.
   */
  private handleMetricsRequest(session: RSession, line: string): void {
    let id: number;
    try {
      const msg = JSON.parse(line);
      id = msg.id;
    } catch {
      console.error("failed to parse metrics request");
      return;
    }

    if (typeof id !== "number" || !Number.isFinite(id)) {
      console.error("metrics request has invalid id");
      return;
    }

    // No browsers connected → immediately send zero-value fallback
    if (this.clients.size === 0) {
      const fallback = JSON.stringify({
        type: "metrics_response",
        id,
        width: 0,
        ascent: 0,
        descent: 0,
      });
      session.send(fallback).catch((e) => {
        console.error(
          `failed to send metrics fallback to R session ${session.id}: ${e}`,
        );
      });
      return;
    }

    // Store routing: requestID → sessionID
    this.metricsRouting.set(id, session.id);

    // Forward to browsers
    this.broadcastToClients(line);

    // Timeout: if no response in 2s, send zero-value fallback.
    // Look up the session ID from metricsRouting at fire time (not capture
    // time) so that updateSessionId() renames are reflected correctly.
    setTimeout(() => {
      const currentSessionId = this.metricsRouting.get(id);
      if (currentSessionId === undefined) return; // already responded or session gone
      this.metricsRouting.delete(id);
      const fallback = JSON.stringify({
        type: "metrics_response",
        id,
        width: 0,
        ascent: 0,
        descent: 0,
      });
      const target = this.sessions.get(currentSessionId);
      if (target) {
        target.send(fallback).catch((e) => {
          console.error(
            `failed to send metrics fallback to R session ${currentSessionId}: ${e}`,
          );
        });
      }
      if (this.verbose) {
        console.error(
          `metrics timeout for request ${id}, sent fallback to session ${currentSessionId}`,
        );
      }
    }, 2000);
  }

  /**
   * Route a metrics response from a browser to the originating R session.
   */
  handleMetricsResponse(line: string): void {
    let id: number;
    try {
      const msg = JSON.parse(line);
      id = msg.id;
    } catch {
      console.error("failed to parse metrics response");
      return;
    }

    if (typeof id !== "number" || !Number.isFinite(id)) {
      return;
    }

    const sessionId = this.metricsRouting.get(id);
    if (sessionId === undefined) {
      // Already timed out or duplicate
      return;
    }
    this.metricsRouting.delete(id);

    const session = this.sessions.get(sessionId);
    if (session) {
      session.send(line).catch((e) => {
        console.error(
          `failed to send metrics response to R session ${sessionId}: ${e}`,
        );
      });
    }
  }

  /** Register a browser client. */
  registerClient(client: BrowserClient): void {
    this.clients.add(client);
    console.error(
      `browser client connected (total: ${this.clients.size})`,
    );
  }

  /** Unregister a browser client. */
  unregisterClient(client: BrowserClient): void {
    this.clients.delete(client);
    console.error(
      `browser client disconnected (total: ${this.clients.size})`,
    );
  }

  /** Shut down the hub and close all connections. */
  close(): void {
    for (const client of this.clients) {
      try {
        client.close();
      } catch { /* ignore */ }
    }
    this.clients.clear();

    for (const session of this.sessions.values()) {
      try {
        session.close();
      } catch { /* ignore */ }
    }
    this.sessions.clear();
  }
}

/**
 * Extract the "type" field from a JSON line without full parse.
 * Falls back to empty string on malformed input.
 */
function extractType(line: string): string {
  const m = line.match(/"type"\s*:\s*"([^"]+)"/);
  return m ? m[1] : "";
}

/**
 * Inject "resize":true into a frame message so the browser knows this
 * frame is a response to a resize event, not a new plot.
 */
function injectResizeFlag(line: string): string {
  const idx = line.indexOf("{");
  if (idx < 0) return line;
  return line.slice(0, idx + 1) + '"resize":true,' + line.slice(idx + 1);
}

/**
 * Inject "plotIndex":N into a frame message so the browser knows which
 * historical plot this resize frame corresponds to.
 */
function injectPlotIndex(line: string, plotIndex: number): string {
  const idx = line.indexOf("{");
  if (idx < 0) return line;
  return line.slice(0, idx + 1) + `"plotIndex":${plotIndex},` + line.slice(idx + 1);
}

/**
 * Inject sessionId into the plot object of a frame message.
 * Finds `"plot":{` or `"plot": {` and inserts `"sessionId":"<id>",` after
 * the opening brace — matching the Go server's injection logic.
 */
export function injectSessionId(line: string, sessionId: string): string {
  // Find "plot":{ or "plot": {
  const plotRe = /"plot"\s*:\s*\{/;
  const match = plotRe.exec(line);
  if (!match) return line;

  const insertPos = match.index + match[0].length;
  const escaped = JSON.stringify(sessionId);
  return (
    line.slice(0, insertPos) +
    `"sessionId":${escaped},` +
    line.slice(insertPos)
  );
}
