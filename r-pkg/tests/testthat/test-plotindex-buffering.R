# Tests that recv_metrics_response preserves the first buffered plotIndex
# resize when multiple arrive during a single metrics exchange.
#
# Scenario: the rendering server sends two plotIndex resize messages
# BEFORE the metrics_response.  recv_metrics_response must buffer only
# the first (FIFO matches the server's pendingResizes queue) and skip
# the second.
#
# Verification: after poll_resize_impl processes the buffered resize,
# the device dimensions should match the FIRST plotIndex resize, not
# the second.  This confirms FIFO ordering was preserved.
#
# Without the fix, recv_metrics_response overwrites the buffer with the
# second plotIndex → wrong dimensions applied → server queue desync.

# TCP mock server that injects two plotIndex resize messages before the
# first metrics_response.  Subsequent metrics_requests are answered normally.
start_mock_server_dual_plotindex = function() {
  skip_if_not_installed("callr")
  skip_if_not_installed("jsonlite")

  port_file = tempfile(pattern = "jgd-dual-pi-port-", fileext = ".txt")

  bg = callr::r_bg(
    function(port_file) {
      `%||%` = function(x, y) if (is.null(x)) y else x
      safe_write = function(conn, text) {
        tryCatch(
          { writeLines(text, conn); flush(conn) },
          error = function(e) invisible(NULL)
        )
      }

      server = NULL; port = NULL
      for (i in seq_len(20)) {
        candidate = sample(10000L:60000L, 1L)
        result = tryCatch(serverSocket(candidate), error = function(e) NULL)
        if (!is.null(result)) { server = result; port = candidate; break }
      }
      if (is.null(port)) stop("Could not find free port")
      on.exit(close(server), add = TRUE)
      writeLines(as.character(port), port_file)

      conn = socketAccept(server, blocking = TRUE, open = "r+")
      on.exit(close(conn), add = TRUE)

      injected = FALSE
      messages = list()

      repeat {
        ready = socketSelect(list(conn), timeout = 5)
        if (!ready) next

        line = tryCatch(readLines(conn, n = 1), error = function(e) character(0))
        if (length(line) == 0 || !nzchar(line)) next

        msg = tryCatch(
          jsonlite::fromJSON(line, simplifyVector = FALSE),
          error = function(e) NULL
        )
        if (is.null(msg)) next
        messages = c(messages, list(msg))

        if (identical(msg$type, "metrics_request")) {
          if (!injected) {
            # First metrics_request: inject two plotIndex resizes before
            # the metrics_response.  recv_metrics_response should buffer
            # only the first (plotIndex=0 at 500x400).
            safe_write(conn, jsonlite::toJSON(list(
              type = "resize", width = 500L, height = 400L, plotIndex = 0L
            ), auto_unbox = TRUE))
            safe_write(conn, jsonlite::toJSON(list(
              type = "resize", width = 600L, height = 450L, plotIndex = 1L
            ), auto_unbox = TRUE))
            injected = TRUE
          }

          resp = if (identical(msg$kind, "strWidth")) {
            list(type = "metrics_response", id = msg$id,
                 width = nchar(msg$str %||% "") * 8.0)
          } else {
            list(type = "metrics_response", id = msg$id,
                 ascent = 10.0, descent = 3.0, width = 8.0)
          }
          safe_write(conn, jsonlite::toJSON(resp, auto_unbox = TRUE))
        }

        if (identical(msg$type, "close")) break
      }

      messages
    },
    args = list(port_file = port_file),
    supervise = TRUE
  )

  port = NULL
  for (i in seq_len(50)) {
    if (file.exists(port_file)) {
      port_str = readLines(port_file, n = 1, warn = FALSE)
      if (length(port_str) > 0 && nzchar(port_str)) {
        port = as.integer(port_str); break
      }
    }
    Sys.sleep(0.1)
  }
  if (is.null(port)) { bg$kill(); skip("Mock server did not start in time") }

  list(
    bg = bg,
    socket_url = sprintf("tcp://127.0.0.1:%d", port),
    collect = function(timeout = 15000) {
      bg$wait(timeout)
      status = bg$get_exit_status()
      if (!is.null(status) && status != 0) {
        stop("Mock server exited with error: ", bg$read_error())
      }
      if (is.null(status)) {
        bg$kill()
        skip("Mock server did not exit in time")
      }
      bg$get_result()
    },
    cleanup = function() {
      if (bg$is_alive()) bg$kill()
      unlink(port_file)
    }
  )
}

test_that("recv_metrics_response preserves first plotIndex resize, skips second", {
  skip_on_cran()

  server = start_mock_server_dual_plotindex()
  withr::defer(server$cleanup())

  dpi = 72
  jgd(width = 4, height = 3, dpi = dpi, socket = server$socket_url)

  # Plot 1: creates a snapshot for historical resize
  plot.new()
  rect(0, 0, 1, 1, col = "red")

  # Plot 2: text() triggers metrics_request → mock server injects
  # plotIndex=0 resize at 500x400 and plotIndex=1 resize at 600x450
  # before the metrics_response.
  # recv_metrics_response should buffer only plotIndex=0 (the first).
  plot.new()
  text(0.5, 0.5, "X")

  # Force resize processing — poll_resize_impl drains the buffer and
  # applies the buffered dimensions to the device.
  result = .Call(jgd:::C_jgd_poll_resize)
  expect_true(result, info = "poll_resize should process the buffered resize")

  # Verify device dimensions match the FIRST plotIndex resize (500x400),
  # not the second (600x450).  poll_resize_impl applies pending_w/h to
  # the device before the snapshot replay, so dev.size() reflects which
  # resize was buffered.
  size_px = dev.size("px")
  expect_equal(size_px[1], 500,
    info = "Device width should be 500 (from first plotIndex resize)")
  expect_equal(size_px[2], 400,
    info = "Device height should be 400 (from first plotIndex resize)")

  # Second poll should be no-op — only one resize was buffered
  result2 = .Call(jgd:::C_jgd_poll_resize)
  expect_false(result2,
    info = "Second poll_resize should be no-op (second plotIndex was skipped)")

  dev.off()
  server$collect()
})
