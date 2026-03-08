# Open a jgd device without a server (connection fails with warning, but
# the device itself is usable for testing jgd_ext).
open_jgd <- function() {
  suppressWarnings(jgd(socket = "tcp://127.0.0.1:1"))
}

test_that("jgd_ext accepts a JSON string", {
  open_jgd()
  on.exit(dev.off(), add = TRUE)

  expect_invisible(jgd_ext('{"blendMode":"multiply"}'))
})

test_that("jgd_ext(NULL) clears the extension", {
  open_jgd()
  on.exit(dev.off(), add = TRUE)

  jgd_ext('{"opacity":0.5}')
  expect_invisible(jgd_ext(NULL))
})

test_that("jgd_ext rejects non-string input", {
  open_jgd()
  on.exit({ graphics.off() }, add = TRUE)

  expect_error(jgd_ext(42))
  expect_error(jgd_ext(list(a = 1)))
  expect_error(jgd_ext(TRUE))
})

test_that("jgd_ext rejects invalid JSON", {
  open_jgd()
  on.exit({ graphics.off() }, add = TRUE)

  # expect_snapshot cannot be used here: testthat evaluates snapshot
  # code in a context where the current graphics device is not visible,
  # so jgd_ext fails with "not a jgd device" instead of the JSON error.
  expect_error(jgd_ext("not valid json"), "invalid JSON")
  expect_error(jgd_ext("{unclosed"), "invalid JSON")
  # Empty string is treated as clearing (same as NULL)
  expect_invisible(jgd_ext(""))
})

test_that("jgd_ext errors when no jgd device is active", {
  # Close all graphics devices to ensure no jgd device is current
  graphics.off()
  expect_error(jgd_ext('{"opacity":0.5}'))
})

test_that("with_jgd_ext rejects non-string input", {
  open_jgd()
  on.exit({ graphics.off() }, add = TRUE)

  expect_error(with_jgd_ext(42, plot(1)))
  expect_error(with_jgd_ext(NULL, plot(1)))
  expect_error(with_jgd_ext(list(a = 1), plot(1)))
})

test_that("with_jgd_ext rejects invalid JSON", {
  open_jgd()
  on.exit({ graphics.off() }, add = TRUE)

  expect_error(with_jgd_ext("not valid json", 1), "invalid JSON")
  expect_error(with_jgd_ext("{unclosed", 1), "invalid JSON")
})

test_that("with_jgd_ext restores NULL on exit", {
  open_jgd()
  on.exit(dev.off(), add = TRUE)

  # After with_jgd_ext, ext should be cleared (NULL).
  # We can't directly read ext_json from C, but we can verify
  # that the function runs without error and returns the expr result.
  result <- with_jgd_ext('{"blendMode":"screen"}', {
    42L
  })
  expect_equal(result, 42L)
})

test_that("with_jgd_ext restores on error", {
  open_jgd()
  on.exit(dev.off(), add = TRUE)

  expect_error(
    with_jgd_ext('{"opacity":0.3}', stop("test error")),
    "test error"
  )
  # If restoration failed, subsequent jgd_ext(NULL) would crash or behave oddly
  expect_invisible(jgd_ext(NULL))
})
