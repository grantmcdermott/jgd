import type { Hub, BrowserClient } from "./hub.ts";

/**
 * Upgrade an HTTP request to a WebSocket connection and register
 * the resulting client with the hub.
 */
export function handleWebSocket(req: Request, hub: Hub): Response {
  const { socket, response } = Deno.upgradeWebSocket(req, {
    idleTimeout: 60,
  });

  const client = new WebSocketClient(socket, hub);
  hub.registerClient(client);

  socket.onmessage = (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    client.handleMessage(event.data);
  };

  socket.onclose = () => {
    hub.unregisterClient(client);
  };

  socket.onerror = (e) => {
    console.error(`WebSocket error: ${e}`);
    hub.unregisterClient(client);
  };

  return response;
}

/**
 * A browser client connected via WebSocket.
 * Implements the BrowserClient interface expected by Hub.
 */
class WebSocketClient implements BrowserClient {
  private socket: WebSocket;
  private hub: Hub;

  constructor(socket: WebSocket, hub: Hub) {
    this.socket = socket;
    this.hub = hub;
  }

  send(data: string): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(data);
    }
  }

  close(): void {
    try {
      this.socket.close();
    } catch { /* ignore if already closed */ }
  }

  /** Route an incoming message from the browser by type. */
  handleMessage(data: string): void {
    const type = extractType(data);

    switch (type) {
      case "resize":
        this.hub.broadcastResizeToR(data);
        break;

      case "metrics_response":
        this.hub.handleMetricsResponse(data);
        break;

      default:
        if (this.hub.verbose) {
          console.error(`unknown browser message type: ${type}`);
        }
        break;
    }
  }
}

/** Extract the "type" field from a JSON string without full parse. */
function extractType(data: string): string {
  const m = data.match(/"type"\s*:\s*"([^"]+)"/);
  return m ? m[1] : "";
}
