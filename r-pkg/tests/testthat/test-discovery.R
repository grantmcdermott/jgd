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
  discovery_dir = withr::local_tempdir("jgd-disc-")
  writeLines(
    sprintf('{"socketPath": "%s"}', server$socket_url),
    file.path(discovery_dir, "jgd-discovery.json")
  )

  # Point TMPDIR at our discovery dir so C-side discover_socket_path()
  # would find it.  Clear other env vars to avoid interference.
  withr::local_envvar(
    TMPDIR = discovery_dir,
    TMP = NA,
    TEMP = NA,
    JGD_SOCKET = NA
  )
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
