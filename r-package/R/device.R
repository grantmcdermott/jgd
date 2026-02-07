#' VS Code Graphics Device
#'
#' Opens a graphics device that streams plot operations to a VS Code extension
#' for rendering in a webview panel.
#'
#' @param width Device width in inches (default 7).
#' @param height Device height in inches (default 7).
#' @param dpi Resolution in dots per inch (default 96).
#' @return Invisible NULL. The device is opened as a side effect.
#' @export
vscgd <- function(width = 8, height = 6, dpi = 96) {
  invisible(.Call(C_vscgd, as.double(width), as.double(height), as.double(dpi)))
}
