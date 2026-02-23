/**
 * Parse a jgd socket URI into its transport type and connection details.
 *
 * Supported formats:
 * - tcp://host:port
 * - unix:///absolute/path
 * - npipe:///pipename
 * - /raw/unix/path  (backwards-compatible, treated as unix)
 */

export type SocketAddr =
  | { transport: "tcp"; hostname: string; port: number }
  | { transport: "unix"; path: string }
  | { transport: "npipe"; name: string; pipePath: string };

export function parseSocketUri(uri: string): SocketAddr {
  if (uri.startsWith("tcp://")) {
    const url = new URL(uri);
    const port = parseInt(url.port, 10);
    if (Number.isNaN(port)) throw new Error(`Invalid TCP port in URI: ${uri}`);
    return { transport: "tcp", hostname: url.hostname, port };
  }
  if (uri.startsWith("npipe:///")) {
    const name = uri.slice("npipe:///".length);
    return { transport: "npipe", name, pipePath: `\\\\.\\pipe\\${name}` };
  }
  if (uri.startsWith("unix://")) {
    return { transport: "unix", path: new URL(uri).pathname };
  }
  // Raw filesystem path (backwards-compatible)
  return { transport: "unix", path: uri };
}
