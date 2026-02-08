#' JSON Graphics Device
#'
#' Opens a graphics device that streams plot operations as JSON to an external
#' renderer (e.g. a VS Code extension) over a Unix domain socket.
#'
#' @param width Device width in inches (default 8).
#' @param height Device height in inches (default 6).
#' @param dpi Resolution in dots per inch (default 96).
#' @return Invisible `NULL`. The device is opened as a side effect.
#' @export
jgd = function(width = 8, height = 6, dpi = 96) {
  .Call(C_jgd, as.double(width), as.double(height), as.double(dpi))

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
