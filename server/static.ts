import { normalize, resolve } from "jsr:@std/path@1";

/**
 * Serve static files from a directory.
 * Returns a Response with the file content and appropriate MIME type,
 * or a 404 if the file does not exist.
 */
export async function serveStaticFile(
  req: Request,
  webDir: string,
): Promise<Response> {
  const url = new URL(req.url);
  let pathname = url.pathname;

  // Serve index.html for root
  if (pathname === "/") {
    pathname = "/index.html";
  }

  // Resolve and normalize to prevent path traversal (encoded segments, symlinks, etc.)
  // Use trailing separator to prevent sibling-prefix bypass (e.g. /srv/web-secret matching /srv/web)
  const base = normalize(resolve(webDir));
  const filePath = normalize(resolve(webDir, pathname.slice(1)));
  if (filePath !== base && !filePath.startsWith(base + "/")) {
    return new Response("forbidden", { status: 403 });
  }

  let file: Deno.FsFile;
  try {
    file = await Deno.open(filePath, { read: true });
  } catch {
    return new Response("not found", { status: 404 });
  }

  const contentType = mimeType(pathname);
  return new Response(file.readable, {
    headers: { "Content-Type": contentType },
  });
}

/** Determine MIME type from file extension. */
function mimeType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}
