#' JSON Graphics Device
#'
#' Opens a graphics device that streams plot operations as JSON to an external
#' renderer (e.g. a VS Code extension) over a Unix domain socket.
#'
#' @param width Device width in inches (default 8).
#' @param height Device height in inches (default 6).
#' @param dpi Resolution in dots per inch (default 96).
#' @return Invisible NULL. The device is opened as a side effect.
#' @export
jgd <- function(width = 8, height = 6, dpi = 96) {
  .Call(C_jgd, as.double(width), as.double(height), as.double(dpi))
  addTaskCallback(jgd_resize_callback, name = "jgd_resize")
  invisible()
}

# Task callback: runs after each top-level R expression.
# C_jgd_poll_resize checks for pending resize, applies new dims, and
# calls GEplayDisplayList() if needed. Returns TRUE if a resize occurred.
jgd_resize_callback <- function(...) {
  tryCatch(.Call(C_jgd_poll_resize), error = function(e) NULL)
  TRUE
}
