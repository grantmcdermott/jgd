import { join, dirname } from "jsr:@std/path@1";
import { homedir } from "node:os";

const DISCOVERY_FILENAME = "discovery.json";
const DISCOVERY_DIR = "jgd";

interface DiscoveryInfo {
  serverName: string;
  socketPath: string;
  pid: number;
  serverInfo?: Record<string, string>;
}

/** Atomic file write via temp file + rename. */
async function atomicWrite(path: string, data: Uint8Array): Promise<void> {
  const dir = dirname(path);
  const tmpPath = join(dir, `.jgd-discovery-${crypto.randomUUID()}.tmp`);
  try {
    await Deno.writeFile(tmpPath, data);
    await Deno.rename(tmpPath, path);
  } catch (e) {
    try {
      await Deno.remove(tmpPath);
    } catch { /* ignore cleanup error */ }
    throw e;
  }
}

/**
 * Return the cache directory following platform conventions:
 * - Linux:   $XDG_CACHE_HOME or ~/.cache
 * - macOS:   ~/Library/Caches
 * - Windows: %LOCALAPPDATA%
 */
// TODO: Make cacheDir injectable for test hermeticity (currently tests
// override XDG_CACHE_HOME on Linux and LOCALAPPDATA on Windows;
// macOS always uses ~/Library/Caches and ignores XDG_CACHE_HOME).
function cacheDir(): string {
  if (Deno.build.os === "windows") {
    const localAppData = Deno.env.get("LOCALAPPDATA");
    if (localAppData) return localAppData;
    const home = homedir();
    if (home) return join(home, "AppData", "Local");
    throw new Error("Cannot determine cache directory on Windows");
  }
  if (Deno.build.os === "darwin") {
    const home = homedir();
    if (home) return join(home, "Library", "Caches");
    throw new Error("Cannot determine cache directory on macOS");
  }
  // Linux / other POSIX
  const xdg = Deno.env.get("XDG_CACHE_HOME");
  if (xdg) return xdg;
  const home = homedir();
  if (home) return join(home, ".cache");
  throw new Error("Cannot determine cache directory");
}

/** Return the single discovery file path: <cache_dir>/jgd/discovery.json */
function discoveryLocation(): string {
  return join(cacheDir(), DISCOVERY_DIR, DISCOVERY_FILENAME);
}

/**
 * Write discovery file so R can find the server.
 * Returns the path that was written.
 */
export async function writeDiscovery(
  socketPath: string,
  serverName: string,
  serverInfo?: Record<string, string>,
): Promise<string | null> {
  if (typeof serverName !== "string" || serverName.trim().length === 0) {
    throw new Error("serverName must be a non-empty string");
  }
  if (serverInfo !== undefined) {
    if (typeof serverInfo !== "object" || serverInfo === null || Array.isArray(serverInfo)) {
      throw new Error("serverInfo must be a plain object");
    }
    for (const [k, v] of Object.entries(serverInfo)) {
      if (typeof v !== "string") {
        throw new Error(`serverInfo value for "${k}" must be a string, got ${typeof v}`);
      }
    }
  }
  const disc: DiscoveryInfo = {
    serverName,
    socketPath,
    pid: Deno.pid,
    ...(serverInfo !== undefined && { serverInfo }),
  };
  const content = new TextEncoder().encode(JSON.stringify(disc));
  try {
    const loc = discoveryLocation();
    await Deno.mkdir(dirname(loc), { recursive: true });
    await atomicWrite(loc, content);
    console.error(`wrote discovery file: ${loc}`);
    return loc;
  } catch (e) {
    console.error(`warning: failed to write discovery file: ${e}`);
    return null;
  }
}

/** Remove the discovery file written during startup, but only if it
 *  still belongs to this process (another instance may have overwritten). */
export async function removeDiscovery(path: string | null): Promise<void> {
  if (!path) return;
  let info: DiscoveryInfo;
  try {
    const raw = await Deno.readTextFile(path);
    info = JSON.parse(raw);
  } catch {
    // File missing, unreadable, or corrupt JSON — skip
    return;
  }
  if (typeof info !== "object" || info === null || info.pid !== Deno.pid) return;
  try {
    await Deno.remove(path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      console.error(`warning: failed to remove discovery file ${path}: ${e}`);
    }
  }
}
