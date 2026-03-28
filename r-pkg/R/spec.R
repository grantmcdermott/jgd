#' jgd NDJSON Protocol Specification
#'
#' @description
#' The jgd device communicates with a rendering server over NDJSON
#' (newline-delimited JSON). Messages are exchanged over a persistent
#' connection using one of three transport protocols: Unix domain sockets
#' (Linux/macOS), Windows named pipes, or TCP.
#'
#' This document specifies the wire protocol so that third-party servers
#' can implement a compatible rendering backend.
#'
#' @section Transport protocols:
#'
#' The R client connects to the server using one of the following URI schemes:
#'
#' - `unix:///path/to/socket` -- Unix domain socket (Linux/macOS default)
#' - `npipe:////./pipe/name` -- Windows named pipe (Windows default,
#'   Docker-standard 4-slash form)
#' - `tcp://host:port` -- TCP socket (any platform)
#'
#' Raw Unix socket paths (without a URI scheme) are also accepted.
#'
#' @section Message format:
#'
#' All messages are single-line JSON objects terminated by `\n` (NDJSON).
#' Each message contains a `"type"` field identifying the message kind.
#' Encoding is always UTF-8.
#'
#' @section Connection handshake:
#'
#' The welcome message is **deferred**: the server waits until it receives
#' the first message from R before sending it. This avoids a race condition
#' on Windows named pipes where writing before the first read completes can
#' cause data loss.
#'
#' ```
#' R -> Server:  {"type":"ping"}
#' Server -> R:  {"type":"server_info", ...}
#' ```
#'
#' The R client reads up to 3 lines with a 200 ms timeout per read to
#' account for potential message reordering. Non-`server_info` messages
#' received during handshake are silently discarded.
#'
#' If the server does not send a welcome within the timeout, the device
#' operates normally without server metadata. [jgd_server_info()] returns
#' `NULL` in this case.
#'
#' @section Discovery file:
#'
#' The discovery file is an **optional** JSON file that allows the R client
#' to find the server without an explicit socket address. It is a hint for
#' auto-connection only; the welcome message is the single source of truth.
#'
#' **Location** (platform-specific):
#'
#' - Linux: `$XDG_CACHE_HOME/jgd/discovery.json`
#'   or `~/.cache/jgd/discovery.json`
#' - macOS: `~/Library/Caches/jgd/discovery.json`
#' - Windows: `%LOCALAPPDATA%/jgd/discovery.json`
#'
#' **Schema:**
#'
#' ```json
#' {
#'   "serverName": "jgd-http-server",
#'   "socketPath": "tcp://127.0.0.1:9000",
#'   "pid": 12345,
#'   "serverInfo": {
#'     "httpUrl": "http://127.0.0.1:8080/"
#'   }
#' }
#' ```
#'
#' - **`serverName`** (string, required): Human-readable server name.
#' - **`socketPath`** (string, required): Socket URI where R should connect.
#' - **`pid`** (integer, required): Process ID of the server.
#' - **`serverInfo`** (object, optional): Flat key-value pairs with string
#'   values. Canonical key: `httpUrl` (HTTP endpoint URL).
#'
#' **Lifecycle:**
#'
#' - Written atomically (temp file + rename) after all listeners are ready.
#' - Server should remove the file on graceful shutdown, but only after
#'   confirming it still owns the file (PID check).
#' - Clients should verify liveness (e.g., PID check) before using stale
#'   files, since `~/.cache` is not cleared on reboot.
#' - Multiple server instances may coexist; the last writer wins.
#' - Server implementors may omit discovery file support entirely.
#'   Clients can always connect directly via `jgd(socket = "<uri>")`.
#'
#' @section server_info message:
#'
#' ```json
#' {
#'   "type": "server_info",
#'   "serverName": "jgd-http-server",
#'   "protocolVersion": 1,
#'   "transport": "unix",
#'   "serverInfo": {
#'     "httpUrl": "http://127.0.0.1:8080/"
#'   }
#' }
#' ```
#'
#' - **`type`**: `"server_info"` (string, always present)
#' - **`serverName`**: Human-readable server name (string)
#' - **`protocolVersion`**: Protocol version number, currently `1` (integer)
#' - **`transport`**: Transport in use: `"tcp"`, `"unix"`, or `"npipe"`
#'   (string)
#' - **`serverInfo`**: A flat JSON object whose values are all strings
#'   (optional). Canonical key: `httpUrl`.
#'
#' @section R-side representation:
#'
#' [jgd_server_info()] returns a named list with four elements, or `NULL`
#' if no welcome was received:
#'
#' - **`server_name`**: The server name (character scalar)
#' - **`protocol_version`**: The protocol version (integer scalar)
#' - **`transport`**: The transport protocol (character scalar)
#' - **`server_info`**: A named character vector of key-value pairs from the
#'   `serverInfo` object (e.g. `c(httpUrl = "http://...")`)
#'
#' `jgd_server_info()` returns `NULL` when:
#'
#' - The current device is not a jgd device
#' - The server did not send a welcome within the timeout
#' - The device was not connected at open time
#'
#' @section R-to-server messages:
#'
#' **ping** -- Heartbeat; triggers the deferred welcome on first send.
#'
#' ```json
#' {"type": "ping"}
#' ```
#'
#' **frame** -- A complete or incremental set of drawing operations.
#' See the \dQuote{Frame message} section for the full schema.
#'
#' **metrics_request** -- Requests font metrics from the browser.
#'
#' ```json
#' {"type": "metrics_request", "id": 1, "kind": "strWidth",
#'  "str": "Hello", "family": "sans", "face": 1, "size": 12, "cex": 1}
#' ```
#'
#' ```json
#' {"type": "metrics_request", "id": 2, "kind": "metricInfo",
#'  "c": 77, "family": "sans", "face": 1, "size": 12, "cex": 1}
#' ```
#'
#' - **`id`**: Request identifier (integer); the response must echo it.
#' - **`kind`**: `"strWidth"` (string width) or `"metricInfo"` (glyph metrics).
#'
#' **close** -- Signals that `dev.off()` was called.
#'
#' ```json
#' {"type": "close"}
#' ```
#'
#' @section Server-to-R messages:
#'
#' **server_info** -- Welcome message (see above).
#'
#' **resize** -- Browser viewport change.
#'
#' ```json
#' {"type": "resize", "width": 800, "height": 600}
#' ```
#'
#' - **`width`**, **`height`**: New viewport dimensions in CSS pixels
#'   (positive integers).
#' - **`plotIndex`** (integer, optional): If present, replay the historical
#'   plot at this 0-based index instead of the current plot.
#'
#' **metrics_response** -- Font metrics from the browser.
#'
#' ```json
#' {"type": "metrics_response", "id": 1, "width": 48.5,
#'  "ascent": 10.2, "descent": 2.8}
#' ```
#'
#' - **`id`**: Must match the request `id`.
#' - Server should apply a 2-second timeout and send a zero-value fallback
#'   (`width: 0, ascent: 0, descent: 0`) if no response arrives.
#'
#' @section Frame message:
#'
#' The frame message carries drawing operations from R to the server.
#'
#' ```json
#' {
#'   "type": "frame",
#'   "incremental": false,
#'   "newPage": true,
#'   "resizeReplay": false,
#'   "plotIndex": 0,
#'   "plotNumber": 0,
#'   "ext": {},
#'   "plot": {
#'     "version": 1,
#'     "sessionId": "R-12345",
#'     "device": {
#'       "width": 768,
#'       "height": 576,
#'       "dpi": 96,
#'       "bg": "rgba(255,255,255,1)"
#'     },
#'     "ops": []
#'   }
#' }
#' ```
#'
#' **Top-level fields:**
#'
#' - **`type`**: `"frame"` (always present).
#' - **`incremental`** (boolean, always present): If `true`, `ops` contains
#'   only operations added since the last flush (delta). If `false`, `ops`
#'   contains the complete drawing for the page.
#' - **`newPage`** (boolean, optional): Present and `true` when this is a
#'   fresh plot (not a delta, not a resize replay).
#' - **`resizeReplay`** (boolean, optional): Present and `true` when this
#'   frame is a replay of a display list triggered by a resize.
#' - **`plotIndex`** (integer, optional): Present during `resizeReplay`
#'   when a historical plot (not the current one) was replayed.
#'   0-based index into the plot history.
#' - **`plotNumber`** (integer, optional): Absolute 0-based sequence number
#'   for new plots (e.g., 0 for the first plot, 1 for the second).
#'   Absent during resize replays.
#' - **`ext`** (object, optional): Frame-level extension data set via
#'   [jgd_frame_ext()]. Free-form JSON; servers should preserve and forward
#'   it to renderers.
#'
#' **plot object:**
#'
#' - **`version`** (integer): Protocol version, currently `1`.
#' - **`sessionId`** (string): Identifies the R session/device. Used for
#'   routing resize requests to the correct R process.
#' - **`device`** (object):
#'   - **`width`**, **`height`**: Device dimensions in pixels.
#'   - **`dpi`**: Dots per inch.
#'   - **`bg`**: Background color as an RGBA string (see \dQuote{Color format}).
#' - **`ops`** (array): Drawing operations (see \dQuote{Drawing operations}).
#'
#' @section Color format:
#'
#' Colors are represented as CSS-style RGBA strings:
#'
#' ```
#' "rgba(R,G,B,A)"
#' ```
#'
#' - R, G, B: integers 0--255.
#' - A: decimal 0.0--1.0 (e.g., `"rgba(0,0,0,0.502)"`).
#'
#' Transparent or `NA` colors are represented as JSON `null`.
#'
#' @section Graphics context:
#'
#' Drawing operations that produce visible output include a `"gc"` object:
#'
#' ```json
#' {
#'   "col": "rgba(0,0,0,1)",
#'   "fill": null,
#'   "lwd": 1.0,
#'   "lty": [],
#'   "lend": "round",
#'   "ljoin": "round",
#'   "lmitre": 10.0,
#'   "font": {
#'     "family": "sans",
#'     "face": 1,
#'     "size": 12.0,
#'     "lineheight": 1.2
#'   },
#'   "ext": {}
#' }
#' ```
#'
#' - **`col`**: Stroke color (RGBA string or `null`).
#' - **`fill`**: Fill color (RGBA string or `null`).
#' - **`lwd`**: Line width in pixels (number).
#' - **`lty`**: Line type as an array of dash lengths. Solid lines produce
#'   an empty array `[]`. Each element is the product of a dash nibble and
#'   `lwd`.
#' - **`lend`**: Line end cap style: `"round"`, `"butt"`, or `"square"`.
#' - **`ljoin`**: Line join style: `"round"`, `"miter"`, or `"bevel"`.
#' - **`lmitre`**: Miter limit (number).
#' - **`font`**:
#'   - **`family`**: Font family name (string; empty string if default).
#'   - **`face`**: Font face: 1 = plain, 2 = bold, 3 = italic,
#'     4 = bold italic, 5 = symbol.
#'   - **`size`**: Computed font size in points (`cex * ps`).
#'   - **`lineheight`**: Line height multiplier (number).
#' - **`ext`** (object, optional): Per-operation extension data set via
#'   [jgd_ext()]. Free-form JSON.
#'
#' @section Drawing operations:
#'
#' Each element of the `ops` array is a JSON object with an `"op"` field.
#' Most drawing operations include a `"gc"` field (see
#' \dQuote{Graphics context}). Exceptions are noted per operation.
#'
#' **clip** -- Set the clipping rectangle. No `gc`.
#'
#' ```json
#' {"op": "clip", "x0": 0, "y0": 0, "x1": 768, "y1": 576}
#' ```
#'
#' **line** -- A single line segment.
#'
#' ```json
#' {"op": "line", "x1": 100, "y1": 200, "x2": 300, "y2": 400, "gc": {}}
#' ```
#'
#' **polyline** -- Connected line segments (not closed).
#'
#' ```json
#' {"op": "polyline", "x": [1, 2, 3], "y": [4, 5, 6], "gc": {}}
#' ```
#'
#' **polygon** -- Closed polygon (filled and/or stroked).
#'
#' ```json
#' {"op": "polygon", "x": [1, 2, 3], "y": [4, 5, 6], "gc": {}}
#' ```
#'
#' **rect** -- Rectangle.
#'
#' ```json
#' {"op": "rect", "x0": 10, "y0": 20, "x1": 100, "y1": 80, "gc": {}}
#' ```
#'
#' **circle** -- Circle.
#'
#' ```json
#' {"op": "circle", "x": 50, "y": 50, "r": 25, "gc": {}}
#' ```
#'
#' **text** -- Text string.
#'
#' ```json
#' {"op": "text", "x": 100, "y": 200, "str": "Hello",
#'  "rot": 0, "hadj": 0.5, "gc": {}}
#' ```
#'
#' - **`rot`**: Rotation angle in degrees (counter-clockwise).
#' - **`hadj`**: Horizontal adjustment (0 = left-aligned, 0.5 = centered,
#'   1 = right-aligned).
#'
#' **path** -- Complex path with subpaths and a fill rule.
#'
#' ```json
#' {"op": "path", "winding": "nonzero",
#'  "subpaths": [[[10, 20], [30, 40], [50, 20]]], "gc": {}}
#' ```
#'
#' - **`winding`**: Fill rule: `"nonzero"` or `"evenodd"`.
#' - **`subpaths`**: Array of subpaths. Each subpath is an array of
#'   `[x, y]` coordinate pairs.
#'
#' **raster** -- Raster image. No `gc`.
#'
#' ```json
#' {"op": "raster", "x": 0, "y": 0, "w": 100, "h": 80,
#'  "rot": 0, "interpolate": true,
#'  "pw": 200, "ph": 160, "data": "data:image/png;base64,..."}
#' ```
#'
#' - **`w`**, **`h`**: Displayed width and height in device coordinates.
#' - **`pw`**, **`ph`**: Pixel width and height of the source image.
#' - **`rot`**: Rotation angle in degrees.
#' - **`interpolate`**: Whether to interpolate when scaling.
#' - **`data`**: Base64-encoded PNG as a data URI.
#'
#' **beginGroup** -- Start a drawing group (experimental). No `gc`.
#'
#' ```json
#' {"op": "beginGroup", "ext": {"filter": "blur(5px)", "opacity": 0.8}}
#' ```
#'
#' - **`ext`** (object, optional): Group-level extension data passed via
#'   [jgd_begin_group()]. Free-form JSON. Common keys: `filter` (CSS filter
#'   string), `opacity` (number 0--1), `blendMode` (CSS blend mode string).
#'
#' **endGroup** -- End the most recently opened group. No `gc`, no fields
#' other than `"op"`.
#'
#' ```json
#' {"op": "endGroup"}
#' ```
#'
#' Groups nest arbitrarily. An `endGroup` triggers an immediate incremental
#' frame flush (even when the device is held via `dev.hold()`).
#'
#' @section Resize protocol:
#'
#' The server receives resize messages from the browser and forwards them
#' to R. R replays the display list at the new dimensions and sends back
#' a frame message.
#'
#' **Normal resize flow:**
#'
#' ```
#' Browser -> Server:  {"type":"resize","width":800,"height":600}
#' Server  -> R:       {"type":"resize","width":800,"height":600}
#' R       -> Server:  {"type":"frame","resizeReplay":true,
#'                      "incremental":false,...}
#' ```
#'
#' **History resize flow** (replay a historical plot):
#'
#' ```
#' Browser -> Server:  {"type":"resize","width":800,"height":600,
#'                      "plotIndex":2,"sessionId":"R-12345"}
#' Server  -> R:       {"type":"resize","width":800,"height":600,"plotIndex":2}
#' R       -> Server:  {"type":"frame","resizeReplay":true,"plotIndex":2,
#'                      "incremental":false,...}
#' ```
#'
#' Note: The server strips `sessionId` before forwarding to R. History
#' resizes are routed only to the R session that owns the target plot.
#'
#' **Resize deduplication:**
#'
#' Servers should deduplicate consecutive normal resizes with identical
#' dimensions for each R session. However, if the previous resize was a
#' `plotIndex` resize, the next normal resize at the same dimensions must
#' NOT be deduplicated, because they target different display lists
#' (historical snapshot vs. current plot).
#'
#' @section Session ID management:
#'
#' The `sessionId` in frame messages identifies the R process/device.
#' R typically derives it from its PID (e.g., `"R-12345"`).
#'
#' When the same R process opens a new device after closing the previous
#' one, the server may see the same `sessionId` reused. Servers should
#' disambiguate by appending a suffix (e.g., `"R-12345:1"`) to keep plot
#' histories separate. The server's remapped `sessionId` is what the
#' browser sees; `plotIndex` resizes use it for routing.
#'
#' @section Extension fields:
#'
#' Extension fields (`ext`) appear at three levels:
#'
#' - **Frame-level**: Top-level `ext` on the frame message. Set via
#'   [jgd_frame_ext()] in R. Applies to the entire frame.
#' - **Graphics context level**: `ext` inside the `gc` object. Set via
#'   [jgd_ext()] in R. Applies to all drawing operations while active.
#' - **Group level**: `ext` on `beginGroup` operations. Passed via
#'   [jgd_begin_group()] in R. Applies only to that group.
#'
#' All `ext` fields are free-form JSON objects. Servers should preserve
#' and forward them to renderers without validation. Renderers should
#' ignore unknown keys.
#'
#' Extension fields survive display list replays (resize), so historical
#' plot snapshots retain their `ext` data.
#'
#' @section Implementing a server:
#'
#' A minimal server implementation needs to:
#'
#' 1. Listen on a Unix socket, named pipe, or TCP port.
#' 2. Accept R connections and read NDJSON lines.
#' 3. Send a deferred `server_info` welcome after receiving the first
#'    message from R (not before).
#' 4. Forward `frame` messages to connected browsers/renderers.
#' 5. Forward `resize` messages from browsers to R.
#' 6. Handle `metrics_request`/`metrics_response` routing between R and
#'    browser, with a 2-second timeout and zero-value fallback.
#' 7. Forward `close` messages to browsers.
#'
#' Optional:
#'
#' - Write a discovery file on startup, remove on shutdown.
#' - Implement resize deduplication.
#' - Implement session ID remapping for reused IDs.
#' - Serve an HTTP endpoint for the browser UI.
#'
#' @name jgd-spec
#' @aliases jgd-protocol
#' @seealso [jgd()], [jgd_server_info()], [jgd_ext()], [jgd_frame_ext()],
#'   [jgd_begin_group()]
NULL
