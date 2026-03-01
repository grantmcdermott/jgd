import type { RSession } from "./r_session.ts";
import { extractType } from "./types.ts";

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
    } catch { /* malformed — skip dedup, always arm */ }

    const hasPlotIndex = dims !== null && dims.plotIndex !== undefined;

    // plotIndex resizes require sessionId for routing.
    // Route to the target session only; drop if the session is dead.
    if (hasPlotIndex) {
      if (!dims!.sessionId) return; // no session to route to
      const session = this.sessions.get(dims!.sessionId);
      if (!session) return; // target session is dead
      if (session.pendingResizes.length >= MAX_PENDING_RESIZES) return;
      session.pendingResizes.push({
        plotIndex: dims!.plotIndex,
        width: dims!.width,
        height: dims!.height,
      });
      // Do NOT update lastResizeW/H here — plotIndex resizes target a
      // specific historical plot, not the device viewport.  Updating the
      // dedup state would cause a subsequent normal resize to the same
      // dimensions to be silently suppressed.
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
        `[hub] resize from browser: ${dims?.width}x${dims?.height}` +
        (hasPlotIndex ? ` plotIndex=${dims?.plotIndex}` : ""),
      );
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
      }

      if (!session.hasReceivedFrame) {
        // Before R has sent any frame, limit what we forward to avoid the
        // stashed-resize bug: recv_metrics_response can pick up resize
        // messages during text-metric waits and stash them in pending_w/h.
        // The resulting replay frame has no pendingResizes entry, so it
        // arrives untagged → browser calls addPlot → duplicate plot.
        if (!session.initialResizeSent) {
          // Allow the very first resize (ws.onopen) through so R's device
          // gets the correct initial dimensions.  Push a pendingResizes
          // entry so that if R processes the resize AFTER the first plot
          // (user typed fast), the replay frame gets tagged.  If R
          // processes it before any plot (DL empty, no replay frame), the
          // entry is silently drained when the first newPage frame arrives.
          session.initialResizeSent = true;
          if (dims) {
            session.pendingResizes.push({
              plotIndex: undefined,
              width: dims.width,
              height: dims.height,
            });
          }
        } else {
          // Defer subsequent resizes.  The latest deferred resize will be
          // forwarded after the first frame arrives (see handleRMessage).
          session.deferredResize = {
            data,
            width: dims?.width ?? 0,
            height: dims?.height ?? 0,
          };
          if (dims) {
            session.lastResizeW = dims.width;
            session.lastResizeH = dims.height;
          }
          continue;
        }
      } else {
        // R has sent at least one frame — normal resize path.
        // Each forwarded resize gets its own pendingResizes entry because R
        // will send a replay frame for each.  Do NOT collapse (remove) earlier
        // entries: R has already received those resizes and the corresponding
        // replay frames need matching entries to be tagged resize:true.
        // MAX_PENDING_RESIZES caps unbounded growth from misbehaving clients.
        if (session.pendingResizes.length >= MAX_PENDING_RESIZES) continue;
        session.pendingResizes.push({
          plotIndex: undefined,
          width: dims?.width,
          height: dims?.height,
        });
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
        session.hasReceivedFrame = true;
        let data = line;
        const isNewPage = /"newPage"\s*:\s*true/.test(line);
        // Tag resize-triggered frames so the browser can update in place.
        // Use dimension matching to handle R-side coalescing: when R
        // receives multiple resizes quickly, it may only replay the last
        // one.  By matching the frame's device dimensions against queued
        // entries, we consume the correct entry (and any earlier entries
        // that R coalesced into it).
        //
        // When the frame has newPage:true, this is a genuinely new plot —
        // not a resize replay.  If a pending entry happens to match the
        // new plot's dimensions (Race A: cb_newPage consumed the resize),
        // silently drain it so it doesn't contaminate later frames, but
        // do NOT tag the frame as a resize.
        const hadPending = session.pendingResizes.length > 0;
        let consumedEntry: { plotIndex?: number } | undefined;
        let drainedPending = false;
        if (hadPending) {
          const frameDims = extractDeviceDims(line);
          if (isNewPage) {
            // New plot: drain matching entry if present (Race A cleanup),
            // but never tag.  No FIFO fallback — a non-matching entry
            // belongs to a resize that R hasn't replayed yet.
            drainMatchingEntry(session.pendingResizes, frameDims);
            drainedPending = true;
          } else {
            consumedEntry = consumePendingResize(session.pendingResizes, frameDims);
            if (consumedEntry) {
              data = injectResizeFlag(data);
              if (consumedEntry.plotIndex !== undefined) {
                data = injectPlotIndex(data, consumedEntry.plotIndex);
              }
            }
          }
        }
        if (this.verbose) {
          const isIncremental = /"incremental"\s*:\s*true/.test(line);
          let classification: string;
          if (drainedPending) {
            classification = "newPage (drained pending)";
          } else if (consumedEntry) {
            classification = consumedEntry.plotIndex !== undefined
              ? `resize (plotIndex=${consumedEntry.plotIndex})`
              : "resize (consumed pending)";
          } else if (hadPending && !isNewPage) {
            classification = "UNTAGGED (no pending resize!)";
          } else {
            classification = isNewPage ? "newPage" : isIncremental ? "incremental" : "complete";
          }
          console.error(
            `[hub] frame: ${classification}, pendingResizes=${session.pendingResizes.length}` +
            `, deferred=${!!session.deferredResize}, newPage=${isNewPage}` +
            `, incremental=${isIncremental}`,
          );
        }
        // Ensure the frame carries the server-assigned sessionId.
        if (session.id) {
          if (data.includes('"sessionId"')) {
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
        // Forward any deferred resize now that R has an active plot.
        // Push a pendingResizes entry so the replay frame gets tagged.
        // Note: if send() fails (broken pipe), the entry becomes orphaned,
        // but a failed send means the session is dying and will be cleaned
        // up shortly — no practical impact.
        if (session.deferredResize) {
          const deferred = session.deferredResize;
          session.deferredResize = null;
          // Skip both enqueue and send when the cap is hit, matching
          // the normal and plotIndex resize paths.  Sending without an
          // entry would cause the replay frame to arrive UNTAGGED.
          if (session.pendingResizes.length < MAX_PENDING_RESIZES) {
            session.pendingResizes.push({
              plotIndex: undefined,
              width: deferred.width,
              height: deferred.height,
            });
            session.trySend(deferred.data);
            if (this.verbose) {
              console.error(
                `[hub] sent deferred resize to R (${deferred.width}x${deferred.height})` +
                `, pendingResizes now=${session.pendingResizes.length}`,
              );
            }
          }
        }
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

/**
 * Extract device dimensions from a frame JSON line.
 * Returns null if dimensions cannot be extracted.
 */
function extractDeviceDims(line: string): { width: number; height: number } | null {
  try {
    const msg = JSON.parse(line);
    const dev = msg?.plot?.device;
    if (dev && typeof dev.width === "number" && typeof dev.height === "number") {
      return { width: dev.width, height: dev.height };
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Consume the appropriate pending resize entry for a frame.
 *
 * - plotIndex entries: strict FIFO (no coalescing).
 * - Normal entries: first-match FIFO when the head entry's dimensions match,
 *   otherwise deep-search for the last matching entry and drain up to it
 *   (handles R-side coalescing).  Falls back to FIFO when no match is found
 *   or dimensions are unavailable.
 */
export function consumePendingResize(
  queue: Array<{ plotIndex?: number; width?: number; height?: number }>,
  frameDims: { width: number; height: number } | null,
): { plotIndex?: number } | undefined {
  if (queue.length === 0) return undefined;

  // plotIndex entries: always consume strictly FIFO.
  if (queue[0].plotIndex !== undefined) {
    return queue.shift()!;
  }

  // Without frame dimensions, fall back to FIFO.
  if (!frameDims) return queue.shift()!;

  // If the first entry matches, consume it directly (R is processing
  // resizes in order, no coalescing).  Checking the first entry separately
  // prevents over-draining in A, B, A patterns where each resize produces
  // its own frame.
  if (queue[0].width === frameDims.width && queue[0].height === frameDims.height) {
    return queue.shift()!;
  }

  // First entry doesn't match — R may have coalesced past it.  Find the
  // last matching entry in the consecutive normal prefix and drain all
  // entries up to and including it.
  let matchIdx = -1;
  for (let i = 1; i < queue.length; i++) {
    if (queue[i].plotIndex !== undefined) break;
    if (queue[i].width === frameDims.width && queue[i].height === frameDims.height) {
      matchIdx = i;
    }
  }
  if (matchIdx >= 0) {
    const removed = queue.splice(0, matchIdx + 1);
    return removed[removed.length - 1];
  }

  // No dimension match — R may have rendered at adjusted dimensions
  // (e.g. device constraints).  Fall back to FIFO.
  return queue.shift()!;
}

/**
 * Drain a pending resize entry whose dimensions match the given frame.
 *
 * Used for newPage frames: when R consumes a resize in cb_newPage
 * (Race A), the new plot's dimensions coincidentally match the entry.
 * We remove the orphaned entry so it doesn't contaminate later frames,
 * but we do NOT tag the frame — it's a new plot, not a replay.
 *
 * Only removes the first matching entry.  No FIFO fallback: if dims
 * don't match, the entry belongs to a resize R hasn't replayed yet.
 */
function drainMatchingEntry(
  queue: Array<{ plotIndex?: number; width?: number; height?: number }>,
  frameDims: { width: number; height: number } | null,
): void {
  if (!frameDims || queue.length === 0) return;
  for (let i = 0; i < queue.length; i++) {
    if (queue[i].plotIndex !== undefined) continue; // skip plotIndex entries
    if (queue[i].width === frameDims.width && queue[i].height === frameDims.height) {
      queue.splice(i, 1);
      return;
    }
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
