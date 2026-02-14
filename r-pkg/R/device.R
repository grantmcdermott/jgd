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

  if (requireNamespace("later", quietly = TRUE)) {
    poll = function() {
      tryCatch(.Call(C_jgd_poll_resize), error = function(e) NULL)
      later::later(poll, 0.2)
    }
    later::later(poll, 0.2)
  } else {
    addTaskCallback(jgd_resize_callback, name = "jgd_resize")
  }

  invisible()
}

jgd_resize_callback = function(...) {
  tryCatch(.Call(C_jgd_poll_resize), error = function(e) NULL)
  TRUE
}
