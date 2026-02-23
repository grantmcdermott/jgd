#' jgd NDJSON Protocol Specification
#'
#' @description
#' The jgd device communicates with a rendering server over NDJSON
#' (newline-delimited JSON). Messages are exchanged over a persistent
#' connection using one of three transport protocols: Unix domain sockets
#' (Linux/macOS), Windows named pipes, or TCP.
#'
#' @section Transport protocols:
#'
#' The R client connects to the server using one of the following URI schemes:
#'
#' - `unix:///path/to/socket` -- Unix domain socket (Linux/macOS default)
#' - `npipe:///pipe/name` -- Windows named pipe (Windows default)
#' - `tcp://host:port` -- TCP socket (any platform)
#'
#' Raw Unix socket paths (without a URI scheme) are also accepted.
#'
#' @section Message format:
#'
#' All messages are single-line JSON objects terminated by `\n`. Each message
#' contains a `"type"` field identifying the message kind. The protocol is
#' symmetric: both R and the server send messages using the same framing.
#'
#' @section Connection handshake (server_info welcome):
#'
#' After a connection is established, the server sends a `server_info` welcome
#' message to the R client. This welcome is **deferred**: the server waits
#' until it receives the first message from R before sending it. This avoids
#' a race condition on Windows named pipes where writing before the first read
#' completes can cause data loss.
#'
#' The R client triggers the welcome by sending a ping message immediately
#' after connecting:
#'
#' ```
#' R -> Server:  {"type":"ping"}
#' Server -> R:  {"type":"server_info","serverName":"jgd-http-server",
#'                "protocolVersion":1,"serverInfo":{"httpUrl":"http://..."}}
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
#' @section server_info message format:
#'
#' The `server_info` message has the following structure:
#'
#' - **`type`**: `"server_info"` (string, always present)
#' - **`serverName`**: Human-readable server name, e.g. `"jgd-http-server"`
#'   (string)
#' - **`protocolVersion`**: Protocol version number, currently `1` (integer)
#' - **`serverInfo`**: A flat JSON object whose values are all strings.
#'   Provides additional server metadata:
#'   - **`httpUrl`**: URL of the server's HTTP endpoint, e.g.
#'     `"http://127.0.0.1:8080/"`
#'   - **`transport`**: Transport protocol in use: `"tcp"`, `"unix"`, or
#'     `"npipe"`
#'
#' Example:
#'
#' ```json
#' {
#'   "type": "server_info",
#'   "serverName": "jgd-http-server",
#'   "protocolVersion": 1,
#'   "serverInfo": {
#'     "httpUrl": "http://127.0.0.1:8080/",
#'     "transport": "unix"
#'   }
#' }
#' ```
#'
#' @section R-side representation:
#'
#' [jgd_server_info()] returns a named list with three elements, or `NULL`
#' if no welcome was received:
#'
#' - **`server_name`**: The server name (character scalar)
#' - **`protocol_version`**: The protocol version (integer scalar)
#' - **`server_info`**: A named character vector of key-value pairs from the
#'   `serverInfo` object (e.g. `c(httpUrl = "http://...", transport = "unix")`)
#'
#' `jgd_server_info()` returns `NULL` when:
#'
#' - The current device is not a jgd device
#' - The server did not send a welcome within the timeout
#' - The device was not connected at open time
#'
#' @section R-to-server message types:
#'
#' - **`ping`**: Heartbeat; triggers the deferred welcome on first send.
#'   `{"type":"ping"}`
#' - **`frame`**: A complete or incremental set of plot operations.
#'   Contains a `plot` object with `sessionId`, `ops` (array of drawing
#'   operations), and `device` (device dimensions in pixels/dpi).
#'   The `incremental` flag distinguishes partial updates from full frames.
#' - **`metrics_request`**: Requests font metrics from the browser.
#'   Contains `id` (integer), `kind` (`"strWidth"` or `"metricInfo"`),
#'   and font/text parameters.
#' - **`close`**: Signals that `dev.off()` was called.
#'   `{"type":"close"}`
#'
#' @section Server-to-R message types:
#'
#' - **`server_info`**: Welcome message (see above).
#' - **`resize`**: Browser viewport change.
#'   `{"type":"resize","width":<px>,"height":<px>}`
#' - **`metrics_response`**: Font metrics from the browser.
#'   `{"type":"metrics_response","id":<int>,"width":<num>,"ascent":<num>,
#'   "descent":<num>}`
#'
# TODO: Document discovery file format (location, content, lifecycle)
# TODO: Document frame message format (plot ops, device dimensions, incremental flag)

#' @name jgd-spec
#' @aliases jgd-protocol
#' @seealso [jgd()], [jgd_server_info()]
NULL
