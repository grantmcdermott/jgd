# Tests that a plotIndex resize replay frame contains the CORRECT historical
# plot's content, not the current (latest) plot's content.
#
# Bug: When viewing a historical plot and resizing, the replay frame should
# contain the historical plot's drawing ops.  With grid-based packages
# (ggplot2, ComplexHeatmap), the snapshot replay via GEplaySnapshot +
# grid.refresh() may produce the wrong plot's content if the grid display
# list is not correctly restored from the snapshot.
#
# This test creates two ggplot2 plots with distinct titles ("PLOT_AAA" and
# "PLOT_ZZZ"), sends a plotIndex=0 resize, and verifies the replay frame
# contains text ops with "PLOT_AAA" (plot 1's title), not "PLOT_ZZZ".

# TCP mock server that sends a plotIndex=0 resize after receiving two
# newPage frames, then collects all messages including the replay.
start_mock_server_plotindex_content = function() {
  skip_if_not_installed("callr")
  skip_if_not_installed("jsonlite")

  port_file = tempfile(pattern = "jgd-pi-content-port-", fileext = ".txt")

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

        # After 2 newPage frames, send a plotIndex=0 resize
        # (simulates browser viewing historical plot 1 and resizing)
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

test_that("plotIndex resize replay contains the historical plot's content, not the current plot's", {
  skip_on_cran()
  skip_if_not_installed("ggplot2")

  server = start_mock_server_plotindex_content()
  withr::defer(server$cleanup())

  jgd(width = 4, height = 3, dpi = 72, socket = server$socket_url)

  # Plot 1 with a distinctive title
  set.seed(42)
  d1 = data.frame(x = runif(5), y = runif(5))
  print(ggplot2::ggplot(d1, ggplot2::aes(x, y)) +
    ggplot2::geom_point() +
    ggplot2::ggtitle("PLOT_AAA"))

  # Plot 2 with a different distinctive title
  set.seed(99)
  d2 = data.frame(x = runif(5), y = runif(5))
  print(ggplot2::ggplot(d2, ggplot2::aes(x, y)) +
    ggplot2::geom_point() +
    ggplot2::ggtitle("PLOT_ZZZ"))

  # Wait for the mock server to send the plotIndex=0 resize
  Sys.sleep(0.5)

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

  # Extract all text ops from the replay frame
  replay_ops = resize_frames[[1]]$plot$ops
  text_ops = Filter(function(o) identical(o$op, "text"), replay_ops)
  text_strings = vapply(text_ops, function(o) if (is.null(o$str)) "" else o$str, character(1))

  # THE KEY ASSERTION: the replay frame must contain plot 1's title
  expect_true("PLOT_AAA" %in% text_strings,
    info = paste0(
      "plotIndex=0 resize replay should contain plot 1's title 'PLOT_AAA'. ",
      "Text ops found: [", paste(text_strings, collapse = ", "), "]"))

  # And must NOT contain plot 2's title
  expect_false("PLOT_ZZZ" %in% text_strings,
    info = paste0(
      "plotIndex=0 resize replay should NOT contain plot 2's title 'PLOT_ZZZ'. ",
      "Text ops found: [", paste(text_strings, collapse = ", "), "]"))
})
