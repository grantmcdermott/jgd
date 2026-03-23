# Regression test for lines() disappearing on plotIndex resize replay.
#
# When plot(1:10); lines(1:10, col="red") is followed by hist(), navigating
# back to plot 1 and resizing should preserve the lines() polyline ops.
#
# This test is in a separate file from test-resize-plotindex-content.R to
# avoid grid state contamination from ggplot2 tests that run in the same
# file (ggplot2's grid state persists within a devtools::test() session and
# interferes with GEplaySnapshot for base graphics).

# TCP mock server that sends a plotIndex=0 resize after receiving two
# newPage frames, then collects all messages including the replay.
start_mock_server_plotindex_lines = function() {
  skip_if_not_installed("callr")
  skip_if_not_installed("jsonlite")

  port_file = tempfile(pattern = "jgd-pi-lines-port-", fileext = ".txt")

  bg = callr::r_bg(
    function(port_file) {
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
                 width = nchar(if (is.null(msg$str)) "" else msg$str) * 8.0)
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

        # After 2 newPage frames, send a plotIndex=0 resize
        if (new_page_count >= 2L && !resize_sent) {
          resize_sent = TRUE
          safe_write(conn, jsonlite::toJSON(list(
            type = "resize", width = 500L, height = 400L, plotIndex = 0L
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

test_that("plotIndex resize replay preserves lines() added after plot()", {
  skip_on_cran()

  server = start_mock_server_plotindex_lines()
  withr::defer(server$cleanup())

  jgd(width = 4, height = 3, dpi = 72, socket = server$socket_url)

  # Plot 1: plot + lines (two drawing calls on the same page)
  plot(1:10)
  lines(1:10, col = "red", lwd = 3)

  # Plot 2: hist (new page)
  hist(rnorm(1000), col = "steelblue")

  # Wait for the mock server to send the plotIndex=0 resize
  Sys.sleep(1.5)

  # Process the plotIndex=0 resize
  .Call(jgd:::C_jgd_poll_resize)

  dev.off()
  msgs = server$collect()

  # Find resize replay frames with plotIndex=0
  frames = Filter(function(m) identical(m$type, "frame"), msgs)
  resize_frames = Filter(
    function(f) isTRUE(f$resizeReplay) && identical(f$plotIndex, 0L),
    frames
  )
  expect_true(length(resize_frames) >= 1,
    info = "Should have at least 1 plotIndex=0 resize replay frame")

  # Collect all ops from the replay (including incremental frames)
  replay_ops = resize_frames[[1]]$plot$ops
  replay_idx = which(vapply(frames, function(f) {
    isTRUE(f$resizeReplay) && identical(f$plotIndex, 0L)
  }, logical(1)))[1]
  if (replay_idx < length(frames)) {
    for (j in (replay_idx + 1):length(frames)) {
      if (isTRUE(frames[[j]]$incremental)) {
        replay_ops = c(replay_ops, frames[[j]]$plot$ops)
      } else {
        break
      }
    }
  }

  op_types = vapply(
    replay_ops,
    function(o) if (is.null(o$op)) "" else o$op,
    character(1)
  )

  # The replay must contain polyline ops from lines()
  expect_true("polyline" %in% op_types,
    info = paste0(
      "plotIndex=0 resize replay should contain polyline ops from lines(). ",
      "Ops found: [", paste(unique(op_types), collapse = ", "), "]"))

  # Verify the polyline has the red color from lines()
  polyline_ops = Filter(function(o) identical(o$op, "polyline"), replay_ops)
  expect_true(length(polyline_ops) >= 1,
    info = "Should have at least 1 polyline op")

  # Check that at least one polyline has a red-ish color
  # jgd may serialize as "#FF0000FF" or "rgba(255,0,0,1)"
  has_red = any(vapply(polyline_ops, function(o) {
    col = o$gc$col
    if (is.null(col)) return(FALSE)
    grepl("^#[Ff][Ff]0000", col) || grepl("rgba\\(255,\\s*0,\\s*0", col)
  }, logical(1)))
  expect_true(has_red,
    info = paste0(
      "plotIndex=0 replay should have a red polyline from lines(col='red'). ",
      "polyline colors: [",
      paste(vapply(polyline_ops, function(o) {
        if (is.null(o$gc$col)) "NULL" else o$gc$col
      }, character(1)), collapse = ", "), "]"))
})
