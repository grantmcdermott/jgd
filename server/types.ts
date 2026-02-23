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

/** Union of all browser-to-server messages. */
export type BrowserMessage =
  | ResizeMessage
  | MetricsResponseMessage;
