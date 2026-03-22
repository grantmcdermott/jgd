#' JSON Graphics Device
#'
#' Opens a graphics device that streams plot operations as JSON to an external
#' renderer (e.g. a VS Code extension) over a Unix domain socket.
#'
#' @param width Device width in inches (default 8).
#' @param height Device height in inches (default 6).
#' @param dpi Resolution in dots per inch (default 96).
#' @param socket Socket address for the rendering server. Supports URI formats
#'   (`tcp://host:port`, `unix:///path/to/socket`) or raw Unix socket paths.
#'   If `NULL` (default), use the `jgd.socket` R option, falling back to the `JGD_SOCKET`
#'   environment variable. If `JGD_SOCKET` environment variable is also unset,
#'   the device discovers the socket via the discovery file.
#' @section Debugging:
#' Set `options(jgd.debug = TRUE)` before opening the device to enable
#' frame-level diagnostic output on stderr (via `REprintf`).  This logs
#' details about `newPage`, `flush_frame`, and `poll_resize` events, which
#' is useful for diagnosing resize/replay issues.
#' @return Invisible `NULL`. The device is opened as a side effect.
#' @export
jgd = function(
  width = 8,
  height = 6,
  dpi = 96,
  socket = NULL
) {
  if (is.null(socket)) {
    socket = getOption("jgd.socket", default = {
      jgd_socket_env = Sys.getenv("JGD_SOCKET", unset = "")
      if (nzchar(jgd_socket_env)) jgd_socket_env else NULL
    })
  } else {
    stopifnot(is.character(socket), length(socket) == 1L)
  }

  .Call(C_jgd, as.double(width), as.double(height), as.double(dpi), socket)
  invisible()
}

#' Get server information
#'
#' Returns metadata about the jgd server. When a jgd device is open and
#' connected, returns the welcome message information with `connected = TRUE`.
#' Otherwise, falls back to reading the discovery file and returns information
#' with `connected = FALSE`. Returns `NULL` if no information is available
#' from either source.
#'
#' @return A named list, or `NULL`. When connected:
#'   `connected` (logical), `server_name` (character),
#'   `protocol_version` (integer), `transport` (character),
#'   `server_info` (named character vector).
#'   When not connected (discovery file):
#'   `connected` (logical), `server_name` (character),
#'   `socket_path` (character), `pid` (integer),
#'   `server_info` (named character vector).
#' @export
jgd_server_info = function() {
  path = file.path(jgd_cache_dir(), "discovery.json")
  .Call(C_jgd_server_info, path)
}

# Return the platform-specific cache directory for jgd.
# - Linux:   $XDG_CACHE_HOME/jgd or ~/.cache/jgd
# - macOS:   ~/Library/Caches/jgd
# - Windows: %LOCALAPPDATA%/jgd
jgd_cache_dir = function() {
  if (.Platform$OS.type == "windows") {
    base = Sys.getenv("LOCALAPPDATA", unset = "")
    if (nzchar(base)) return(file.path(base, "jgd"))
    return(file.path(Sys.getenv("USERPROFILE"), "AppData", "Local", "jgd"))
  }
  if (Sys.info()[["sysname"]] == "Darwin") {
    return(file.path(Sys.getenv("HOME"), "Library", "Caches", "jgd"))
  }
  xdg = Sys.getenv("XDG_CACHE_HOME", unset = "")
  if (nzchar(xdg)) return(file.path(xdg, "jgd"))
  file.path(Sys.getenv("HOME"), ".cache", "jgd")
}

#' Discover a running jgd server
#'
#' Reads the jgd discovery file from the standard cache directory
#' and returns its contents. This does not require an open jgd
#' device — it simply reads the file that a running server has written.
#'
#' @return A named list with `server_name` (character), `socket_path`
#'   (character), `pid` (integer), and `server_info` (named character
#'   vector), or `NULL` if no discovery file is found.
#' @export
jgd_discover = function() {
  path = file.path(jgd_cache_dir(), "discovery.json")
  .Call(C_jgd_discover, path)
}

#' Set extended graphics context (experimental)
#'
#' Sets extension fields that are included in every subsequent drawing
#' operation's graphics context (`gc.ext` in the JSON protocol).  This is
#' an experimental, low-level API for injecting renderer-specific properties
#' (e.g. blend modes, shadows, opacity) that go beyond R's standard graphics
#' parameters.
#'
#' @param json A single JSON string representing the extension object, or
#'   `NULL` to clear.  The string must be valid JSON (validated on the C side
#'   via cJSON); an error is raised otherwise.  Packages built on top of jgd
#'   (using e.g. jsonlite) should provide user-friendly wrappers.
#' @return Called for its side effect; returns `NULL` invisibly.
#' @section Lifecycle:
#' **Experimental.** This API may change in future versions.
#' @export
jgd_ext = function(json = NULL) {
  if (!is.null(json)) {
    stopifnot(is.character(json), length(json) == 1L)
  }
  result = .Call(C_jgd_set_ext, json)
  if (is.character(result))
    stop(result, call. = FALSE)
  invisible()
}

#' Scoped extended graphics context (experimental)
#'
#' Temporarily sets extension fields for the duration of `expr`, then clears
#' ext on exit (sets to `NULL`).
#'
#' @param json A single JSON string representing the extension object.
#'   Must be valid JSON; an error is raised otherwise.  Unlike [jgd_ext()],
#'   `NULL` is not accepted (use `jgd_ext(NULL)` to clear ext explicitly).
#' @param expr Expression to evaluate with the extension active.
#' @return The result of evaluating `expr`.
#' @section Lifecycle:
#' **Experimental.** This API may change in future versions.
#' @export
with_jgd_ext = function(json, expr) {
  stopifnot(is.character(json), length(json) == 1L)
  jgd_ext(json)
  on.exit(jgd_ext(NULL), add = TRUE)
  expr
}
