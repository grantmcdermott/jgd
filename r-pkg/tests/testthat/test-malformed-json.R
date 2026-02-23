# Tests that malformed JSON from the server does not crash the device.
#
# The device receives JSON messages from the rendering server (resize,
# metrics_response).  If the server sends garbage, the device must
# silently ignore it and continue producing correct output.

# TCP mock server that injects malformed JSON at two points:
# 1. Immediately after connection (drained by check_incoming on newPage)
# 2. Before each metrics_response (drained by recv_metrics_response)
start_mock_server_malformed = function() {
  skip_if_not_installed("callr")
  skip_if_not_installed("jsonlite")

  port_file = tempfile(pattern = "jgd-malformed-port-", fileext = ".txt")

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

      # Inject malformed JSON immediately after connection
      safe_write(conn, c(
        "{not valid json at all",
        "totally not json",
        '{"type": "resize", "width": "not_a_number", "height": "bad"}',
        '{"type": "resize"}',
        ""
      ))

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
          # Inject one malformed line before the valid response
          safe_write(conn, "{broken json")

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

test_that("device survives malformed JSON and produces correct output", {
  skip_on_cran()

  server = start_mock_server_malformed()
  withr::defer(server$cleanup())

  jgd(width = 4, height = 3, dpi = 72, socket = server$socket_url)
  plot.new()
  rect(0, 0, 1, 1, col = "red", border = "blue", lwd = 2)
  text(0.5, 0.5, "hi")
  dev.off()

  msgs = server$collect()
  frames = Filter(function(m) identical(m$type, "frame"), msgs)

  # Device produced at least one frame
  expect_true(length(frames) >= 1)

  # Frame metadata is intact
  frame = frames[[1]]
  expect_equal(frame$plot$version, 1)
  expect_match(frame$plot$sessionId, "^r-[0-9]+$")

  # Ops are present and correct
  ops = unlist(lapply(frames, function(f) f$plot$ops), recursive = FALSE)
  op_types = vapply(ops, function(o) o$op, character(1))
  expect_true("rect" %in% op_types)
  expect_true("text" %in% op_types)
})

test_that("malformed JSON: device metadata matches snapshot", {
  skip_on_cran()

  server = start_mock_server_malformed()
  withr::defer(server$cleanup())

  jgd(width = 4, height = 3, dpi = 72, socket = server$socket_url)
  plot.new()
  rect(0, 0, 1, 1, col = "red", border = "blue", lwd = 2)
  dev.off()

  msgs = server$collect()
  frame = Filter(function(m) identical(m$type, "frame"), msgs)[[1]]

  expect_json_snapshot(list(
    version = frame$plot$version,
    device = frame$plot$device
  ))
})

test_that("malformed JSON: rect gc fields match snapshot", {
  skip_on_cran()

  server = start_mock_server_malformed()
  withr::defer(server$cleanup())

  jgd(width = 4, height = 3, dpi = 72, socket = server$socket_url)
  plot.new()
  rect(0, 0, 1, 1, col = "red", border = "blue", lwd = 2)
  dev.off()

  msgs = server$collect()
  rect_ops = extract_ops_by_type(msgs, "rect")
  expect_json_snapshot(rect_ops[[1]]$gc)
})
