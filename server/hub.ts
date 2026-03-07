import type { RSession } from "./r_session.ts";
import { extractType } from "./types.ts";

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
  /**
   * SessionIds that have been used by now-dead connections.  When a new
   * connection registers the same sessionId (e.g. R uses PID-based IDs
   * and the same process opens a new device), the hub disambiguates by
   * appending a suffix.  This prevents plotIndex resizes for old plots
   * from reaching the new connection, which has different snapshots.
   */
  private retiredSessionIds = new Set<string>();
  private sessionReuseCounter = 0;
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
    this.retiredSessionIds.add(id);
    // Prevent unbounded growth on long-running servers.  Session IDs
    // include a per-process counter, so reuse after a clear() is
    // effectively impossible.
    if (this.retiredSessionIds.size > 1000) {
      this.retiredSessionIds.clear();
    }
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
    // If this sessionId was previously used by a now-dead connection
    // (e.g. same R process did dev.off() + jgd()), disambiguate so
    // the browser keeps plot histories separate and plotIndex resizes
    // for old plots don't reach this new connection.
    let finalId = newId;
    if (this.retiredSessionIds.has(newId)) {
      this.sessionReuseCounter++;
      finalId = `${newId}:${this.sessionReuseCounter}`;
      session.remappedSessionId = true;
      if (this.verbose) {
        console.error(
          `sessionId ${newId} was retired, remapped to ${finalId}`,
        );
      }
    }
    session.id = finalId;
    this.sessions.set(finalId, session);
    // Update any pending metrics routing entries to use the new session ID
    for (const [reqId, sessId] of this.metricsRouting) {
      if (sessId === oldId) {
        this.metricsRouting.set(reqId, finalId);
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
      session.trySend(data);
    }
  }

  /**
   * Broadcast a resize message to R sessions.
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
      // Both dimensions must be positive for a valid resize (AND, not OR).
      // Zero-width or zero-height viewports are meaningless.
      if (typeof parsed.width === "number" && typeof parsed.height === "number" &&
          Number.isFinite(parsed.width) && Number.isFinite(parsed.height) &&
          parsed.width > 0 && parsed.height > 0) {
        const pi = parsed.plotIndex;
        dims = {
          width: parsed.width,
          height: parsed.height,
          plotIndex: (typeof pi === "number" && Number.isFinite(pi) &&
                      Number.isInteger(pi) && pi >= 0) ? pi : undefined,
          sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
        };
      }
    } catch { /* malformed — skip dedup, always forward */ }

    const hasPlotIndex = dims !== null && dims.plotIndex !== undefined;

    // plotIndex resizes require sessionId for routing.
    // Route to the target session only; drop if the session is dead.
    if (hasPlotIndex) {
      if (!dims!.sessionId) return; // no session to route to
      const session = this.sessions.get(dims!.sessionId);
      if (!session) return; // target session is dead
      // Update lastResizeW/H: R's device.c poll_resize_impl applies the
      // new dimensions BEFORE the plotIndex/normal branch, so R's actual
      // device size changes after a plotIndex resize.  If we don't update
      // dedup state, a subsequent normal resize back to the pre-plotIndex
      // dimensions is silently suppressed (matches stale lastResize).
      session.lastResizeW = dims!.width;
      session.lastResizeH = dims!.height;
      // Mark that a plotIndex resize set the dedup state.  The next normal
      // resize at these same dimensions must NOT be deduped — it targets
      // the current display list, not the historical snapshot.
      session.lastResizeHadPlotIndex = true;
      // Strip sessionId before forwarding to R (R doesn't need it)
      const forR = JSON.stringify({
        type: "resize",
        width: dims!.width,
        height: dims!.height,
        plotIndex: dims!.plotIndex,
      });
      session.trySend(forR);
      return;
    }

    if (this.verbose) {
      console.error(
        `[hub] resize from browser: ${dims?.width}x${dims?.height}`,
      );
    }
    // Normal resize — broadcast to all sessions with dedup.
    for (const session of this.sessions.values()) {
      if (dims) {
        // When dimensions haven't changed, skip entirely — don't forward
        // to R.  This prevents duplicate resizes (ws.onopen +
        // ResizeObserver with same dims) from generating extra frames.
        //
        // Exception: if the previous resize was a plotIndex resize, the
        // dedup state reflects a historical snapshot replay.  A normal
        // resize at the same dimensions targets the current display list,
        // which is semantically different, so it must reach R.
        if (dims.width === session.lastResizeW && dims.height === session.lastResizeH) {
          if (!session.lastResizeHadPlotIndex) {
            continue;
          }
          // Fall through — allow this normal resize despite matching dims.
        }
        session.lastResizeHadPlotIndex = false;
      }

      if (dims) {
        session.lastResizeW = dims.width;
        session.lastResizeH = dims.height;
      }
      session.trySend(data);
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
        const { isResizeReplay, plotIndex } = extractFrameMeta(line);

        // R self-reports resize metadata in each frame:
        //   resizeReplay:true  — frame from poll_resize_impl (display list replay)
        //   plotIndex:N        — which historical plot was replayed
        //
        // When resizeReplay is present, inject resize:true so the browser
        // knows to update in place rather than add a new plot.
        if (isResizeReplay) {
          data = injectResizeFlag(data);
        }

        if (this.verbose) {
          const isIncremental = /"incremental"\s*:\s*true/.test(line);
          const isNewPage = /"newPage"\s*:\s*true/.test(line);
          let classification: string;
          if (isResizeReplay) {
            classification = plotIndex !== undefined
              ? `resize (plotIndex=${plotIndex})`
              : "resize (current plot)";
          } else {
            classification = isNewPage ? "newPage" : isIncremental ? "incremental" : "complete";
          }
          console.error(
            `[hub] frame: ${classification}`,
          );
        }
        // Ensure the frame carries the server-assigned sessionId.
        if (session.id) {
          if (/"sessionId"\s*:/.test(data)) {
            // Only replace when the server remapped the session ID
            // (retired ID dedup).  Otherwise preserve R's explicit sessionId.
            if (session.remappedSessionId) {
              data = data.replace(
                /"sessionId"\s*:\s*"[^"]*"/,
                () => `"sessionId":${JSON.stringify(session.id)}`,
              );
            }
          } else {
            data = injectSessionId(data, session.id);
          }
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
      session.trySend(fallback);
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
        target.trySend(fallback);
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
      session.trySend(line);
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

/** Metadata extracted from a single JSON.parse of a frame line. */
interface FrameMeta {
  isResizeReplay: boolean;
  plotIndex: number | undefined;
}

/**
 * Extract frame metadata from a frame JSON line in a single JSON.parse call.
 * R now self-reports resizeReplay and plotIndex directly in the frame.
 */
function extractFrameMeta(line: string): FrameMeta {
  try {
    const msg = JSON.parse(line);
    const isResizeReplay = msg?.resizeReplay === true;
    const plotIndex = typeof msg?.plotIndex === "number" ? msg.plotIndex : undefined;
    return { isResizeReplay, plotIndex };
  } catch {
    return { isResizeReplay: false, plotIndex: undefined };
  }
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
