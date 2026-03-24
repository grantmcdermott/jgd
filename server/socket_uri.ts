/**
 * Socket URI construction and parsing for jgd.
 *
 * Supported formats:
 * - tcp://host:port
 * - unix:///absolute/path
 * - npipe:////./pipe/name   (Docker-standard 4-slash form)
 *
 * Use the `socketUri.*` factory functions to construct URIs, and
 * `parseSocketUri()` to parse them back into typed addresses.
 */

/** Prefix for the Docker-standard named pipe URI form. */
const NPIPE_PREFIX = "npipe:////./pipe/";

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
  npipe: (name: string): string => {
    if (!name) throw new Error("Named pipe name must not be empty");
    return `${NPIPE_PREFIX}${name}`;
  },
};

/** Parse a socket URI string into its transport type and connection details. */
export function parseSocketUri(uri: string): SocketAddr {
  if (uri.startsWith("tcp://")) {
    const url = new URL(uri);
    if (!url.hostname) throw new Error(`Invalid TCP socket URI (empty hostname): ${uri}`);
    const port = parseInt(url.port, 10);
    if (Number.isNaN(port)) throw new Error(`Invalid TCP port in URI: ${uri}`);
    if (url.search || url.hash) {
      throw new Error(`Invalid TCP socket URI (unexpected query or fragment): ${uri}`);
    }
    return { transport: "tcp", hostname: url.hostname, port };
  }
  if (uri.startsWith(NPIPE_PREFIX)) {
    const name = uri.slice(NPIPE_PREFIX.length);
    if (!name) throw new Error(`Empty pipe name in URI: ${uri}`);
    return { transport: "npipe", name, pipePath: `\\\\.\\pipe\\${name}` };
  }
  if (uri.startsWith("unix:///")) {
    const url = new URL(uri);
    if (url.search || url.hash) {
      throw new Error(
        `Invalid Unix socket URI (unencoded query or fragment): ${uri}. ` +
          `Use percent-encoding for '?' (%3F) and '#' (%23) in the socket path.`,
      );
    }
    return { transport: "unix", path: decodeURIComponent(url.pathname) };
  }
  throw new Error(
    `Unsupported socket URI: ${uri} (expected tcp://host:port, unix:///path, or npipe:////./pipe/name)`,
  );
}
