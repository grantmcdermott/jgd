/** Message types exchanged between R, server, and browser. */

export interface FrameMessage {
  type: "frame";
  plot: {
    sessionId?: string;
    ops: unknown[];
    device: Record<string, unknown>;
  };
  incremental?: boolean;
  resize?: boolean;
  plotIndex?: number;
}

export interface ResizeMessage {
  type: "resize";
  width: number;
  height: number;
  plotIndex?: number;
}

export interface MetricsRequestMessage {
  type: "metrics_request";
  id: number;
  kind: "strWidth" | "metricInfo";
  str?: string;
  c?: number;
  gc?: {
    font?: {
      family?: string;
      face?: number;
      size?: number;
    };
  };
}

export interface MetricsResponseMessage {
  type: "metrics_response";
  id: number;
  width: number;
  ascent: number;
  descent: number;
}

export interface CloseMessage {
  type: "close";
}

export interface ServerInfoMessage {
  type: "server_info";
  serverName: string;
  protocolVersion: number;
  serverInfo?: Record<string, string>;
}

export interface DiscoveryFile {
  socketPath: string;
  httpPort: number;
  pid: number;
}

export type ServerMessage =
  | FrameMessage
  | ResizeMessage
  | MetricsRequestMessage
  | MetricsResponseMessage
  | CloseMessage
  | ServerInfoMessage;
