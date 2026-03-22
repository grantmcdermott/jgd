# Tests for beginGroup/endGroup operations in the drawing stream

# Extract ops from the last complete (non-incremental) frame only,
# avoiding double-counting from intermediate flushes.
last_complete_ops = function(msgs) {
  frames = extract_frames(msgs)
  full = Filter(function(f) !isTRUE(f$incremental), frames)
  if (length(full) == 0) return(list())
  full[[length(full)]]$plot$ops
}

test_that("jgd_begin_group and jgd_end_group emit ops", {
  msgs = with_mock_jgd({
    plot.new()
    jgd_begin_group('{"filter":"blur(5px)"}')
    rect(0, 0, 1, 1)
    jgd_end_group()
  })

  ops = last_complete_ops(msgs)
  op_types = vapply(ops, function(o) o$op, character(1))

  expect_true("beginGroup" %in% op_types)
  expect_true("endGroup" %in% op_types)
  expect_equal(sum(op_types == "beginGroup"), 1)
  expect_equal(sum(op_types == "endGroup"), 1)
})

test_that("beginGroup includes ext field", {
  msgs = with_mock_jgd({
    plot.new()
    jgd_begin_group('{"filter":"blur(5px)","opacity":0.8}')
    rect(0, 0, 1, 1)
    jgd_end_group()
  })

  ops = last_complete_ops(msgs)
  begin_ops = Filter(function(o) identical(o$op, "beginGroup"), ops)
  expect_length(begin_ops, 1)

  ext = begin_ops[[1]]$ext
  expect_false(is.null(ext))
  expect_equal(ext$filter, "blur(5px)")
  expect_equal(ext$opacity, 0.8)
})

test_that("beginGroup with NULL ext has no ext field", {
  msgs = with_mock_jgd({
    plot.new()
    jgd_begin_group(NULL)
    rect(0, 0, 1, 1)
    jgd_end_group()
  })

  ops = last_complete_ops(msgs)
  begin_ops = Filter(function(o) identical(o$op, "beginGroup"), ops)
  expect_length(begin_ops, 1)
  expect_null(begin_ops[[1]]$ext)
})

test_that("with_jgd_group emits beginGroup and endGroup around expr", {
  msgs = with_mock_jgd({
    plot.new()
    with_jgd_group('{"filter":"blur(3px)"}', {
      rect(0, 0, 1, 1)
    })
  })

  ops = last_complete_ops(msgs)
  op_types = vapply(ops, function(o) o$op, character(1))

  bg_idx = which(op_types == "beginGroup")
  eg_idx = which(op_types == "endGroup")
  rect_idx = which(op_types == "rect")

  expect_equal(length(bg_idx), 1)
  expect_equal(length(eg_idx), 1)
  expect_true(length(rect_idx) >= 1)
  expect_true(bg_idx[1] < rect_idx[1])
  expect_true(eg_idx[1] > rect_idx[length(rect_idx)])
})

test_that("with_jgd_group returns expr result", {
  open_jgd = function() suppressWarnings(jgd(socket = "tcp://127.0.0.1:1"))
  open_jgd()
  on.exit(dev.off(), add = TRUE)

  result = with_jgd_group('{"opacity":0.5}', 42L)
  expect_equal(result, 42L)
})

test_that("with_jgd_group emits endGroup even on error", {
  msgs = with_mock_jgd({
    plot.new()
    tryCatch(
      with_jgd_group('{"opacity":0.5}', {
        rect(0, 0, 1, 1)
        stop("test error")
      }),
      error = function(e) NULL
    )
  })

  ops = last_complete_ops(msgs)
  op_types = vapply(ops, function(o) o$op, character(1))

  expect_equal(sum(op_types == "beginGroup"), 1)
  expect_equal(sum(op_types == "endGroup"), 1)
})

test_that("nested groups produce correct op sequence", {
  msgs = with_mock_jgd({
    plot.new()
    jgd_begin_group('{"filter":"blur(5px)"}')
    rect(0, 0, 1, 1)
    jgd_begin_group('{"opacity":0.5}')
    rect(0.2, 0.2, 0.8, 0.8)
    jgd_end_group()
    jgd_end_group()
  })

  ops = last_complete_ops(msgs)
  begin_ops = Filter(function(o) identical(o$op, "beginGroup"), ops)
  end_ops = Filter(function(o) identical(o$op, "endGroup"), ops)

  expect_length(begin_ops, 2)
  expect_length(end_ops, 2)

  expect_equal(begin_ops[[1]]$ext$filter, "blur(5px)")
  expect_equal(begin_ops[[2]]$ext$opacity, 0.5)
})

# --- Resize replay test ---

# TCP mock server that sends a resize after the first newPage frame.
start_mock_server_group_resize = function() {
  skip_if_not_installed("callr")
  skip_if_not_installed("jsonlite")

  port_file = tempfile(
    pattern = "jgd-grp-resize-port-",
    fileext = ".txt"
  )

  bg = callr::r_bg(
    function(port_file) {
      safe_write = function(conn, text) {
        tryCatch(
          {
            writeLines(text, conn)
            flush(conn)
          },
          error = function(e) invisible(NULL)
        )
      }

      server = NULL
      port = NULL
      for (i in seq_len(20)) {
        candidate = sample(10000L:60000L, 1L)
        result = tryCatch(
          serverSocket(candidate),
          error = function(e) NULL
        )
        if (!is.null(result)) {
          server = result
          port = candidate
          break
        }
      }
      if (is.null(port)) stop("Could not find free port")
      on.exit(close(server), add = TRUE)
      writeLines(as.character(port), port_file)

      conn = socketAccept(
        server,
        blocking = TRUE,
        open = "r+"
      )
      on.exit(close(conn), add = TRUE)

      messages = list()
      new_page_count = 0L
      resize_sent = FALSE

      repeat {
        ready = socketSelect(list(conn), timeout = 5)
        if (!ready) next

        line = tryCatch(
          readLines(conn, n = 1),
          error = function(e) character(0)
        )
        if (length(line) == 0 || !nzchar(line)) next

        msg = tryCatch(
          jsonlite::fromJSON(
            line,
            simplifyVector = FALSE
          ),
          error = function(e) NULL
        )
        if (is.null(msg)) next
        messages = c(messages, list(msg))

        if (identical(msg$type, "metrics_request")) {
          id = msg$id
          resp = if (identical(msg$kind, "strWidth")) {
            str = if (is.null(msg$str)) "" else msg$str
            list(
              type = "metrics_response",
              id = id,
              width = nchar(str) * 8.0
            )
          } else {
            list(
              type = "metrics_response",
              id = id,
              ascent = 10.0,
              descent = 3.0,
              width = 8.0
            )
          }
          safe_write(
            conn,
            jsonlite::toJSON(resp, auto_unbox = TRUE)
          )
        }

        if (identical(msg$type, "frame") &&
              isTRUE(msg$newPage)) {
          new_page_count = new_page_count + 1L
        }

        if (new_page_count >= 1L && !resize_sent) {
          resize_sent = TRUE
          safe_write(conn, jsonlite::toJSON(list(
            type = "resize",
            width = 500L,
            height = 400L
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
      port_str = readLines(
        port_file, n = 1,
        warn = FALSE
      )
      if (length(port_str) > 0 && nzchar(port_str)) {
        port = as.integer(port_str)
        break
      }
    }
    Sys.sleep(0.1)
  }
  if (is.null(port)) {
    bg$kill()
    skip("Mock server did not start in time")
  }

  list(
    bg = bg,
    socket_url = sprintf(
      "tcp://127.0.0.1:%d",
      port
    ),
    collect = function(timeout = 15000) {
      bg$wait(timeout)
      status = bg$get_exit_status()
      if (!is.null(status) && status != 0) {
        stop(
          "Mock server exited with error: ",
          bg$read_error()
        )
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

test_that("group ops survive resize replay via recordGraphics", {
  skip_on_cran()

  server = start_mock_server_group_resize()
  withr::defer(server$cleanup())

  jgd(
    width = 4, height = 3, dpi = 72,
    socket = server$socket_url
  )

  plot.new()
  jgd_begin_group('{"filter":"blur(5px)"}')
  rect(0, 0, 1, 1)
  jgd_end_group()

  Sys.sleep(0.5)
  .Call(jgd:::C_jgd_poll_resize)

  dev.off()
  msgs = server$collect()

  frames = Filter(
    function(m) identical(m$type, "frame"),
    msgs
  )
  resize_frames = Filter(
    function(f) isTRUE(f$resizeReplay),
    frames
  )
  expect_true(
    length(resize_frames) >= 1,
    info = "Should have at least 1 resize replay frame"
  )

  replay_ops = resize_frames[[1]]$plot$ops
  op_types = vapply(
    replay_ops,
    function(o) if (is.null(o$op)) "" else o$op,
    character(1)
  )

  expect_true(
    "beginGroup" %in% op_types,
    info = "beginGroup should survive resize replay"
  )
  expect_true(
    "endGroup" %in% op_types,
    info = "endGroup should survive resize replay"
  )

  begin_ops = Filter(
    function(o) identical(o$op, "beginGroup"),
    replay_ops
  )
  expect_equal(
    begin_ops[[1]]$ext$filter, "blur(5px)",
    info = "Group ext should be preserved after replay"
  )
})

# --- Input validation tests ---

test_that("jgd_begin_group rejects invalid JSON", {
  open_jgd = function() suppressWarnings(jgd(socket = "tcp://127.0.0.1:1"))
  open_jgd()
  on.exit({ graphics.off() }, add = TRUE)

  expect_error(jgd_begin_group("not valid json"), "invalid JSON")
  expect_error(jgd_begin_group("{unclosed"), "invalid JSON")
})

test_that("jgd_begin_group rejects non-string input", {
  open_jgd = function() suppressWarnings(jgd(socket = "tcp://127.0.0.1:1"))
  open_jgd()
  on.exit({ graphics.off() }, add = TRUE)

  expect_error(jgd_begin_group(42))
  expect_error(jgd_begin_group(list(a = 1)))
})

test_that("jgd_end_group errors without matching beginGroup", {
  open_jgd = function() suppressWarnings(jgd(socket = "tcp://127.0.0.1:1"))
  open_jgd()
  on.exit({ graphics.off() }, add = TRUE)

  plot.new()
  expect_error(jgd_end_group(), "endGroup without matching beginGroup")
})

# --- Auto-close tests ---

test_that("unclosed group is auto-closed at new page with warning", {
  msgs = with_mock_jgd({
    plot.new()
    jgd_begin_group('{"opacity":0.5}')
    rect(0, 0, 1, 1)
    # No jgd_end_group() — auto-close should happen at next plot.new()
    expect_warning(plot.new(), "unclosed group")
    rect(0, 0, 0.5, 0.5)
  })

  # Collect all ops from frames before the second page's first complete frame.
  # The auto-closed endGroup may be in an incremental frame.
  frames = extract_frames(msgs)
  full_frames = Filter(function(f) !isTRUE(f$incremental), frames)
  expect_true(length(full_frames) >= 2)

  # All ops up to (but not including) the second complete frame belong
  # to the first page (including auto-close incremental frames).
  second_idx = which(vapply(
    frames,
    function(f) !isTRUE(f$incremental),
    logical(1)
  ))[2]
  first_page_frames = frames[seq_len(second_idx - 1)]
  all_ops = unlist(
    lapply(first_page_frames, function(f) f$plot$ops),
    recursive = FALSE
  )
  op_types = vapply(all_ops, function(o) o$op, character(1))
  begin_count = sum(op_types == "beginGroup")
  end_count = sum(op_types == "endGroup")
  expect_equal(begin_count, end_count,
    info = "Auto-close should balance beginGroup/endGroup")
})

test_that("unclosed group is auto-closed at device close with warning", {
  expect_warning(
    with_mock_jgd({
      plot.new()
      jgd_begin_group('{"filter":"blur(3px)"}')
      rect(0, 0, 1, 1)
      # No jgd_end_group() — auto-close should happen at dev.off()
    }),
    "unclosed group"
  )
})

test_that("multiple unclosed groups are all auto-closed", {
  msgs = with_mock_jgd({
    plot.new()
    jgd_begin_group('{"opacity":0.5}')
    jgd_begin_group('{"filter":"blur(3px)"}')
    rect(0, 0, 1, 1)
    # 2 unclosed groups
    expect_warning(plot.new(), "2 unclosed group")
    rect(0, 0, 0.5, 0.5)
  })

  # Collect all first-page ops (including auto-close incremental frames)
  frames = extract_frames(msgs)
  full_indices = which(vapply(
    frames,
    function(f) !isTRUE(f$incremental),
    logical(1)
  ))
  expect_true(length(full_indices) >= 2)
  first_page_frames = frames[seq_len(full_indices[2] - 1)]
  all_ops = unlist(
    lapply(first_page_frames, function(f) f$plot$ops),
    recursive = FALSE
  )
  op_types = vapply(all_ops, function(o) o$op, character(1))
  expect_equal(
    sum(op_types == "beginGroup"),
    sum(op_types == "endGroup"),
    info = "Both unclosed groups should be auto-closed"
  )
})

# --- Error tests ---

test_that("group ops errors when no jgd device is active", {
  graphics.off()
  expect_error(jgd_begin_group('{"opacity":0.5}'))
  # jgd_end_group may error with "no active graphics device",
  # "not a jgd device", or "endGroup without matching beginGroup"
  # depending on device state after graphics.off()
  expect_error(jgd_end_group())
})
