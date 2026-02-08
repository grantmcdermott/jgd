.onLoad = function(libname, pkgname) {
  op = options()
  defaults = list(jgd.socket = NULL)
  toset = !(names(defaults) %in% names(op))
  if (any(toset)) options(defaults[toset])
  invisible()
}
