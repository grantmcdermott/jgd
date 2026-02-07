# vscgd — Full Design & Implementation Plan

## 0) Summary

### What will be built

Two deliverables forming a complete R-to-VS-Code graphics pipeline:

1. **`vscgd`** — An R package containing a custom C-level graphics device that records every R graphics operation into an in-memory display list, serializes it as JSON, and pushes it over a Unix domain socket (named pipe on Windows) to a listening VS Code extension. The device is a *recorder*, not a renderer. It never rasterizes anything.

2. **`vscgd-vscode`** — A VS Code extension that listens on the socket, receives display-list frames, and replays them onto an HTML Canvas2D surface inside a webview panel. It manages plot history, resize-replay, and export to PNG/SVG/PDF.

### Why this avoids httpgd/unigd toolchain issues

httpgd embedded a full C++ SVG rendering stack (libfmt, cpp-httplib/belle/crow, fmt, Boost.Asio or standalone Asio) plus the unigd abstraction layer. These C++ template-heavy dependencies triggered CRAN check failures due to non-API entry points, compiler compatibility issues, and unmaintained upstream libraries.

vscgd avoids this entirely:

- The R package is **pure C** — no C++ at all. It records ops and writes JSON bytes to a socket. The only system dependency is the POSIX socket API (or Winsock on Windows), which R itself already uses.
- **All rendering happens in the browser** (Canvas2D in the VS Code webview). No Cairo, no Pango, no Freetype, no Boost, no C++ web server.
- The transport is a local Unix domain socket managed by the VS Code extension host (Node.js `net` module), not an HTTP server embedded in R.

### What "full fidelity" means here

Every R graphics primitive — lines, polygons, polylines, rectangles, circles, text (with rotation, font face, family, size), raster images, paths (with winding rules), clipping regions, alpha transparency, line types/joins/ends/mitre, and device scaling — is captured losslessly in the display list and rendered faithfully in the webview. A plot rendered by vscgd should be visually indistinguishable from the same plot rendered by `png()` or `pdf()` at the same dimensions, with the caveat that text metrics may differ slightly due to browser font rendering (see Section 6).

---

## 1) Architecture

### System diagram

```
┌─────────────────────────────────────────────────────────┐
│  R Process                                              │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │  vscgd R package                                │    │
│  │                                                 │    │
│  │  C device callbacks ──► Display List (C structs)│    │
│  │       │                       │                 │    │
│  │       │  strWidth/metricInfo  │  on newPage /   │    │
│  │       │  ◄── metrics cache    │  mode(0)        │    │
│  │       │                       ▼                 │    │
│  │       │              JSON serializer            │    │
│  │       │                       │                 │    │
│  │       │                       ▼                 │    │
│  │       │              Unix socket client ────────┼──┐ │
│  │       │                                         │  │ │
│  └───────┼─────────────────────────────────────────┘  │ │
│          │                                            │ │
│          │  text metric requests (sync over socket)   │ │
│          └────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
           │ Unix domain socket / named pipe
           │ (localhost, random path in tmpdir)
           ▼
┌─────────────────────────────────────────────────────────┐
│  VS Code Extension Host (Node.js)                       │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │  vscgd-vscode extension                         │    │
│  │                                                 │    │
│  │  Socket server (net.createServer)               │    │
│  │       │                                         │    │
│  │       ▼                                         │    │
│  │  Message router                                 │    │
│  │       │                                         │    │
│  │       ├──► Plot history store (in-memory)       │    │
│  │       │                                         │    │
│  │       └──► Webview panel ◄──► postMessage API   │    │
│  │                │                                │    │
│  │                ▼                                │    │
│  │           HTML/JS renderer (Canvas2D)           │    │
│  │                │                                │    │
│  │                ├── text metric measurement      │    │
│  │                ├── resize → replay              │    │
│  │                └── export (PNG/SVG/PDF)          │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

### Three components and their boundaries

**R package `vscgd`** (C + R wrapper):

- Owns the `DevDesc` struct and all graphics callbacks
- Owns the in-memory display list (C structs, one per plot page)
- Owns JSON serialization of ops
- Owns the socket client connection
- Provides R functions: `vscgd()` (open device), `vscgd_history()`, `vscgd_export()`

**VS Code extension `vscgd-vscode`** (TypeScript + HTML/JS):

- Owns the socket server lifecycle
- Owns the webview panel and Canvas2D renderer
- Owns plot history navigation and UI
- Owns export pipeline (PNG from canvas, SVG from op replay, PDF via svg2pdf.js or similar)
- Owns text metric measurement service

**Transport** (Unix domain socket / named pipe):

- Socket path: `{tmpdir}/vscgd-{random-token}.sock`
- Extension writes the socket path to a well-known discovery file: `{tmpdir}/vscgd-{pid}.json` or uses an R environment variable `VSCGD_SOCKET`
- Messages are newline-delimited JSON (NDJSON)
- Bidirectional: R→extension for plot ops; extension→R for text metrics responses

### Which process hosts the server

The **extension host** runs the socket server. R connects as a client. Rationale:

- The extension is long-lived and manages the webview lifecycle
- R sessions come and go; the extension can accept multiple R connections
- No need for any server library in the R package (no C++ web server)

### Multiple R sessions

Each R session connects to the same socket server. The extension assigns a session ID on connection. Plot history is keyed by session ID. The webview shows a session selector if multiple sessions are active.

### Crash/reload behavior

- **R crashes**: the socket disconnects. Extension keeps the plot history for that session. User can still navigate/export existing plots.
- **VS Code reloads**: the extension restarts the socket server at the same path. R's next draw operation will fail to write, detect the broken pipe, and attempt reconnection. The current display list in R memory is preserved; it will be re-sent on reconnect.
- **Webview hidden and re-shown**: `retainContextWhenHidden: true` preserves state. If the webview is disposed and recreated, the extension replays the current plot's display list from its in-memory history store.

---

## 2) R Graphics Device: Exact Callback Surface

### Callback table

| Callback | Key Parameters | Display-list op | MVP | Notes |
|---|---|---|---|---|
| `activate` | dd | `{op:"activate"}` | ✓ | Notify extension this device is active |
| `deactivate` | dd | `{op:"deactivate"}` | ✓ | |
| `newPage` | gc (fill color) | `{op:"newPage", fill}` | ✓ | Finalizes previous page, pushes to history, starts new page |
| `close` | dd | `{op:"close"}` | ✓ | Flush final page, disconnect |
| `clip` | x0, x1, y0, y1 | `{op:"clip", x0, y0, x1, y1}` | ✓ | Pushes clip rect onto clip stack |
| `line` | x1, y1, x2, y2, gc | `{op:"line", x1, y1, x2, y2, gc}` | ✓ | |
| `polyline` | n, x[], y[], gc | `{op:"polyline", x, y, gc}` | ✓ | Arrays of coords |
| `polygon` | n, x[], y[], gc | `{op:"polygon", x, y, gc}` | ✓ | |
| `rect` | x0, y0, x1, y1, gc | `{op:"rect", x0, y0, x1, y1, gc}` | ✓ | |
| `circle` | x, y, r, gc | `{op:"circle", x, y, r, gc}` | ✓ | |
| `text` | x, y, str, rot, hadj, gc | `{op:"text", x, y, str, rot, hadj, gc}` | ✓ | UTF-8 via `textUTF8` |
| `textUTF8` | (same as text) | (same) | ✓ | `hasTextUTF8 = TRUE` |
| `strWidth` | str, gc | → returns double | ✓ | Sync metric request to extension |
| `strWidthUTF8` | str, gc | → returns double | ✓ | |
| `metricInfo` | c, gc → ascent, descent, width | → returns 3 doubles | ✓ | Sync metric request |
| `path` | x[], y[], npoly, nper[], winding, gc | `{op:"path", x, y, npoly, nper, winding, gc}` | Phase 2 | Bezier via polyline approximation in MVP |
| `raster` | raster (ABGR), w, h, x, y, width, height, rot, interpolate, gc | `{op:"raster", data, w, h, ...}` | Phase 2 | Base64-encoded PNG |
| `mode` | mode (0=stop, 1=start) | `{op:"mode", mode}` | ✓ | mode(0) triggers frame commit/flush |
| `size` | → left, right, bottom, top | Returns current device dims | ✓ | Extension notifies R of resize |
| `holdflush` | level | Batching control | Phase 2 | |
| `cap` | → SEXP (raster) | Not supported initially | Phase 3 | Screen capture |
| `setPattern` | pattern | `{op:"setPattern", ...}` | Phase 3 | Gradient/pattern fills |
| `setClipPath` | path, ref | `{op:"setClipPath", ...}` | Phase 3 | Arbitrary clip paths |
| `setMask` | path, ref | `{op:"setMask", ...}` | Phase 3 | Alpha/luminance masks |
| `defineGroup` | source, op, dest | `{op:"defineGroup", ...}` | Phase 3 | Compositing groups |
| `useGroup` | ref, trans | `{op:"useGroup", ...}` | Phase 3 | |
| `stroke`/`fill`/`fillStroke` | path, gc | `{op:"stroke/fill/fillStroke", ...}` | Phase 3 | R >= 4.2 path-based drawing |
| `glyph` | glyphs, x, y, font, size, colour, rot | `{op:"glyph", ...}` | Phase 3 | R >= 4.3 |
| `locator` | → x, y | Interactive point selection | Phase 3 | |

### How base graphics and grid graphics are both supported

Both base and grid go through the same `DevDesc` callbacks. There is no separate "grid mode" — grid calls the same `line()`, `polygon()`, `text()`, `clip()`, etc. The device doesn't need to distinguish them. The key difference is that grid uses `newPage` (via `grid.newpage()`) and manages its own viewport/clipping stack, but all of that resolves to the same device-level primitives.

### Plot completion detection

Plot completion is detected by the `mode` callback:

- `mode(1)` = drawing started
- `mode(0)` = drawing stopped → **commit frame**

On `mode(0)`, the current display list for the current page is serialized and sent to the extension as a complete frame. The extension replaces the current page in its buffer.

`newPage` signals a new plot page: the current page is finalized and pushed to history, and a fresh display list begins.

### Clipping

The `clip()` callback sets a rectangular clip region. The display list records each clip change as a `clip` op. The webview renderer maintains a clip stack and applies `ctx.save()` / `ctx.beginPath()` / `ctx.rect()` / `ctx.clip()` / `ctx.restore()` around subsequent ops. R's graphics engine already clips to device extent, but device-level clipping is needed for grid viewports.

`canClip = TRUE` is set on the device.

### Alpha transparency

R colors are 32-bit ABGR with 8-bit alpha (255 = opaque, 0 = transparent). The gc `col` and `fill` fields carry alpha. The JSON serialization converts to CSS `rgba(r, g, b, a)` strings. Canvas2D natively supports alpha.

`haveTransparency = 2` (yes), `haveTransparentBg = 2` (fully).

### Line joins, ends, mitre

The `gc` struct contains `lend` (line end: round=1, butt=2, square=3), `ljoin` (line join: round=1, mitre=2, bevel=3), and `lmitre` (mitre limit). These map directly to Canvas2D `lineCap`, `lineJoin`, and `miterLimit`.

| R `lend` value | Canvas2D `lineCap` |
|---|---|
| 1 (GE_ROUND_CAP) | `"round"` |
| 2 (GE_BUTT_CAP) | `"butt"` |
| 3 (GE_SQUARE_CAP) | `"square"` |

| R `ljoin` value | Canvas2D `lineJoin` |
|---|---|
| 1 (GE_ROUND_JOIN) | `"round"` |
| 2 (GE_MITRE_JOIN) | `"miter"` |
| 3 (GE_BEVEL_JOIN) | `"bevel"` |

### Text rotation

The `text` callback receives `rot` in degrees (anticlockwise from positive x-axis). The renderer applies `ctx.rotate(-rot * Math.PI / 180)` before drawing text.

### Raster images

The `raster` callback receives raw ABGR pixel data. The C code converts this to a PNG blob (using a minimal PNG encoder — ~200 lines of C, no libpng needed; we vendor a single-file PNG writer such as `miniz`-based or hand-rolled deflate-free uncompressed PNG) and base64-encodes it. The JSON op carries the base64 string. The webview creates an `Image` object and draws it with `ctx.drawImage()`, applying rotation and interpolation settings.

`haveRaster = 2` (yes).

### Paths (Bezier/lines)

The `path` callback receives multiple sub-polygons with a winding rule. The renderer uses `ctx.beginPath()`, iterates sub-paths with `moveTo`/`lineTo`, and fills with the appropriate winding rule (`"nonzero"` or `"evenodd"`).

Note: R's `path()` callback only provides line segments (not Bezier curves). Bezier curves in R are approximated as polylines before reaching the device. So the device only needs to handle line-segment paths.

### Device scaling

The device reports dimensions in "big points" (1/72 inch). The device's `ipr` (inches per raster unit) is set based on the target DPI (default 96 for screen). `cra` (character size in raster units) is derived from the default font size (12pt) and DPI. On resize, the extension sends new pixel dimensions; the R side updates `left`, `right`, `bottom`, `top` and `ipr`, then the extension replays the display list at the new size.

---

## 3) Display List & Op Schema

### Per-plot structure

```json
{
  "version": 1,
  "id": "plot-uuid",
  "sessionId": "session-uuid",
  "timestamp": 1707264000,
  "device": {
    "width": 504,
    "height": 504,
    "dpi": 72,
    "bg": "rgba(255,255,255,1)"
  },
  "ops": [ ... ]
}
```

### State handling: fully-specified ops

Each op carries its full graphics context inline (no push/pop state tracking). This is slightly more verbose but makes replay trivial — any op can be rendered independently, and the display list can be sliced or reordered without state corruption. The gc is deduplicated: if the gc hasn't changed since the last op, a `"gcRef": <index>` is used instead of repeating the full gc object.

```json
{
  "gc": {
    "col": "rgba(0,0,0,1)",
    "fill": "rgba(255,255,255,1)",
    "lwd": 1.0,
    "lty": [],
    "lend": "round",
    "ljoin": "round",
    "lmitre": 10.0,
    "font": {
      "family": "sans-serif",
      "face": 1,
      "size": 12.0,
      "lineheight": 1.2
    }
  }
}
```

### Coordinate conventions

- **R device coordinates**: origin at bottom-left, y increases upward. Units are "device units" where 1 unit = 1/72 inch at the device's stated DPI.
- **Canvas2D coordinates**: origin at top-left, y increases downward.
- The renderer applies a single transform at the start of replay: `ctx.translate(0, height); ctx.scale(1, -1);` to flip the y-axis. All ops are recorded in R's native coordinate system.
- **HiDPI**: the canvas element's CSS size is the logical size; the canvas backing store is scaled by `devicePixelRatio`. The renderer sets `ctx.scale(dpr, dpr)` on the backing store. The display list coordinates are in logical (CSS) pixels.

### Op representations

**Strokes/fills**: Encoded in the gc. `col` = stroke color, `fill` = fill color. `null` means "don't stroke" or "don't fill" (maps to R's `NA_INTEGER`).

**Paths**:

```json
{
  "op": "path",
  "subpaths": [[[x1,y1],[x2,y2],...], ...],
  "winding": "nonzero",
  "gc": {...}
}
```

**Text**:

```json
{
  "op": "text",
  "x": 100,
  "y": 200,
  "str": "Hello",
  "rot": 45.0,
  "hadj": 0.0,
  "gc": {...}
}
```

`hadj` is horizontal adjustment: 0 = left-aligned, 0.5 = centered, 1 = right-aligned.

**Raster**:

```json
{
  "op": "raster",
  "data": "data:image/png;base64,...",
  "x": 0,
  "y": 0,
  "w": 100,
  "h": 100,
  "rot": 0,
  "interpolate": true
}
```

**Clipping**:

```json
{"op": "clip", "x0": 0, "y0": 0, "x1": 504, "y1": 504}
```

### Line type encoding

R's `lty` is an integer encoding dash patterns. The C code converts it to a dash array (extract 4-bit hex nibbles, scale by `lwd`). The JSON carries the dash array directly:

```json
"lty": [4, 2]   // dashed: 4 on, 2 off (scaled by lwd)
"lty": []        // solid (empty array = no dashes)
```

### Versioning strategy

The `"version": 1` field in the plot envelope. The renderer checks this on receipt. Rules:

- New op types can be added in later versions; unknown ops are silently skipped (forward compatible).
- Existing op fields are never removed or retyped (backward compatible).
- If a breaking change is ever needed, version increments and the renderer can support multiple versions.

---

## 4) Serialization & Transport

### Choice: JSON with optional gzip

JSON is chosen over MessagePack/CBOR because:

- Debuggable (human-readable in transit)
- Native in both C (via a minimal JSON writer — no parsing needed on the R side, only serialization) and JavaScript
- The ops are mostly numeric coordinates; JSON overhead is acceptable
- Compression handles the verbosity when needed

### Message framing

NDJSON (newline-delimited JSON) over the socket. Each message is a single JSON object terminated by `\n`. This avoids length-prefix framing complexity.

Message types:

```
R → Extension:  {"type":"frame", "plot": {...}}
R → Extension:  {"type":"newPage"}
R → Extension:  {"type":"metrics_request", "id": 1, "kind": "strWidth", "str": "Hello", "gc": {...}}
Extension → R:  {"type":"metrics_response", "id": 1, "width": 42.5}
Extension → R:  {"type":"resize", "width": 800, "height": 600, "dpi": 96}
```

### Size limits

Individual messages are unlikely to exceed a few MB for typical plots. For pathological cases (huge scatterplots with 100k+ points), the polyline/polygon ops carry large coordinate arrays. At ~16 bytes per point in JSON, 100k points ≈ 1.6 MB — well within socket buffer limits.

For raster-heavy plots (e.g., `image()` with a large matrix), the base64-encoded PNG could be several MB. This is acceptable for local IPC.

### Compression

Not used in MVP. If profiling shows transport is a bottleneck for large plots, gzip compression can be added as an opt-in per-message flag (`"compressed": true` + gzip the JSON body after the header). Node.js has built-in zlib; C has `R_compress1` or we can vendor miniz (~1 file).

### Incremental streaming vs full-frame commits

**Full-frame commits**. On `mode(0)` (drawing stopped), the entire display list for the current page is serialized and sent as one `frame` message. Rationale:

- Simpler than incremental streaming (no partial-frame state on the extension side)
- R drawing is fast; the frame is complete before the user sees anything
- Avoids flicker from partial renders

Exception: for interactive `locator()` support (Phase 3), incremental updates may be needed.

### Security model

- Socket path is in the user's tmpdir with a random token: `{tmpdir}/vscgd-{random-hex}.sock`
- Unix domain sockets are inherently local-only (no network exposure)
- On Windows, named pipes with a random name provide equivalent isolation
- No authentication token needed beyond the random socket path (same security model as R's own IPC)

### Session discovery

The extension writes a JSON discovery file on startup:

```
{tmpdir}/vscgd-discovery.json
```

Contents:

```json
{"socketPath": "/tmp/vscgd-a1b2c3d4.sock", "pid": 12345}
```

The R package reads this file (or accepts the path via `options(vscgd.socket = "...")` or `VSCGD_SOCKET` env var) to find the socket. The extension also sets the env var in R terminals it spawns.

### Reconnect

If the socket disconnects:

- **R side**: on next draw operation, detect `EPIPE`/`ECONNRESET`, attempt reconnect (re-read discovery file, connect). If reconnect fails after 3 attempts, warn the user and fall back to a no-op device (don't crash R).
- **Extension side**: accept new connections at any time. A reconnecting R session re-identifies itself with its session ID.

---

## 5) Webview Renderer

### Primary renderer: Canvas2D

Canvas2D is chosen over SVG because:

- **Performance**: Canvas2D is faster for large numbers of primitives (scatterplots with 100k points). SVG would create 100k DOM nodes.
- **Replay model**: Canvas2D's imperative API maps directly to the display-list ops. Each op is a function call. SVG would require building/diffing a DOM tree.
- **HiDPI**: Canvas2D handles `devicePixelRatio` scaling naturally via backing store size.
- **Export**: `canvas.toBlob()` gives PNG directly. SVG export is handled separately by replaying ops to an SVG builder (see Section 8).

### Replay pipeline

```
frame received → store in history → if current plot: replay()

replay():
  1. Clear canvas
  2. Set canvas size to panel size × devicePixelRatio
  3. Apply base transform (y-flip, DPI scaling)
  4. For each op in display list:
     - Apply gc (stroke style, fill style, line width, dash, cap, join, mitre, font)
     - Execute drawing command
     - Handle clip ops (save/restore + clip rect)
  5. Done
```

The replay function is a tight loop over the ops array. Each op type maps to 1-3 Canvas2D calls. A 10k-op plot replays in <10ms on modern hardware.

### HiDPI and scaling

```javascript
const dpr = window.devicePixelRatio || 1;
canvas.width = logicalWidth * dpr;
canvas.height = logicalHeight * dpr;
canvas.style.width = logicalWidth + 'px';
canvas.style.height = logicalHeight + 'px';
ctx.scale(dpr, dpr);
```

The display list coordinates are in logical pixels (matching R's device dimensions). The `dpr` scaling is applied once at the canvas level.

### Resize handling

1. VS Code panel resizes → webview detects via `ResizeObserver`
2. Webview sends new dimensions to extension host via `postMessage`
3. Extension sends `{"type":"resize", "width": W, "height": H}` to R over socket
4. R updates device dimensions (`dd->right`, `dd->top`, etc.)
5. Extension replays the *same* display list at the new canvas size
6. If R is idle, the plot looks correct immediately (coordinates are in device units, which scale with device size)
7. If the plot uses absolute positioning (rare), R can optionally re-record by replaying its own display list (via `GEplayDisplayList()`)

Key insight: because R's graphics engine maintains its own display list (separate from ours), calling `GEplayDisplayList(GEcurrentDevice())` from R will re-execute all the graphics commands, which will re-invoke our device callbacks at the new device dimensions. The extension triggers this by sending a resize message; the R side calls `GEplayDisplayList()` in response.

### Zoom/pan (optional, Phase 3)

Canvas2D supports arbitrary transforms. Zoom/pan can be implemented by wrapping the replay in an additional `ctx.translate(panX, panY); ctx.scale(zoom, zoom)` transform. The display list doesn't change; only the view transform changes. This is cheap.

---

## 6) Text Metrics / Font Handling

This is the hardest problem in the entire project.

### The problem

R's layout engine (both base and grid) calls `strWidth()` and `metricInfo()` *during plotting* to determine text dimensions for layout decisions (axis label placement, legend sizing, `strwidth()` calls in user code, etc.). The device must return accurate measurements synchronously.

In httpgd, this was handled by an embedded SVG renderer with font metrics. We don't have that — our renderer is in a webview.

### Strategy: synchronous metric round-trip with caching

**MVP approach (Phase 1)**: Approximation-based metrics using a built-in font metrics table.

The C device code includes a pre-computed metrics table for common fonts (sans-serif, serif, monospace) at reference sizes. `strWidth` multiplies character widths by `cex * ps` scaling. This is the same approach used by R's `pdf()` device (which uses Adobe font metrics tables). It's imprecise for unusual fonts but correct enough for layout.

The table is generated offline by measuring character widths in a browser for the standard CSS font stacks.

**Phase 2 approach**: Synchronous round-trip to the webview.

1. R calls `strWidth("Hello", gc)` in the device callback
2. C code sends `{"type":"metrics_request", "id":1, "kind":"strWidth", "str":"Hello", "gc":{...}}` over the socket
3. C code blocks on a `read()` from the socket, waiting for the response (with a timeout)
4. Extension receives the request, forwards to webview via `postMessage`
5. Webview measures text using `ctx.measureText("Hello")` with the appropriate font set on a hidden canvas
6. Webview sends result back to extension via `postMessage`
7. Extension sends `{"type":"metrics_response", "id":1, "width":42.5}` to R
8. C code receives the response, returns the width to R

**Latency concern**: This round-trip (R → socket → extension host → webview → extension host → socket → R) adds ~1-5ms per call. R may call `strWidth` hundreds of times during a complex plot. Mitigation:

- **Aggressive caching**: Cache `(string, font_family, font_face, font_size) → width` in a hash table on the C side. Most plots reuse the same font settings, so cache hit rate is very high.
- **Batch prefetch**: On `mode(1)` (drawing started), the extension can pre-measure common characters and send a metrics table to R.
- **Fallback**: If the socket is slow or disconnected, fall back to the approximation table.

### Font mapping strategy

| R `fontfamily` | CSS font-family |
|---|---|
| `""` (default) | `sans-serif` |
| `"sans"` | `sans-serif` |
| `"serif"` | `serif` |
| `"mono"` | `monospace` |
| `"Helvetica"` | `"Helvetica", "Arial", sans-serif` |
| `"Times"` | `"Times New Roman", "Times", serif` |
| `"Courier"` | `"Courier New", "Courier", monospace` |
| (other) | passed through as-is |

R font faces: 1=plain, 2=bold, 3=italic, 4=bold-italic, 5=symbol. Face 5 (symbol) uses the Symbol/ZapfDingbats encoding; the C code converts via `AdobeSymbol2utf8()` before sending.

### Consistency on resize

Because the display list records text as strings (not pre-measured glyphs), and the webview re-measures text during replay, text layout is consistent across resizes *within the same webview*. The risk is that R's layout decisions (made using metrics from the approximation table or round-trip) don't perfectly match the webview's rendering. This is the same class of problem that `pdf()` has — and it's acceptable. Phase 2's round-trip metrics minimize this gap.

---

## 7) Plot History & UI

### History storage

- Each completed plot (finalized by `newPage` or `mode(0)` on the last page) is stored as a JSON display-list object in the extension's memory.
- Default limit: **50 plots** per session. Configurable via extension setting `vscgd.historyLimit`.
- Memory limit: **100 MB** total across all sessions. When exceeded, oldest plots are evicted (LRU).
- Raster-heavy plots are the main memory concern. A 1000×1000 raster at 4 bytes/pixel = 4 MB raw, ~1 MB as base64 PNG. 50 such plots = ~50 MB.

### Navigation semantics

- **Back**: show previous plot in history. Does not affect R state.
- **Forward**: show next plot. If at the latest plot, forward is disabled.
- **New plot from R**: automatically navigates to the new plot (appended to history). If the user was viewing an older plot, the new plot is still appended and the view jumps to it.
- **Clear**: removes all plots for the current session. Frees memory.

### Session isolation

Each R session (identified by its socket connection) has an independent history list. Switching sessions switches the visible history. If a session disconnects, its history is retained until the user clears it or the memory limit forces eviction.

### VS Code commands and keybindings

| Command | Default Keybinding | Description |
|---|---|---|
| `vscgd.previousPlot` | `Alt+Left` | Navigate to previous plot |
| `vscgd.nextPlot` | `Alt+Right` | Navigate to next plot |
| `vscgd.clearHistory` | — | Clear all plots for active session |
| `vscgd.exportPng` | — | Export current plot as PNG |
| `vscgd.exportSvg` | — | Export current plot as SVG |
| `vscgd.exportPdf` | — | Export current plot as PDF |
| `vscgd.showPlotPane` | — | Focus/reveal the plot pane |

### Webview toolbar

The webview includes a minimal toolbar rendered in HTML at the top of the panel:

```
[ ◀ ] [ 3 / 7 ] [ ▶ ] [ 📋 Export ▾ ] [ ✕ Clear ]
```

- Back/forward buttons with plot index indicator
- Export dropdown (PNG / SVG / PDF)
- Clear button

### Status bar indicator

A status bar item shows connection state: `vscgd: connected (2 sessions)` or `vscgd: waiting for R`. Clicking it reveals the plot pane.

---

## 8) Export Pipeline

### PNG export

- **Where**: Webview (browser context).
- **How**: `canvas.toBlob('image/png')` on the current canvas. The blob is transferred to the extension host via `postMessage` (ArrayBuffer transfer, efficient in VS Code 1.57+). The extension host writes the blob to a file via `vscode.workspace.fs`.
- **Scaling**: User can choose export scale (1×, 2×, 4×). The canvas is temporarily resized to `logicalWidth * scale × logicalHeight * scale`, the display list is replayed at that resolution, the blob is captured, and the canvas is restored.
- **Default filename**: `plot-{index}-{timestamp}.png`.

### SVG export

- **Where**: Extension host (or webview — either works).
- **How**: A dedicated SVG builder replays the display list ops into SVG elements instead of Canvas2D calls. This is a separate code path from the Canvas2D renderer but shares the same op-dispatch logic.
- **Implementation**: A TypeScript module `svg-renderer.ts` that takes a display list and returns an SVG string. Each op maps to an SVG element:

| Op | SVG element |
|---|---|
| `line` | `<line>` |
| `polyline` | `<polyline>` |
| `polygon` | `<polygon>` |
| `rect` | `<rect>` |
| `circle` | `<circle>` |
| `text` | `<text>` with `transform="rotate(...)"` |
| `path` | `<path>` with `d="M... L..."` |
| `raster` | `<image>` with embedded base64 data URI |
| `clip` | `<clipPath>` + `<rect>` applied via `clip-path` attribute |

- Graphics context maps to SVG attributes: `stroke`, `fill`, `stroke-width`, `stroke-dasharray`, `stroke-linecap`, `stroke-linejoin`, `stroke-miterlimit`, `opacity`/`fill-opacity`/`stroke-opacity`.
- The SVG viewBox matches the R device dimensions. The y-axis is flipped via a top-level `transform="translate(0, H) scale(1, -1)"` on a wrapping `<g>`.

### PDF export

- **Where**: Extension host.
- **How**: SVG → PDF conversion. Options evaluated:

| Approach | Pros | Cons |
|---|---|---|
| `svg2pdf.js` (jsPDF plugin) | Pure JS, no native deps, runs in extension host | Font embedding can be tricky |
| `pdfkit` | Mature, good text support | Would need a separate op→PDF renderer (not SVG-based) |
| Shell out to `rsvg-convert` or `inkscape` | High fidelity | External dependency, not portable |

**Chosen approach**: `svg2pdf.js` via `jsPDF` for MVP. It takes the SVG string produced by the SVG renderer and converts it to PDF. Font embedding is limited to standard fonts initially; custom font embedding is Phase 3.

If `svg2pdf.js` proves insufficient, Phase 3 can add a direct op→PDF renderer using `pdfkit`, which gives full control over paths, text, and fonts.

### Export trigger

- **Command palette**: `vscgd.exportPng`, `vscgd.exportSvg`, `vscgd.exportPdf`
- **Toolbar button**: Export dropdown in the webview toolbar
- **R function**: `vscgd_export(format = "png", file = "plot.png", width = 800, height = 600)` sends an export request over the socket; the extension performs the export and writes the file. This allows scripted/batch export from R.

---

## 9) Language/Tooling Choice and CRAN Strategy

### Decision: Pure C for the R device

The R package's compiled code is **pure C** (C11). No C++, no Rust.

**Rationale**:

- **Zero toolchain risk**: Every platform that builds R can build this package. No Rust compiler, no cargo, no C++ standard library version issues.
- **CRAN compliance**: Pure C packages have the simplest review path. No `SystemRequirements` beyond what R itself needs. No `configure` script complexity for toolchain detection.
- **Maintenance**: The C code is small (~2000-3000 lines total). The device callbacks are thin — they append structs to an array and serialize to JSON. There's no complex memory management beyond a growable array and a hash table for metrics caching.
- **httpgd's failure mode was C++ dependencies**: belle/crow web servers, Boost.Asio, libfmt, template-heavy headers. Pure C eliminates this entire class of problem.

**Why not Rust (extendr/savvy)**:

- Both extendr and savvy are viable and on CRAN. However, they add a Rust toolchain requirement at install time, which some users (especially on institutional Linux with old system packages) may not have.
- The device callback code is straightforward C — there's no complex logic that benefits from Rust's safety guarantees. The main risk (buffer overflows in JSON serialization) is mitigated by using a simple growable-buffer abstraction.
- If the project later needs Rust (e.g., for a high-performance binary serializer), it can be added as an optional compiled component without changing the core device.

### Minimal system dependencies

**None**. The package uses only:

- R's C API (`R.h`, `Rinternals.h`, `R_ext/GraphicsDevice.h`, `R_ext/GraphicsEngine.h`)
- POSIX sockets (`sys/socket.h`, `sys/un.h`) on Unix; Winsock2 (`winsock2.h`, `afunix.h`) on Windows
- Standard C library (`stdio.h`, `stdlib.h`, `string.h`, `math.h`)

All of these are available on every platform R supports.

### Vendored code

Two small single-file libraries are vendored (included in `src/`):

1. **Minimal PNG encoder** (~200 lines of C): Encodes raw RGBA pixels to PNG for raster ops. No zlib dependency — uses uncompressed PNG (filter=none, compression=stored) which is valid PNG, just larger. For smaller output, we can optionally use R's built-in zlib via `R_compress1()`.

2. **JSON writer** (~150 lines of C): A simple `json_writer` struct with `json_obj_start()`, `json_key_str()`, `json_key_num()`, `json_arr_start()`, etc. Write-only (no parsing). Outputs to a growable char buffer.

### CRAN submission strategy

- `DESCRIPTION`: `SystemRequirements: none` (or omit the field)
- No `configure` / `configure.win` scripts needed (no external toolchain detection)
- `Makevars`: standard, just lists the `.c` files. No `PKG_LIBS` beyond what R provides.
- `R CMD check --as-cran` passes on all platforms with zero NOTEs related to compiled code
- The package is self-contained: `R CMD build` produces a tarball that installs anywhere R does

### Windows support

Windows 10 1803+ supports Unix domain sockets via `AF_UNIX` in Winsock2. For older Windows, fall back to TCP `localhost:random-port` with a connection token. The `configure.win` script (if needed) detects `AF_UNIX` support at compile time via a feature test.

### macOS support

No special handling needed. macOS fully supports Unix domain sockets. The R toolchain on macOS (Xcode CLT or gfortran from R-project) compiles C11 without issues.

---

## 10) MVP → Parity Roadmap

### Phase 1: MVP — "I see my plot in VS Code" (2-4 weeks)

**Deliverables**:

- C device with callbacks: `newPage`, `close`, `clip`, `line`, `polyline`, `polygon`, `rect`, `circle`, `text`/`textUTF8`, `strWidth`/`strWidthUTF8` (approximation table), `metricInfo` (approximation), `mode`, `size`, `activate`, `deactivate`
- JSON serializer for all MVP ops
- Unix domain socket client in C with discovery-file-based connection
- VS Code extension with socket server, webview panel, Canvas2D replay
- Basic plot history (back/forward navigation, up to 50 plots)
- Resize → replay (using stored display list, no R re-record yet)
- R wrapper function `vscgd()` to open the device
- Works on macOS and Linux

**Acceptance tests**:

- `plot(1:10)` renders correctly
- `plot(1:10); lines(1:10, col="red")` shows both elements
- `hist(rnorm(1000))` renders with correct fill colors
- `barplot(1:5)` renders rectangles and labels
- `text(5, 5, "Hello", srt=45)` shows rotated text
- Resize the VS Code panel → plot scales without re-running R
- Navigate back/forward through 3 plots
- ggplot2: `ggplot(mtcars, aes(wt, mpg)) + geom_point()` renders

### Phase 2: "Most plots work" parity (4-8 weeks after MVP)

**Deliverables**:

- `path` callback (winding rules, sub-paths)
- `raster` callback (base64 PNG encoding, rotation, interpolation)
- `holdflush` for batched drawing
- Synchronous text metrics round-trip (Phase 2 approach from Section 6) with caching
- R-side resize via `GEplayDisplayList()` for accurate re-layout
- PNG export via `canvas.toBlob()`
- SVG export via dedicated SVG renderer
- PDF export via `svg2pdf.js`
- Windows support (AF_UNIX or TCP fallback)
- Extension settings (history limit, export defaults)
- R functions: `vscgd_export()`, `vscgd_history()`

**Acceptance tests**:

- All Phase 1 tests still pass
- `image(volcano)` renders raster correctly
- `ggplot(faithfuld, aes(waiting, eruptions, fill=density)) + geom_raster()` works
- Complex ggplot2 facets: `ggplot(mpg, aes(displ, hwy)) + geom_point() + facet_wrap(~class)` renders all panels with correct clipping
- `polygon(x, y, col=rgb(1,0,0,0.5))` shows semi-transparent fill
- Dash patterns: `plot(1:10, lty=2)` shows dashed lines
- Export PNG at 2× resolution produces correct output
- Export SVG opens correctly in a browser
- Export PDF opens correctly in a PDF viewer
- Resize triggers R re-record; axis labels reflow correctly

### Phase 3: Full parity + performance (8-16 weeks after Phase 2)

**Deliverables**:

- `setPattern` / `releasePattern` (gradient fills)
- `setClipPath` / `releaseClipPath` (arbitrary clip paths)
- `setMask` / `releaseMask` (alpha/luminance masks)
- `defineGroup` / `useGroup` / `releaseGroup` (compositing)
- `stroke` / `fill` / `fillStroke` (R >= 4.2 path-based drawing)
- `glyph` callback (R >= 4.3)
- `cap` callback (screen capture)
- `locator` callback (interactive point selection via webview click)
- Zoom/pan in webview
- Custom font support in PDF export
- Performance optimization: binary coordinate arrays, optional MessagePack for large frames
- Multi-session UI (session selector in webview)
- Thumbnail generation for plot history sidebar

**Acceptance tests**:

- All Phase 1 and 2 tests still pass
- `ggplot(economics, aes(date, unemploy)) + geom_area(fill=scales::gradient_n_pal(c("blue","red"))(seq(0,1,length=100)))` — gradient fills
- `grid.circle(gp=gpar(fill=linearGradient()))` — R 4.1+ gradient support
- `locator(1)` returns click coordinates from webview
- 100k-point scatterplot renders in <500ms and replays in <100ms
- Plot with `dev.capture()` returns correct raster
- Zoom to 200% and pan around a complex plot

---

## 11) Testing Plan

### Golden tests (record ops for known plots)

- Maintain a set of R scripts that produce known plots (the 15 acceptance plots from the deliverables section).
- Each script is run with `vscgd()` and the resulting display-list JSON is captured and stored as a `.json` golden file.
- On each CI run, the scripts are re-run and the output JSON is compared to the golden file. Differences indicate a regression in the device callbacks or serialization.
- Golden files are updated intentionally when the op schema changes (version bump).

### Visual regression testing in webview (headless)

- Use Playwright or Puppeteer to load the webview HTML in a headless Chromium instance.
- Feed each golden JSON file to the Canvas2D renderer.
- Capture a screenshot of the canvas via `page.screenshot()`.
- Compare against stored reference PNGs using pixel-diff (e.g., `pixelmatch` library). Allow a small tolerance (< 0.1% pixel difference) for anti-aliasing variations across platforms.
- Run on CI for Linux (Ubuntu) and macOS.

### R CMD check strategy across OS

- **CI matrix**: GitHub Actions with `r-lib/actions` for R CMD check on:
  - Ubuntu 22.04 (R-release, R-devel)
  - macOS (R-release)
  - Windows (R-release)
- `R CMD check --as-cran` must pass with zero errors, zero warnings, zero NOTEs on all platforms.
- Additional check: `R CMD check` with `valgrind` on Linux to detect memory leaks in C code.
- Additional check: `R CMD check` with AddressSanitizer (`-fsanitize=address`) on Linux.

### Performance benchmarks

Tracked on CI, regression alerts if >20% slower:

| Benchmark | Target |
|---|---|
| `plot(rnorm(100000), rnorm(100000))` — 100k point scatter | Device record: <200ms. Transport: <50ms. Replay: <100ms. |
| `ggplot(diamonds, aes(carat, price)) + geom_point()` — 54k points with ggplot overhead | End-to-end: <2s |
| `image(matrix(rnorm(1e6), 1000, 1000))` — 1M pixel raster | Record + encode: <500ms. Transport: <200ms. Replay: <100ms. |
| `ggplot(mpg, aes(displ, hwy)) + facet_wrap(~class)` — 7 facets | End-to-end: <1s |
| Resize replay of a 10k-op plot | <50ms |
| `strWidth` cache miss round-trip | <5ms |

---

## 12) Risks & Mitigations

### Text metrics mismatch

**Risk**: R's layout decisions (axis placement, legend sizing, `strwidth()`) use metrics from the device. If our metrics (approximation table or round-trip) don't match the webview's actual text rendering, labels may overlap or be mispositioned.

**Mitigation**: Phase 2's synchronous round-trip measures text in the *same* browser engine that renders it, so metrics match exactly for the rendering context. The approximation table (Phase 1) is generated from browser measurements, so it's close. Remaining mismatches are the same class of problem that `pdf()` and `svg()` devices have — users accept this.

### Grid edge cases

**Risk**: Grid's viewport system creates complex nested clipping regions. Some grid-based packages (e.g., `gridExtra`, `patchwork`, `cowplot`) push the clipping stack deeply.

**Mitigation**: The clip op is simple (rectangular clip, save/restore). Canvas2D's clip stack is unlimited. The main risk is performance with many save/restore cycles — but even 100 nested clips are trivial for Canvas2D.

### Memory bloat with rasters

**Risk**: Plots with large raster images (e.g., `image()` on a 10000×10000 matrix) produce large base64 strings in the display list, consuming significant memory in both R and the extension.

**Mitigation**:
- PNG compression reduces raw pixel data by 50-90%.
- The 100 MB memory limit on the extension side evicts old plots.
- For extreme cases, the extension can write display lists to disk and load on demand (Phase 3).
- R-side: the display list is freed after transmission; only the extension retains it.

### Latency over transport

**Risk**: Unix domain socket IPC adds latency to text metric round-trips, potentially slowing complex plots with many `strWidth` calls.

**Mitigation**:
- Aggressive caching (most plots reuse <10 unique font configurations).
- Batch prefetch of ASCII character widths on `mode(1)`.
- Approximation table fallback if socket is slow.
- Measured worst case: 500 unique `strWidth` calls × 3ms = 1.5s. With caching, realistic case is <50 unique calls = <150ms.

### VS Code webview limitations

**Risk**: VS Code webviews run in an iframe with some restrictions. `retainContextWhenHidden` uses memory. Webview disposal loses canvas state.

**Mitigation**:
- `retainContextWhenHidden: true` keeps the canvas alive when the panel is not visible.
- If the webview is disposed (e.g., user closes the panel), the extension retains the display list in memory and replays it when the webview is recreated.
- Canvas2D is fully supported in VS Code webviews (Chromium-based). No WebGL or WebGPU needed for MVP.

### CRAN policy issues

**Risk**: CRAN reviewers may object to the socket communication, the vendored PNG encoder, or other aspects.

**Mitigation**:
- Socket communication uses only POSIX/Winsock APIs that R itself uses. No external libraries.
- Vendored code is minimal (<400 lines total), clearly attributed, and has permissive licenses (MIT/public domain).
- The package has zero `SystemRequirements`.
- The package works standalone (without the VS Code extension) as a null device — it just records ops. The extension is a separate, non-CRAN deliverable.
- Precedent: packages like `httpuv` (used by Shiny) use socket communication and are on CRAN.

### R version compatibility

**Risk**: Newer `DevDesc` callbacks (`setPattern`, `defineGroup`, `glyph`, etc.) were added in R 4.1-4.3. Older R versions don't have these fields.

**Mitigation**:
- Check `R_GE_version` at compile time and runtime. Only set newer callback pointers if the running R version supports them.
- Use `#if R_GE_version >= N` guards in C code.
- MVP targets R >= 4.0 (which covers the vast majority of users). Phase 3 features require R >= 4.1 or 4.3.

---

## Deliverables

### Repository layout

Mono-repo structure:

```
vscgd/
├── PLAN.md                          # This document
├── LICENSE                          # MIT
├── README.md
│
├── r-package/                       # R package: vscgd
│   ├── DESCRIPTION
│   ├── NAMESPACE
│   ├── R/
│   │   ├── device.R                 # vscgd() entry point
│   │   ├── export.R                 # vscgd_export()
│   │   ├── history.R                # vscgd_history()
│   │   └── zzz.R                    # .onLoad, option defaults
│   ├── src/
│   │   ├── device.c                 # DevDesc setup, callback dispatch
│   │   ├── device.h
│   │   ├── callbacks.c              # Individual callback implementations
│   │   ├── callbacks.h
│   │   ├── display_list.c           # Growable op array, per-page storage
│   │   ├── display_list.h
│   │   ├── json_writer.c            # Minimal JSON serializer
│   │   ├── json_writer.h
│   │   ├── transport.c              # Socket client, connect/send/recv
│   │   ├── transport.h
│   │   ├── metrics.c                # Approximation table + cache
│   │   ├── metrics.h
│   │   ├── png_encoder.c            # Minimal PNG encoder (vendored)
│   │   ├── png_encoder.h
│   │   ├── color.c                  # R color → rgba string conversion
│   │   ├── color.h
│   │   ├── init.c                   # R_init_vscgd, .Call registrations
│   │   └── Makevars
│   ├── man/
│   │   ├── vscgd.Rd
│   │   ├── vscgd_export.Rd
│   │   └── vscgd_history.Rd
│   ├── tests/
│   │   ├── testthat/
│   │   │   ├── test-device.R        # Basic device open/close
│   │   │   ├── test-callbacks.R     # Op recording correctness
│   │   │   └── test-json.R          # JSON output validation
│   │   └── testthat.R
│   └── inst/
│       └── metrics/
│           └── font_metrics.json    # Pre-computed font metrics table
│
├── vscode-extension/                # VS Code extension: vscgd-vscode
│   ├── package.json                 # Extension manifest
│   ├── tsconfig.json
│   ├── src/
│   │   ├── extension.ts             # activate/deactivate, command registration
│   │   ├── socket-server.ts         # net.createServer, session management
│   │   ├── message-router.ts        # NDJSON parse, dispatch by type
│   │   ├── plot-history.ts          # In-memory history store, LRU eviction
│   │   ├── webview-provider.ts      # WebviewPanel creation, postMessage bridge
│   │   ├── export.ts                # PNG/SVG/PDF export orchestration
│   │   └── svg-renderer.ts          # Display list → SVG string
│   ├── webview/
│   │   ├── index.html               # Webview HTML shell
│   │   ├── renderer.js              # Canvas2D replay engine
│   │   ├── metrics.js               # Text measurement service
│   │   ├── toolbar.js               # Navigation/export UI
│   │   └── style.css
│   ├── test/
│   │   ├── golden/                  # Golden JSON display lists
│   │   ├── reference/               # Reference PNG screenshots
│   │   ├── replay.test.ts           # Replay correctness tests
│   │   ├── socket.test.ts           # Transport tests
│   │   └── visual-regression.test.ts
│   └── .vscodeignore
│
├── test-plots/                      # Acceptance plot R scripts
│   ├── 01-scatter.R
│   ├── 02-histogram.R
│   ├── 03-barplot.R
│   ├── 04-text-rotation.R
│   ├── 05-clipping.R
│   ├── 06-raster.R
│   ├── 07-alpha.R
│   ├── 08-ggplot-facets.R
│   ├── 09-line-types.R
│   ├── 10-path-winding.R
│   ├── 11-ggplot-complex.R
│   ├── 12-base-legend.R
│   ├── 13-lattice-panel.R
│   ├── 14-math-expression.R
│   └── 15-large-scatter.R
│
└── .github/
    └── workflows/
        ├── r-cmd-check.yml          # R CMD check matrix
        ├── extension-test.yml       # Extension unit + visual regression
        └── benchmark.yml            # Performance regression tracking
```

### Task breakdown with dependencies

```
WP1: C device skeleton                          [no deps]        ~3 days
  - DevDesc setup, activate/deactivate/close/mode/size/newPage
  - Growable display-list array (C structs)
  - Null-op callbacks for all other slots

WP2: JSON writer                                [no deps]        ~2 days
  - json_writer.c: growable buffer, object/array/string/number emission
  - Unit tests via R .Call interface

WP3: Socket transport (C client)                [no deps]        ~2 days
  - Unix domain socket connect/send/recv
  - Discovery file reader
  - Reconnect logic with backoff

WP4: Drawing callbacks                          [WP1, WP2]      ~3 days
  - line, polyline, polygon, rect, circle
  - gc → JSON serialization (color, lwd, lty, lend, ljoin, lmitre)
  - clip callback

WP5: Text callbacks + metrics table             [WP1, WP2]      ~3 days
  - text/textUTF8, strWidth/strWidthUTF8, metricInfo
  - Pre-computed font metrics table (generate from browser)
  - Metrics cache (hash table in C)

WP6: Frame commit + integration                 [WP1-WP5]       ~2 days
  - mode(0) → serialize full display list → send over socket
  - newPage → finalize + start new page
  - R wrapper function vscgd()

WP7: VS Code extension skeleton                 [no deps]        ~2 days
  - Extension activation, socket server, webview panel
  - NDJSON message parsing
  - postMessage bridge to webview

WP8: Canvas2D renderer                          [WP7]            ~4 days
  - Replay engine: dispatch by op type
  - gc application (stroke, fill, dash, cap, join, font)
  - Y-axis flip transform
  - HiDPI scaling
  - Clip stack (save/restore/clip)

WP9: Plot history + navigation                  [WP7, WP8]      ~2 days
  - In-memory history store with LRU eviction
  - Back/forward navigation
  - Webview toolbar UI

WP10: Resize handling                           [WP6, WP8]       ~2 days
  - ResizeObserver in webview
  - Resize message to R
  - Replay at new dimensions

WP11: MVP integration testing                   [WP6-WP10]       ~3 days
  - End-to-end: R plot → socket → webview → visible canvas
  - All Phase 1 acceptance tests
  - CI setup (R CMD check + extension tests)

--- MVP complete (WP1-WP11, ~4 weeks) ---

WP12: Path callback                             [WP4]            ~2 days
WP13: Raster callback + PNG encoder             [WP4]            ~3 days
WP14: Sync text metrics round-trip              [WP5, WP7]       ~3 days
WP15: R-side resize (GEplayDisplayList)         [WP10]           ~2 days
WP16: PNG export                                [WP8]            ~1 day
WP17: SVG renderer + export                     [WP8]            ~3 days
WP18: PDF export                                [WP17]           ~2 days
WP19: Windows support                           [WP3]            ~3 days
WP20: Phase 2 integration testing               [WP12-WP19]      ~3 days

--- Phase 2 complete (WP12-WP20, ~6 weeks after MVP) ---

WP21: R 4.1+ callbacks (patterns, clips, masks) [WP4]            ~4 days
WP22: R 4.2+ callbacks (stroke/fill/fillStroke)  [WP4]           ~2 days
WP23: R 4.3+ glyph callback                     [WP4]            ~2 days
WP24: Compositing groups                         [WP21]          ~3 days
WP25: Locator callback                           [WP8]           ~2 days
WP26: Zoom/pan                                   [WP8]           ~2 days
WP27: Performance optimization                   [WP20]          ~4 days
WP28: Phase 3 integration + visual regression    [WP21-WP27]     ~3 days

--- Phase 3 complete (WP21-WP28, ~6 weeks after Phase 2) ---
```

### Acceptance plots (15)

| # | Script | Features tested |
|---|---|---|
| 1 | `01-scatter.R` | `plot(rnorm(500), rnorm(500), col=rainbow(500), pch=16)` — points, colors, alpha |
| 2 | `02-histogram.R` | `hist(rnorm(10000), breaks=50, col="steelblue")` — rect fill, axis labels, title |
| 3 | `03-barplot.R` | `barplot(VADeaths, beside=TRUE, legend=TRUE)` — grouped bars, legend, text |
| 4 | `04-text-rotation.R` | `text(x, y, labels, srt=seq(0,360,by=30))` — text at multiple rotation angles |
| 5 | `05-clipping.R` | `par(mfrow=c(2,2)); plot(...)` × 4 — multi-panel with per-panel clipping |
| 6 | `06-raster.R` | `image(volcano, col=terrain.colors(100))` — raster image with color ramp |
| 7 | `07-alpha.R` | Overlapping semi-transparent polygons — alpha compositing correctness |
| 8 | `08-ggplot-facets.R` | `ggplot(mpg, aes(displ,hwy)) + geom_point() + facet_wrap(~class)` — grid clipping, multiple panels |
| 9 | `09-line-types.R` | All 6 standard R line types (`lty=1:6`) at multiple widths — dash patterns, line caps |
| 10 | `10-path-winding.R` | `polypath()` with hole (even-odd rule) — path winding, sub-paths |
| 11 | `11-ggplot-complex.R` | `ggplot(diamonds, aes(carat,price,color=cut)) + geom_point(alpha=0.3) + theme_minimal()` — large dataset, alpha, legend, theme |
| 12 | `12-base-legend.R` | `plot(...); legend("topright", ...)` with lines, points, fill boxes — legend layout depends on `strWidth` accuracy |
| 13 | `13-lattice-panel.R` | `lattice::xyplot(y ~ x | group)` — lattice panel layout, strip labels |
| 14 | `14-math-expression.R` | `plot(1, main=expression(hat(beta)[1] == frac(sum(x[i]*y[i]), sum(x[i]^2))))` — plotmath expressions |
| 15 | `15-large-scatter.R` | `plot(rnorm(1e5), rnorm(1e5), pch=".")` — 100k points, performance benchmark |
