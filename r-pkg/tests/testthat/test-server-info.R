test_that("jgd_server_info() returns server metadata when welcome is sent", {
  skip_on_os("windows")

  server = start_mock_server_local(send_welcome = TRUE)
  withr::defer(server$cleanup())

  jgd(width = 4, height = 3, dpi = 72, socket = server$socket_path)

  info = jgd_server_info()
  expect_type(info, "list")
  expect_identical(info$server_name, "jgd-mock")
  expect_identical(info$protocol_version, 1L)
  expect_type(info$server_info, "character")
  expect_identical(info$server_info[["httpUrl"]], "http://127.0.0.1:9999/")

  dev.off()
  server$collect()
})

test_that("jgd_server_info() returns server metadata over TCP", {
  server = start_mock_server_tcp(send_welcome = TRUE)
  withr::defer(server$cleanup())

  jgd(width = 4, height = 3, dpi = 72, socket = server$socket_url)

  info = jgd_server_info()
  expect_type(info, "list")
  expect_identical(info$server_name, "jgd-mock")
  expect_identical(info$protocol_version, 1L)
  expect_identical(info$server_info[["httpUrl"]], "http://127.0.0.1:9999/")

  dev.off()
  server$collect()
})

test_that("jgd_server_info() returns NULL when server sends no welcome", {
  skip_on_os("windows")

  server = start_mock_server_local(send_welcome = FALSE)
  withr::defer(server$cleanup())

  jgd(width = 4, height = 3, dpi = 72, socket = server$socket_path)

  info = jgd_server_info()
  expect_null(info)

  dev.off()
  server$collect()
})

test_that("jgd_server_info() returns NULL when not connected", {
  skip_on_os("windows")
  expect_warning(
    jgd(socket = "unix:///nonexistent-jgd-info-test.sock"),
    "could not connect"
  )

  info = jgd_server_info()
  expect_null(info)

  dev.off()
})
