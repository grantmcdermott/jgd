import { join, dirname } from "jsr:@std/path@1";

const DISCOVERY_FILENAME = "jgd-discovery.json";

interface DiscoveryInfo {
  socketPath: string;
  httpPort: number;
  pid: number;
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
 * Determine where to write discovery files.
 * On POSIX: writes to $TMPDIR and also /tmp if different (matching transport.c search paths).
 * On Windows: writes to the system temp directory (TEMP/TMP).
 */
function discoveryLocations(): string[] {
  if (Deno.build.os === "windows") {
    const tmpdir = Deno.env.get("TEMP") || Deno.env.get("TMP") || "C:\\Windows\\Temp";
    return [join(tmpdir, DISCOVERY_FILENAME)];
  }
  const tmpdir = Deno.env.get("TMPDIR") || "/tmp";
  const locations = [join(tmpdir, DISCOVERY_FILENAME)];
  if (tmpdir !== "/tmp") {
    locations.push(join("/tmp", DISCOVERY_FILENAME));
  }
  return locations;
}

/**
 * Write discovery file so R can find the server.
 * Returns the paths that were successfully written.
 */
export async function writeDiscovery(
  socketPath: string,
  httpPort: number,
): Promise<string[]> {
  const disc: DiscoveryInfo = {
    socketPath,
    httpPort,
    pid: Deno.pid,
  };
  const content = new TextEncoder().encode(JSON.stringify(disc));
  const locations = discoveryLocations();
  const written: string[] = [];

  for (const loc of locations) {
    try {
      await atomicWrite(loc, content);
      written.push(loc);
      console.error(`wrote discovery file: ${loc}`);
    } catch (e) {
      console.error(`warning: failed to write discovery to ${loc}: ${e}`);
    }
  }

  return written;
}

/** Remove discovery files written during startup, but only if they
 *  still belong to this process (another instance may have overwritten). */
export async function removeDiscovery(paths: string[]): Promise<void> {
  for (const p of paths) {
    let info: DiscoveryInfo;
    try {
      const raw = await Deno.readTextFile(p);
      info = JSON.parse(raw);
    } catch {
      // File missing, unreadable, or corrupt JSON — skip
      continue;
    }
    if (info.pid !== Deno.pid) continue;
    try {
      await Deno.remove(p);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) {
        console.error(`warning: failed to remove discovery file ${p}: ${e}`);
      }
    }
  }
}
