# --- Unix socket tests (skip on Windows) ---

test_that("Unix: jgd() opens a device and dev.off() closes it", {
  skip_on_os("windows")
  expect_snapshot(jgd(socket = "unix:///nonexistent-jgd-test.sock"))
  expect_identical(names(dev.cur()), "jgd")
  dev.off()
})

test_that("Unix: jgd() respects JGD_SOCKET env var", {
  skip_on_os("windows")
  withr::local_envvar(JGD_SOCKET = "unix:///nonexistent-jgd-env-test.sock")
  expect_snapshot(jgd())
  dev.off()
})

test_that("Unix: jgd() respects jgd.socket option", {
  skip_on_os("windows")
  withr::local_options(jgd.socket = "unix:///nonexistent-jgd-opt-test.sock")
  withr::local_envvar(JGD_SOCKET = NA)
  expect_snapshot(jgd())
  dev.off()
})

test_that("Unix: drawing works without server connection", {
  skip_on_os("windows")
  expect_snapshot(jgd(socket = "unix:///nonexistent-jgd-draw-test.sock"))
  plot.new()
  rect(0, 0, 1, 1)
  text(0.5, 0.5, "test")
  dev.off()
})

# --- Unix socket with localhost authority (skip on Windows) ---

test_that("Unix: unix://localhost/ URI accepted", {
  skip_on_os("windows")
  expect_snapshot(jgd(socket = "unix://localhost/nonexistent-jgd-localhost-test.sock"))
  expect_identical(names(dev.cur()), "jgd")
  dev.off()
})

test_that("Unix: drawing works with unix://localhost/ URI", {
  skip_on_os("windows")
  expect_snapshot(jgd(socket = "unix://localhost/nonexistent-jgd-localhost-draw.sock"))
  plot.new()
  rect(0, 0, 1, 1)
  dev.off()
})

# --- TCP tests (cross-platform) ---

test_that("TCP: jgd() opens a device and dev.off() closes it", {
  expect_snapshot(jgd(socket = "tcp://127.0.0.1:1"))
  expect_identical(names(dev.cur()), "jgd")
  dev.off()
})

test_that("TCP: jgd() respects JGD_SOCKET env var", {
  withr::local_envvar(JGD_SOCKET = "tcp://127.0.0.1:1")
  expect_snapshot(jgd())
  dev.off()
})

test_that("TCP: jgd() respects jgd.socket option", {
  withr::local_options(jgd.socket = "tcp://127.0.0.1:1")
  withr::local_envvar(JGD_SOCKET = NA)
  expect_snapshot(jgd())
  dev.off()
})

test_that("TCP: drawing works without server connection", {
  expect_snapshot(jgd(socket = "tcp://127.0.0.1:1"))
  plot.new()
  rect(0, 0, 1, 1)
  text(0.5, 0.5, "test")
  dev.off()
})

# --- Named pipe tests (Windows only) ---

test_that("npipe: npipe:/// URI accepted", {
  skip_if(.Platform$OS.type != "windows", "Named pipes only available on Windows")
  expect_warning(
    jgd(socket = "npipe:///nonexistent-jgd-test"),
    "could not connect to renderer"
  )
  expect_identical(names(dev.cur()), "jgd")
  dev.off()
})

test_that("npipe: npipe://localhost/ URI accepted", {
  skip_if(.Platform$OS.type != "windows", "Named pipes only available on Windows")
  expect_warning(
    jgd(socket = "npipe://localhost/nonexistent-jgd-localhost-test"),
    "could not connect to renderer"
  )
  expect_identical(names(dev.cur()), "jgd")
  dev.off()
})

test_that("npipe: drawing works with npipe://localhost/ URI", {
  skip_if(.Platform$OS.type != "windows", "Named pipes only available on Windows")
  expect_warning(
    jgd(socket = "npipe://localhost/nonexistent-jgd-localhost-draw"),
    "could not connect to renderer"
  )
  plot.new()
  rect(0, 0, 1, 1)
  dev.off()
})

# --- Transport-independent tests ---

test_that("jgd() validates socket parameter type", {
  expect_snapshot(jgd(socket = 42), error = TRUE)
  expect_snapshot(jgd(socket = c("a", "b")), error = TRUE)
})
