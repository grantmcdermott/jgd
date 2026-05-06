#' @description
#' A lightweight (C-based, zero dependency) R graphics device that serializes
#' plotting operations into JSON and streams them to an external renderer.
#' See [jgd()] to open the device and [`jgd_spec`] for the wire protocol
#' specification.
#' @keywords internal
"_PACKAGE"

## usethis namespace: start
#' @useDynLib jgd, .registration = TRUE
#' @importFrom grDevices recordGraphics
## usethis namespace: end
NULL
