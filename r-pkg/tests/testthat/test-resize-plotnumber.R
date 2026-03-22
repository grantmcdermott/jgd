# Tests that resize replay frames carry the correct plotNumber.
#
# Bug: cb_newPage increments page_count even during replays (st->replaying),
# so the plotNumber in the resize replay frame (page_count - 1) is one
# higher than the original plot's plotNumber.  The browser-side
# replaceLatest guard compares the replay's plotNumber against the stored
# _rIndex and rejects the update when they don't match, causing the plot
# to not be re-rendered at the new size.
#
# This test creates two plots, sends a normal resize, and verifies that
# the resize replay frame's plotNumber matches the original plot 2's
# plotNumber (not page_count - 1 after the replay incremented it).

# TCP mock server that sends a resize message after receiving two newPage
# frames, then collects the resize replay frame.
start_mock_server_resize_plotnumber = function() {
  skip_if_not_installed("callr")
  skip_if_not_installed("jsonlite")

  port_file = tempfile(pattern = "jgd-resize-pn-port-", fileext = ".txt")

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

      messages = list()
      new_page_count = 0L
      resize_sent = FALSE

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

        # Respond to metrics_request
        if (identical(msg$type, "metrics_request")) {
          resp = if (identical(msg$kind, "strWidth")) {
            list(type = "metrics_response", id = msg$id,
                 width = nchar(msg$str %||% "") * 8.0)
          } else {
            list(type = "metrics_response", id = msg$id,
                 ascent = 10.0, descent = 3.0, width = 8.0)
          }
          safe_write(conn, jsonlite::toJSON(resp, auto_unbox = TRUE))
        }

        # Count newPage frames
        if (identical(msg$type, "frame") && isTRUE(msg$newPage)) {
          new_page_count = new_page_count + 1L
        }

        # After 2 newPage frames, send a normal resize (no plotIndex)
        if (new_page_count >= 2L && !resize_sent) {
          resize_sent = TRUE
          safe_write(conn, jsonlite::toJSON(list(
            type = "resize", width = 500L, height = 400L
          ), auto_unbox = TRUE))
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

test_that("resize replay plotNumber matches the original plot's plotNumber", {
  skip_on_cran()

  server = start_mock_server_resize_plotnumber()
  withr::defer(server$cleanup())

  jgd(width = 4, height = 3, dpi = 72, socket = server$socket_url)

  # Plot 1
  plot(1:5)
  # Plot 2
  plot(1:10)

  # Wait for the mock server to receive the second newPage frame and send
  # back the resize message over the network.
  Sys.sleep(0.5)

  # Process the resize that the mock server sent after seeing 2 newPage frames.
  # The resize may have already been consumed by check_incoming during drawing,
  # so poll_resize returning FALSE is acceptable — what matters is whether
  # a resize replay frame was sent (checked below).
  .Call(jgd:::C_jgd_poll_resize)

  dev.off()
  msgs = server$collect()

  # Extract frames
  frames = Filter(function(m) identical(m$type, "frame"), msgs)

  # Find newPage frames — these are the original plot creations
  new_page_frames = Filter(function(f) isTRUE(f$newPage), frames)
  expect_true(length(new_page_frames) >= 2,
    info = "Should have at least 2 newPage frames")

  # The second newPage frame's plotNumber is the original plot 2's ID
  plot2_plotnumber = new_page_frames[[2]]$plotNumber
  expect_true(!is.null(plot2_plotnumber),
    info = "Plot 2's newPage frame should have a plotNumber")

  # Find resize replay frames
  resize_frames = Filter(function(f) isTRUE(f$resizeReplay), frames)
  expect_true(length(resize_frames) >= 1,
    info = "Should have at least 1 resize replay frame")

  resize_plotnumber = resize_frames[[1]]$plotNumber
  expect_true(!is.null(resize_plotnumber),
    info = "Resize replay frame should have a plotNumber")

  # THE KEY ASSERTION: resize replay's plotNumber must match the original
  # plot 2's plotNumber so the browser-side replaceLatest guard accepts it.
  expect_equal(resize_plotnumber, plot2_plotnumber,
    info = paste0(
      "Resize replay plotNumber (", resize_plotnumber,
      ") must match plot 2's plotNumber (", plot2_plotnumber,
      ") — if they differ, the browser rejects the resize replay"))
})
