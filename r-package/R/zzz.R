.onLoad <- function(libname, pkgname) {
  # Default options
  op <- options()
  defaults <- list(
    vscgd.socket = NULL
  )
  toset <- !(names(defaults) %in% names(op))
  if (any(toset)) options(defaults[toset])
  invisible()
}
