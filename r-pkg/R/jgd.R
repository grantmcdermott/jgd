#' JSON Graphics Device
#'
#' Opens a graphics device that streams plot operations as JSON to an external
#' renderer (e.g. VS Code extension or browser) over a Unix domain socket.
#'
#' @param width Device width in inches (default 8).
#' @param height Device height in inches (default 6).
#' @param dpi Resolution in dots per inch (default 96).
#' @param socket Socket address for the rendering server. Supports URI formats
#'   (`tcp://host:port`, `unix:///path/to/socket`) or raw Unix socket paths.
#'   If `NULL` (default), use the `jgd.socket` R option, falling back to the
#'  `JGD_SOCKET`environment variable. If `JGD_SOCKET` environment variable is
#'  also unset, the device discovers the socket via the discovery file.
#' @section Displaying plots with `jgd`:
#' It is important to note that `jgd()` does not display any plots; it only
#' streams them (i.e., converts them to a format that a JSON renderer
#' understands). To actually _display_ your plots with `jgd`, you'll need an
#' appropriate frontend. We provide two official renderers, both available for
#' install from the project repository:
#' \url{https://github.com/grantmcdermott/jgd}.
#'
#' - **VS Code extension.** An integrated plot pane for VS Code.
#' - **Deno server.** A standalone browser-based renderer.
#'
#' Users aren't limited to these two options. The `jgd` protocol is deliberately
#' frontend-agnostic; you can render plots with any client that reads JSON.
#' Again, please see the project repository for full documentation:
#' \url{https://github.com/grantmcdermott/jgd}
#' 
#' @section Debugging:
#' Set `options(jgd.debug = TRUE)` before opening the device to enable
#' frame-level diagnostic output on stderr (via `REprintf`).  This logs
#' details about `newPage`, `flush_frame`, and `poll_resize` events, which
#' is useful for diagnosing resize/replay issues.
#' @return Invisible `NULL`. The device is opened as a side effect.
#' @examples
#' \dontrun{
#' # Requires a running renderer (e.g., VS Code extension or Deno server).
#' # See the "Displaying plots" section above.
#' library(jgd)
#' jgd()
#' plot(1:10)
#' lines(1:10, col = "red", lwd = 3)
#' hist(rnorm(1000), col = "steelblue")
#' dev.off()
#' }
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
#' Returns metadata about the jgd server. When a jgd device is open
#' and connected, returns the welcome message information with
#' `connected = TRUE`. Otherwise, falls back to reading the
#' discovery file and returns information with `connected = FALSE`.
#' Returns `NULL` if no information is available from either source.
#'
#' The discovery fallback applies regardless of whether the current
#' device is a jgd device. This means `jgd_server_info()` can
#' return a non-`NULL` result even when no jgd device is open, as
#' long as a valid discovery file exists.
#'
#' @return A named list, or `NULL`.
#'
#'   When connected:
#'
#'   - **`connected`**: `TRUE`
#'   - **`server_name`**: Server name (character)
#'   - **`protocol_version`**: Protocol version (integer)
#'   - **`transport`**: Transport protocol (character)
#'   - **`server_info`**: Named character vector of key-value pairs
#'     from the server's `serverInfo` object
#'     (e.g. `c(httpUrl = "http://...")`); empty if absent
#'
#'   When not connected (discovery file fallback):
#'
#'   - **`connected`**: `FALSE`
#'   - **`server_name`**: Server name (character)
#'   - **`socket_path`**: Socket URI (character)
#'   - **`pid`**: Server process ID (integer)
#'   - **`server_info`**: Named character vector (as above)
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
    base = Sys.getenv("USERPROFILE", unset = "")
    if (nzchar(base)) return(file.path(base, "AppData", "Local", "jgd"))
    stop("Cannot determine cache directory: LOCALAPPDATA and USERPROFILE are both unset")
  }
  home = normalizePath("~", mustWork = FALSE)
  if (!nzchar(home) || identical(home, "~")) {
    stop("Cannot determine cache directory: HOME is unset")
  }
  if (Sys.info()[["sysname"]] == "Darwin") {
    # On macOS, always use ~/Library/Caches/jgd to match server and tooling.
    return(file.path(home, "Library", "Caches", "jgd"))
  }
  xdg = Sys.getenv("XDG_CACHE_HOME", unset = "")
  if (nzchar(xdg)) return(file.path(xdg, "jgd"))
  file.path(home, ".cache", "jgd")
}

#' Discover a running jgd server
#'
#' Reads the jgd discovery file from the platform cache directory
#' (`~/.cache/jgd` on Linux, `~/Library/Caches/jgd` on macOS,
#' `%LOCALAPPDATA%/jgd` on Windows) and returns its contents.
#' This does not require an open jgd device — it simply reads the
#' file that a running server has written.
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

#' Set frame-level extension fields (experimental)
#'
#' Sets extension fields that are included once per frame in the JSON protocol
#' (at the top level of the frame message, not per drawing operation).  This is
#' useful for frame-wide properties such as post-processing effects.
#'
#' @param json A single JSON string representing the extension object, or
#'   `NULL` or `""` to clear.  Non-empty strings must be valid JSON; an error
#'   is raised otherwise.
#' @return Called for its side effect; returns `NULL` invisibly.
#' @section Lifecycle:
#' **Experimental.** This API may change in future versions.
#' @export
jgd_frame_ext = function(json = NULL) {
  if (!is.null(json)) {
    stopifnot(is.character(json), length(json) == 1L)
  }
  result = .Call(C_jgd_set_frame_ext, json)
  if (is.character(result))
    stop(result, call. = FALSE)
  invisible()
}

#' Scoped frame-level extension fields (experimental)
#'
#' Temporarily sets frame-level extension fields for the duration of `expr`,
#' then clears them on exit.
#'
#' @param json A single JSON string representing the extension object.
#' @param expr Expression to evaluate with the frame extension active.
#' @return The result of evaluating `expr`.
#' @section Lifecycle:
#' **Experimental.** This API may change in future versions.
#' @export
with_jgd_frame_ext = function(json, expr) {
  stopifnot(is.character(json), length(json) == 1L)
  jgd_frame_ext(json)
  on.exit(jgd_frame_ext(NULL), add = TRUE)
  expr
}

#' Begin a drawing group (experimental)
#'
#' Emits a `beginGroup` operation into the drawing stream.  All subsequent
#' drawing operations until the matching [jgd_end_group()] are part of this
#' group.  The renderer may use the group's extension fields to apply effects
#' to the group as a whole.
#'
#' @param ext A single JSON string with extension fields for this group, or
#'   `NULL` for a group without extension fields.
#' @return Called for its side effect; returns `NULL` invisibly.
#' @section Lifecycle:
#' **Experimental.** This API may change in future versions.
#' @export
jgd_begin_group = function(ext = NULL) {
  if (!is.null(ext)) {
    stopifnot(is.character(ext), length(ext) == 1L)
  }
  # Unlike gc.ext (jgd_ext), which is device state embedded into every
  # drawing op by the C callbacks, group ops are standalone markers in the
  # ops stream that are not produced by any R graphics engine callback.
  # We use recordGraphics() so the .Call is recorded in R's display list
  # and replayed on resize.  recordGraphics() also executes immediately.
  recordGraphics(
    {
      result = .Call(C_jgd_begin_group, ext)
      if (is.character(result))
        stop(result, call. = FALSE)
    },
    list(ext = ext),
    env = getNamespace("jgd")
  )
  invisible()
}

#' End a drawing group (experimental)
#'
#' Emits an `endGroup` operation into the drawing stream, closing the most
#' recently opened group from [jgd_begin_group()].
#'
#' @return Called for its side effect; returns `NULL` invisibly.
#' @section Lifecycle:
#' **Experimental.** This API may change in future versions.
#' @export
jgd_end_group = function() {
  # See jgd_begin_group for why recordGraphics is used here.
  recordGraphics(
    .Call(C_jgd_end_group),
    list(),
    env = getNamespace("jgd")
  )
  # Update the snapshot after recordGraphics has added the endGroup entry
  # to the display list.  Without this, the snapshot (captured by cb_mode(0)
  # during the last drawing primitive) would not include the endGroup,
  # causing blank plots on plotIndex resize replay.
  .Call(C_jgd_update_snapshot)
  invisible()
}

#' Scoped drawing group (experimental)
#'
#' Opens a drawing group with extension fields, evaluates `expr`, then closes
#' the group on exit.
#'
#' @param ext A single JSON string with extension fields for this group, or
#'   `NULL` for a group without extension fields.
#' @param expr Expression to evaluate within the group.
#' @return The result of evaluating `expr`.
#' @section Lifecycle:
#' **Experimental.** This API may change in future versions.
#' @export
with_jgd_group = function(ext, expr) {
  jgd_begin_group(ext)
  on.exit({
    tryCatch(
      jgd_end_group(),
      error = function(e) {
        # If the device auto-closed the group at a page boundary
        # (cb_newPage resets group_depth), the cleanup endGroup would
        # fail with "endGroup without matching beginGroup".  Suppress
        # that specific error so the original error (if any) propagates.
        if (!grepl("endGroup without matching beginGroup", conditionMessage(e), fixed = TRUE))
          stop(e)
      }
    )
  }, add = TRUE)
  expr
}
