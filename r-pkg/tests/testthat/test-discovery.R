# Tests for socket discovery behavior.
#
# When the user provides an explicit socket= address, the device must
# never silently fall back to the discovery file.  This prevents
# confusing connections to unintended servers when the explicit path
# is stale.

test_that("explicit socket= does not fall back to discovery file", {
  # Start a TCP mock server that we can detect connections to.
  server = start_mock_server_tcp()
  withr::defer(server$cleanup())

  # Write a discovery file pointing to the mock server.
  write_test_discovery(
    sprintf('{"serverName":"test","socketPath":"%s","pid":1}', server$socket_url)
  )
  withr::local_envvar(JGD_SOCKET = NA)
  withr::local_options(jgd.socket = NULL)

  # Open jgd with an explicit bogus socket (nothing listens on port 1).
  # The device should warn but NOT fall back to the discovery file.
  expect_warning(
    jgd(socket = "tcp://127.0.0.1:1"),
    "could not connect"
  )
  plot.new()
  rect(0, 0, 1, 1)
  dev.off()

  # If fallback had occurred, the mock server would have accepted a
  # connection, received the "close" message from dev.off(), and exited.
  # Wait long enough for that to happen, then verify it is still alive
  # (blocked on socketAccept = no connection was made).
  server$bg$wait(2000)
  expect_true(server$bg$is_alive())
})

test_that("jgd_discover reads all discovery file fields", {
  write_test_discovery(
    '{"serverName":"test-server","socketPath":"unix:///tmp/test.sock","pid":12345,"serverInfo":{"httpUrl":"http://127.0.0.1:8080/"}}'
  )

  info = jgd_discover()
  expect_type(info, "list")
  expect_equal(info$server_name, "test-server")
  expect_equal(info$socket_path, "unix:///tmp/test.sock")
  expect_equal(info$pid, 12345L)
  expect_equal(info$server_info, c(httpUrl = "http://127.0.0.1:8080/"))
})

test_that("jgd_discover returns NULL when no discovery file", {
  set_empty_discovery_env()
  expect_null(jgd_discover())
})

test_that("jgd_discover returns NULL for invalid discovery file", {
  write_test_discovery('{"socketPath":"unix:///tmp/test.sock"}')

  # Missing serverName → invalid
  expect_null(jgd_discover())
})

test_that("jgd_discover handles missing serverInfo gracefully", {
  write_test_discovery(
    '{"serverName":"test","socketPath":"unix:///tmp/test.sock","pid":1}'
  )

  info = jgd_discover()
  expect_type(info, "list")
  expect_equal(info$server_name, "test")
  expect_length(info$server_info, 0)
})
