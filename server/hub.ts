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
  /**
   * Maps server-assigned metrics ID → originating session ID and
   * original request ID.  The server assigns a globally unique ID
   * when forwarding to the browser, so concurrent R processes with
   * overlapping numeric IDs don't collide.
   */
  metricsRouting = new Map<number, { sessionId: string; originalId: number }>();
  /** Monotonically increasing counter for server-assigned metrics IDs. */
  private metricsIdCounter = 0;
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
    for (const [key, entry] of this.metricsRouting) {
      if (entry.sessionId === id) {
        this.metricsRouting.delete(key);
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
    for (const [key, entry] of this.metricsRouting) {
      if (entry.sessionId === oldId) {
        entry.sessionId = finalId;
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
        const { msg, isResizeReplay, plotIndex } = parseFrame(line);

        // If parsing failed, forward the raw line unchanged.
        if (!msg) {
          this.broadcastToClients(line);
          break;
        }

        // R self-reports resize metadata in each frame:
        //   resizeReplay:true  — frame from poll_resize_impl (display list replay)
        //   plotIndex:N        — which historical plot was replayed
        //
        // When resizeReplay is present, set resize:true so the browser
        // knows to update in place rather than add a new plot.
        if (isResizeReplay) {
          msg.resize = true;
        }

        if (this.verbose) {
          let classification: string;
          if (isResizeReplay) {
            classification = plotIndex !== undefined
              ? `resize (plotIndex=${plotIndex})`
              : "resize (current plot)";
          } else {
            classification = msg.newPage ? "newPage" : msg.incremental ? "incremental" : "complete";
          }
          console.error(
            `[hub] frame: ${classification}`,
          );
        }

        // Ensure the frame carries the server-assigned sessionId.
        // R always places sessionId inside the plot object (see
        // display_list.c), so we only check msg.plot.sessionId here.
        if (session.id) {
          if (msg.plot) {
            if (msg.plot.sessionId !== undefined) {
              // Only replace when the server remapped the session ID
              // (retired ID dedup).  Otherwise preserve R's explicit sessionId.
              if (session.remappedSessionId) {
                msg.plot.sessionId = session.id;
              }
            } else {
              msg.plot.sessionId = session.id;
            }
          }
        }

        const data = JSON.stringify(msg);
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
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        console.error("metrics request is not an object");
        return;
      }
      msg = parsed;
    } catch {
      console.error("failed to parse metrics request");
      return;
    }
    const id = msg.id;

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

    // Assign a server-global unique ID to avoid collisions when
    // multiple R processes send requests with the same numeric id.
    const serverId = ++this.metricsIdCounter;
    this.metricsRouting.set(serverId, {
      sessionId: session.id,
      originalId: id,
    });

    // Forward to browsers with the remapped ID
    msg.id = serverId;
    this.broadcastToClients(JSON.stringify(msg));

    // Timeout: if no response in 2s, send zero-value fallback.
    // Look up the entry from metricsRouting at fire time (not capture
    // time) so that updateSessionId() renames are reflected correctly.
    setTimeout(() => {
      const entry = this.metricsRouting.get(serverId);
      if (entry === undefined) return; // already responded or session gone
      this.metricsRouting.delete(serverId);
      const fallback = JSON.stringify({
        type: "metrics_response",
        id: entry.originalId,
        width: 0,
        ascent: 0,
        descent: 0,
      });
      const target = this.sessions.get(entry.sessionId);
      if (target) {
        target.trySend(fallback);
      }
      if (this.verbose) {
        console.error(
          `metrics timeout for request ${serverId} (original ${entry.originalId}), sent fallback to session ${entry.sessionId}`,
        );
      }
    }, 2000);
  }

  /**
   * Route a metrics response from a browser to the originating R session.
   */
  handleMetricsResponse(line: string): void {
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        console.error("metrics response is not an object");
        return;
      }
      msg = parsed;
    } catch {
      console.error("failed to parse metrics response");
      return;
    }
    const id = msg.id;

    if (typeof id !== "number" || !Number.isFinite(id)) {
      return;
    }

    const entry = this.metricsRouting.get(id);
    if (entry === undefined) {
      // Already timed out or duplicate
      return;
    }
    this.metricsRouting.delete(id);

    // Restore the original request ID before sending to R
    msg.id = entry.originalId;
    const session = this.sessions.get(entry.sessionId);
    if (session) {
      session.trySend(JSON.stringify(msg));
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

/** Result of parsing a frame JSON line. */
interface ParsedFrame {
  /** The parsed message object, or null if parsing failed. */
  // deno-lint-ignore no-explicit-any
  msg: Record<string, any> | null;
  isResizeReplay: boolean;
  plotIndex: number | undefined;
}

/**
 * Parse a frame JSON line and extract metadata in a single JSON.parse call.
 * The parsed object is returned so callers can mutate it and re-serialize,
 * avoiding fragile string-based JSON injection.
 */
function parseFrame(line: string): ParsedFrame {
  try {
    const msg = JSON.parse(line);
    const isResizeReplay = msg?.resizeReplay === true;
    const plotIndex = typeof msg?.plotIndex === "number" ? msg.plotIndex : undefined;
    return { msg, isResizeReplay, plotIndex };
  } catch {
    return { msg: null, isResizeReplay: false, plotIndex: undefined };
  }
}
