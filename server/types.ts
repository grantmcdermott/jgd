// Message types for the jgd protocol.
// R → Server → Browser messages and Browser → Server → R messages.

/** Frame message containing plot operations. */
export interface FrameMessage {
  type: "frame";
  plot: {
    sessionId?: string;
    ops: unknown[];
    device: Record<string, unknown>;
  };
  incremental?: boolean;
}

/** Request from R for font metrics (strWidth or metricInfo). */
export interface MetricsRequestMessage {
  type: "metrics_request";
  id: number;
  kind: "strWidth" | "metricInfo";
  [key: string]: unknown;
}

/** Response from browser with font metrics. */
export interface MetricsResponseMessage {
  type: "metrics_response";
  id: number;
  width: number;
  ascent: number;
  descent: number;
}

/** Resize message from browser. */
export interface ResizeMessage {
  type: "resize";
  width: number;
  height: number;
  plotIndex?: number;
  /** Session that owns the target plot (for plotIndex routing). */
  sessionId?: string;
}

/** Device close message from R. */
export interface CloseMessage {
  type: "close";
}

/** Welcome message sent to R immediately on connect. */
export interface ServerInfoMessage {
  type: "server_info";
  serverName: string;
  protocolVersion: number;
  transport: "tcp" | "unix" | "npipe";
  serverInfo?: Record<string, string>;
}

/** Union of all R-to-server messages. */
export type RMessage =
  | FrameMessage
  | MetricsRequestMessage
  | CloseMessage;

/** Ping message from browser (ordering probe / health-check). */
export interface PingMessage {
  type: "ping";
}

/** Pong response from server. */
export interface PongMessage {
  type: "pong";
}

/** Union of all browser-to-server messages. */
export type BrowserMessage =
  | ResizeMessage
  | MetricsResponseMessage
  | PingMessage;

/** Union of all server-to-browser messages. */
export type ServerToBrowserMessage =
  | FrameMessage
  | MetricsRequestMessage
  | CloseMessage
  | PongMessage;

/**
 * Extract the top-level "type" field from a JSON string without full parse.
 * The regex scans from the opening brace up to (but not into) any nested
 * object, so a "type" inside a nested `{}` can't shadow the top-level one.
 * Falls back to empty string on malformed input.
 *
 * This is a fast-path optimisation for machine-serialized NDJSON from
 * controlled code (JSON.stringify).  It does not handle adversarial
 * payloads where string values contain embedded `"type":"..."` patterns.
 */
export function extractType(line: string): string {
  const m = line.match(/^\s*\{[^{}]*"type"\s*:\s*"([^"]+)"/);
  return m ? m[1] : "";
}
