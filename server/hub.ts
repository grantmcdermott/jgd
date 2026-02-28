import type { RSession } from "./r_session.ts";

/**
 * Maximum number of pending resize entries per session.  Under normal
 * operation the queue rarely exceeds 2-3 entries because each R frame
 * shifts one off.  This cap prevents unbounded growth if a browser
 * floods resize messages without R consuming them.
 */
const MAX_PENDING_RESIZES = 32;

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
   * Broadcast a resize message to R sessions, marking each so the
   * next frame can be tagged as a resize response.
   *
   * Each resize pushes an entry onto the session's pendingResizes queue.
   * When R responds with a frame, handleRMessage shifts one entry off,
   * ensuring each frame gets the correct metadata even when multiple
   * resize messages are in flight.
   *
   * Duplicate normal resizes with identical dimensions are silently dropped.
   * plotIndex resizes bypass dedup and are routed only to the session that
   * owns the target plot (identified by sessionId in the message).
   */
  broadcastResizeToR(data: string): void {
    let dims: {
      width: number;
      height: number;
      plotIndex?: number;
      sessionId?: string;
    } | null = null;
    try {
      const parsed = JSON.parse(data);
      if (typeof parsed.width === "number" && typeof parsed.height === "number" &&
          (parsed.width > 0 || parsed.height > 0)) {
        dims = {
          width: parsed.width,
          height: parsed.height,
          plotIndex: typeof parsed.plotIndex === "number" ? parsed.plotIndex : undefined,
          sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
        };
      }
    } catch { /* malformed — skip dedup, always arm */ }

    const hasPlotIndex = dims !== null && dims.plotIndex !== undefined;

    // plotIndex resizes require sessionId for routing.
    // Route to the target session only; drop if the session is dead.
    if (hasPlotIndex) {
      if (!dims!.sessionId) return; // no session to route to
      const session = this.sessions.get(dims!.sessionId);
      if (!session) return; // target session is dead
      if (session.pendingResizes.length >= MAX_PENDING_RESIZES) return;
      session.pendingResizes.push({ plotIndex: dims!.plotIndex });
      session.lastResizeW = dims!.width;
      session.lastResizeH = dims!.height;
      // Strip sessionId before forwarding to R (R doesn't need it)
      const forR = JSON.stringify({
        type: "resize",
        width: dims!.width,
        height: dims!.height,
        plotIndex: dims!.plotIndex,
      });
      session.send(forR).catch((e) => {
        console.error(
          `failed to send to R session ${session.id}: ${e}`,
        );
      });
      return;
    }

    // Normal resize — broadcast to all sessions with dedup.
    for (const session of this.sessions.values()) {
      if (dims) {
        // When dimensions haven't changed, skip entirely — don't forward
        // to R and don't arm the flag.  This prevents duplicate resizes
        // (ws.onopen + ResizeObserver with same dims) from generating
        // untagged frames that corrupt plot history.
        if (dims.width === session.lastResizeW && dims.height === session.lastResizeH) {
          continue;
        }
        // Collapse: remove any previous normal resize entries from the queue.
        // Multiple normal resizes in flight are redundant (only the latest
        // matters), and keeping stale entries would mis-tag subsequent frames.
        // plotIndex entries are preserved to maintain correct ordering.
        session.pendingResizes = session.pendingResizes.filter(
          (e) => e.plotIndex !== undefined,
        );
        if (session.pendingResizes.length < MAX_PENDING_RESIZES) {
          session.pendingResizes.push({ plotIndex: undefined });
        }
        session.lastResizeW = dims.width;
        session.lastResizeH = dims.height;
      } else {
        session.pendingResizes = session.pendingResizes.filter(
          (e) => e.plotIndex !== undefined,
        );
        if (session.pendingResizes.length < MAX_PENDING_RESIZES) {
          session.pendingResizes.push({ plotIndex: undefined });
        }
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
        // Tag resize-triggered frames so the browser can update in place.
        // Shift from the queue so each frame gets the correct entry even
        // when multiple resizes are in flight (fixes state race condition).
        if (session.pendingResizes.length > 0) {
          const entry = session.pendingResizes.shift()!;
          data = injectResizeFlag(data);
          if (entry.plotIndex !== undefined) {
            data = injectPlotIndex(data, entry.plotIndex);
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
