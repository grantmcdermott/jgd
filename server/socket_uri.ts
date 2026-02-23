/**
 * Socket URI construction and parsing for jgd.
 *
 * Supported formats:
 * - tcp://host:port
 * - unix:///absolute/path
 * - npipe:///pipename
 *
 * Use the `socketUri.*` factory functions to construct URIs, and
 * `parseSocketUri()` to parse them back into typed addresses.
 */

export type SocketAddr =
  | { transport: "tcp"; hostname: string; port: number }
  | { transport: "unix"; path: string }
  | { transport: "npipe"; name: string; pipePath: string };

/** Construct a socket URI from typed components. */
export const socketUri = {
  tcp: (hostname: string, port: number): string =>
    `tcp://${hostname}:${port}`,
  unix: (path: string): string => {
    if (!path.startsWith("/")) throw new Error(`Unix socket path must be absolute: ${path}`);
    return `unix://${encodeURI(path).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
  },
  npipe: (name: string): string =>
    `npipe:///${name}`,
};

/** Parse a socket URI string into its transport type and connection details. */
export function parseSocketUri(uri: string): SocketAddr {
  if (uri.startsWith("tcp://")) {
    const url = new URL(uri);
    const port = parseInt(url.port, 10);
    if (Number.isNaN(port)) throw new Error(`Invalid TCP port in URI: ${uri}`);
    return { transport: "tcp", hostname: url.hostname, port };
  }
  if (uri.startsWith("npipe:///")) {
    const name = uri.slice("npipe:///".length);
    if (!name) throw new Error(`Empty pipe name in URI: ${uri}`);
    return { transport: "npipe", name, pipePath: `\\\\.\\pipe\\${name}` };
  }
  if (uri.startsWith("unix:///")) {
    return { transport: "unix", path: decodeURIComponent(new URL(uri).pathname) };
  }
  throw new Error(
    `Unsupported socket URI: ${uri} (expected tcp://host:port, unix:///path, or npipe:///name)`,
  );
}
