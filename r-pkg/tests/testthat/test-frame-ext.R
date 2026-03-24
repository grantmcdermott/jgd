# Tests for frame-level ext field

test_that("jgd_frame_ext adds ext to frame message", {
  msgs <- with_mock_jgd({
    jgd_frame_ext('{"postEffects":[{"type":"blur","radius":5}]}')
    plot.new()
    rect(0, 0, 1, 1)
  })

  frames <- extract_frames(msgs)
  expect_true(length(frames) >= 1)

  frame <- frames[[1]]
  expect_false(is.null(frame$ext))
  expect_length(frame$ext$postEffects, 1)
  expect_equal(frame$ext$postEffects[[1]]$type, "blur")
  expect_equal(frame$ext$postEffects[[1]]$radius, 5)
})

test_that("frame ext is absent when not set", {
  msgs <- with_mock_jgd({
    plot.new()
    rect(0, 0, 1, 1)
  })

  frames <- extract_frames(msgs)
  expect_true(length(frames) >= 1)
  expect_null(frames[[1]]$ext)
})

test_that("jgd_frame_ext(NULL) clears frame ext", {
  msgs <- with_mock_jgd({
    jgd_frame_ext('{"postEffects":[{"type":"blur"}]}')
    plot.new()
    rect(0, 0, 1, 1)
    # Clear and draw second plot
    jgd_frame_ext(NULL)
    plot.new()
    rect(0, 0, 0.5, 0.5)
  })

  frames <- extract_frames(msgs)
  expect_true(length(frames) >= 2)

  # First frame should have ext
  expect_false(is.null(frames[[1]]$ext))

  # Find the second full (non-incremental) frame
  full_frames <- Filter(function(f) !isTRUE(f$incremental), frames)
  expect_true(length(full_frames) >= 2)
  expect_null(full_frames[[2]]$ext)
})

test_that("with_jgd_frame_ext scopes frame ext", {
  msgs <- with_mock_jgd({
    with_jgd_frame_ext('{"postEffects":[{"type":"glow"}]}', {
      plot.new()
      rect(0, 0, 1, 1)
    })
    # After scope, draw another plot — frame ext should be cleared
    plot.new()
    rect(0, 0, 0.5, 0.5)
  })

  frames <- extract_frames(msgs)
  full_frames <- Filter(function(f) !isTRUE(f$incremental), frames)
  expect_true(length(full_frames) >= 2)

  expect_false(is.null(full_frames[[1]]$ext))
  expect_null(full_frames[[2]]$ext)
})

test_that("with_jgd_frame_ext returns expr result", {
  open_jgd <- function() suppressWarnings(jgd(socket = "tcp://127.0.0.1:1"))
  open_jgd()
  on.exit(dev.off(), add = TRUE)

  result <- with_jgd_frame_ext('{"postEffects":[]}', 42L)
  expect_equal(result, 42L)
})

test_that("jgd_frame_ext rejects invalid JSON", {
  open_jgd <- function() suppressWarnings(jgd(socket = "tcp://127.0.0.1:1"))
  open_jgd()
  on.exit({ graphics.off() }, add = TRUE)

  expect_error(jgd_frame_ext("not valid json"), "invalid JSON")
  expect_error(jgd_frame_ext("{unclosed"), "invalid JSON")
  # Empty string clears (same as NULL)
  expect_invisible(jgd_frame_ext(""))
})

test_that("jgd_frame_ext rejects non-string input", {
  open_jgd <- function() suppressWarnings(jgd(socket = "tcp://127.0.0.1:1"))
  open_jgd()
  on.exit({ graphics.off() }, add = TRUE)

  expect_error(jgd_frame_ext(42))
  expect_error(jgd_frame_ext(list(a = 1)))
})

test_that("jgd_frame_ext errors when no jgd device is active", {
  graphics.off()
  expect_error(jgd_frame_ext('{"postEffects":[]}'))
})

# --- Resize replay tests ---

# TCP mock server that sends a resize after the first newPage frame,
# then collects messages including the replay frame.
start_mock_server_frame_ext_resize <- function() {
  skip_if_not_installed("callr")
  skip_if_not_installed("jsonlite")

  port_file <- tempfile(pattern = "jgd-fext-resize-port-", fileext = ".txt")

  bg <- callr::r_bg(
    function(port_file) {
      `%||%` <- function(x, y) if (is.null(x)) y else x
      safe_write <- function(conn, text) {
        tryCatch(
          { writeLines(text, conn); flush(conn) },
          error = function(e) invisible(NULL)
        )
      }

      server <- NULL; port <- NULL
      for (i in seq_len(20)) {
        candidate <- sample(10000L:60000L, 1L)
        result <- tryCatch(serverSocket(candidate), error = function(e) NULL)
        if (!is.null(result)) { server <- result; port <- candidate; break }
      }
      if (is.null(port)) stop("Could not find free port")
      on.exit(close(server), add = TRUE)
      writeLines(as.character(port), port_file)

      conn <- socketAccept(server, blocking = TRUE, open = "r+")
      on.exit(close(conn), add = TRUE)

      messages <- list()
      new_page_count <- 0L
      resize_sent <- FALSE

      repeat {
        ready <- socketSelect(list(conn), timeout = 5)
        if (!ready) next

        line <- tryCatch(readLines(conn, n = 1), error = function(e) character(0))
        if (length(line) == 0 || !nzchar(line)) next

        msg <- tryCatch(
          jsonlite::fromJSON(line, simplifyVector = FALSE),
          error = function(e) NULL
        )
        if (is.null(msg)) next
        messages <- c(messages, list(msg))

        if (identical(msg$type, "metrics_request")) {
          resp <- if (identical(msg$kind, "strWidth")) {
            list(type = "metrics_response", id = msg$id,
                 width = nchar(msg$str %||% "") * 8.0)
          } else {
            list(type = "metrics_response", id = msg$id,
                 ascent = 10.0, descent = 3.0, width = 8.0)
          }
          safe_write(conn, jsonlite::toJSON(resp, auto_unbox = TRUE))
        }

        if (identical(msg$type, "frame") && isTRUE(msg$newPage)) {
          new_page_count <- new_page_count + 1L
        }

        # After first newPage frame, send a normal resize
        if (new_page_count >= 1L && !resize_sent) {
          resize_sent <- TRUE
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

  port <- NULL
  for (i in seq_len(50)) {
    if (file.exists(port_file)) {
      port_str <- readLines(port_file, n = 1, warn = FALSE)
      if (length(port_str) > 0 && nzchar(port_str)) {
        port <- as.integer(port_str); break
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
      status <- bg$get_exit_status()
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

test_that("frame ext survives resize replay", {
  skip_on_cran()

  server <- start_mock_server_frame_ext_resize()
  withr::defer(server$cleanup())

  jgd(width = 4, height = 3, dpi = 72, socket = server$socket_url)
  jgd_frame_ext('{"postEffects":[{"type":"blur","radius":5}]}')

  plot(1:3)

  # Wait for the mock server to send the resize.
  # Windows i386 CI can be slow; use a longer sleep.
  Sys.sleep(1.5)

  # Process the resize
  .Call(jgd:::C_jgd_poll_resize)

  dev.off()
  msgs <- server$collect()

  frames <- Filter(function(m) identical(m$type, "frame"), msgs)

  # Should have the original frame and a resize replay frame
  resize_frames <- Filter(function(f) isTRUE(f$resizeReplay), frames)
  expect_true(length(resize_frames) >= 1,
    info = "Should have at least 1 resize replay frame")

  # The resize replay frame must preserve the frame-level ext
  replay <- resize_frames[[1]]
  expect_false(is.null(replay$ext),
    info = "Resize replay frame should preserve frame-level ext")
  expect_equal(replay$ext$postEffects[[1]]$type, "blur")
  expect_equal(replay$ext$postEffects[[1]]$radius, 5)
})

# TCP mock server that sends a plotIndex=0 resize after receiving two
# newPage frames, to test historical plot frame ext preservation.
start_mock_server_frame_ext_plotindex <- function() {
  skip_if_not_installed("callr")
  skip_if_not_installed("jsonlite")

  port_file <- tempfile(
    pattern = "jgd-fext-pi-port-",
    fileext = ".txt"
  )

  bg <- callr::r_bg(
    function(port_file) {
      safe_write <- function(conn, text) {
        tryCatch(
          {
            writeLines(text, conn)
            flush(conn)
          },
          error = function(e) invisible(NULL)
        )
      }

      server <- NULL
      port <- NULL
      for (i in seq_len(20)) {
        candidate <- sample(10000L:60000L, 1L)
        result <- tryCatch(
          serverSocket(candidate),
          error = function(e) NULL
        )
        if (!is.null(result)) {
          server <- result
          port <- candidate
          break
        }
      }
      if (is.null(port)) stop("Could not find free port")
      on.exit(close(server), add = TRUE)
      writeLines(as.character(port), port_file)

      conn <- socketAccept(
        server,
        blocking = TRUE,
        open = "r+"
      )
      on.exit(close(conn), add = TRUE)

      messages <- list()
      new_page_count <- 0L
      resize_sent <- FALSE

      repeat {
        ready <- socketSelect(list(conn), timeout = 5)
        if (!ready) next

        line <- tryCatch(
          readLines(conn, n = 1),
          error = function(e) character(0)
        )
        if (length(line) == 0 || !nzchar(line)) next

        msg <- tryCatch(
          jsonlite::fromJSON(
            line,
            simplifyVector = FALSE
          ),
          error = function(e) NULL
        )
        if (is.null(msg)) next
        messages <- c(messages, list(msg))

        if (identical(msg$type, "metrics_request")) {
          id <- msg$id
          resp <- if (identical(msg$kind, "strWidth")) {
            str <- if (is.null(msg$str)) "" else msg$str
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
          new_page_count <- new_page_count + 1L
        }

        # After 2 newPage frames, send plotIndex=0 resize
        if (new_page_count >= 2L && !resize_sent) {
          resize_sent <- TRUE
          safe_write(conn, jsonlite::toJSON(list(
            type = "resize",
            width = 500L,
            height = 400L,
            plotIndex = 0L
          ), auto_unbox = TRUE))
        }

        if (identical(msg$type, "close")) break
      }

      messages
    },
    args = list(port_file = port_file),
    supervise = TRUE
  )

  port <- NULL
  for (i in seq_len(50)) {
    if (file.exists(port_file)) {
      port_str <- readLines(
        port_file, n = 1,
        warn = FALSE
      )
      if (length(port_str) > 0 && nzchar(port_str)) {
        port <- as.integer(port_str)
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
      status <- bg$get_exit_status()
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

test_that("frame ext survives plotIndex resize replay", {
  skip_on_cran()

  server <- start_mock_server_frame_ext_plotindex()
  withr::defer(server$cleanup())

  jgd(
    width = 4, height = 3, dpi = 72,
    socket = server$socket_url
  )

  # Plot 1: with frame ext "blur"
  jgd_frame_ext(
    '{"postEffects":[{"type":"blur","radius":5}]}'
  )
  plot(1:3)

  # Plot 2: different frame ext "glow"
  jgd_frame_ext(
    '{"postEffects":[{"type":"glow"}]}'
  )
  plot(4:6)

  # Wait for mock server to send plotIndex=0 resize
  Sys.sleep(0.5)
  .Call(jgd:::C_jgd_poll_resize)

  dev.off()
  msgs <- server$collect()

  frames <- Filter(
    function(m) identical(m$type, "frame"),
    msgs
  )
  resize_frames <- Filter(
    function(f) {
      isTRUE(f$resizeReplay) && identical(f$plotIndex, 0L)
    },
    frames
  )
  expect_true(
    length(resize_frames) >= 1,
    info = "Should have a plotIndex=0 resize replay frame"
  )

  replay <- resize_frames[[1]]
  expect_false(
    is.null(replay$ext),
    info = paste(
      "plotIndex=0 replay should preserve",
      "plot 1's frame ext"
    )
  )
  expect_equal(
    replay$ext$postEffects[[1]]$type, "blur",
    info = "Should be plot 1's ext (blur), not plot 2's"
  )
  expect_equal(
    replay$ext$postEffects[[1]]$radius, 5
  )
})

test_that("plotIndex replay preserves ext when later plot clears it", {
  skip_on_cran()

  server <- start_mock_server_frame_ext_plotindex()
  withr::defer(server$cleanup())

  jgd(
    width = 4, height = 3, dpi = 72,
    socket = server$socket_url
  )

  # Plot 1: with frame ext "blur"
  jgd_frame_ext(
    '{"postEffects":[{"type":"blur","radius":3}]}'
  )
  plot(1:3)

  # Plot 2: clear frame ext
  jgd_frame_ext(NULL)
  plot(4:6)

  # Wait for mock server to send plotIndex=0 resize
  Sys.sleep(0.5)
  .Call(jgd:::C_jgd_poll_resize)

  dev.off()
  msgs <- server$collect()

  frames <- Filter(
    function(m) identical(m$type, "frame"),
    msgs
  )
  resize_frames <- Filter(
    function(f) {
      isTRUE(f$resizeReplay) && identical(f$plotIndex, 0L)
    },
    frames
  )
  expect_true(
    length(resize_frames) >= 1,
    info = "Should have a plotIndex=0 resize replay frame"
  )

  replay <- resize_frames[[1]]
  expect_false(
    is.null(replay$ext),
    info = "plotIndex=0 replay should preserve plot 1's ext even when plot 2 cleared it"
  )
  expect_equal(
    replay$ext$postEffects[[1]]$type, "blur",
    info = "Should be plot 1's ext (blur)"
  )
  expect_equal(
    replay$ext$postEffects[[1]]$radius, 3
  )
})

# --- Independence test ---

test_that("frame ext is independent of gc ext", {
  msgs <- with_mock_jgd({
    jgd_frame_ext('{"postEffects":[{"type":"blur"}]}')
    jgd_ext('{"blendMode":"multiply"}')
    plot.new()
    rect(0, 0, 1, 1)
  })

  frames <- extract_frames(msgs)
  frame <- frames[[1]]

  # Frame-level ext
  expect_false(is.null(frame$ext))
  expect_equal(frame$ext$postEffects[[1]]$type, "blur")

  # gc-level ext on drawing ops
  rect_ops <- extract_ops_by_type(msgs, "rect")
  expect_true(length(rect_ops) >= 1)
  gc_ext <- rect_ops[[1]]$gc$ext
  expect_false(is.null(gc_ext))
  expect_equal(gc_ext$blendMode, "multiply")
})

test_that("frame ext glow + gc.ext opacity produces correct frame data", {
  # Regression test for jgd-8qz: glow post-effect with gc.ext opacity
  # rendered blank in the browser due to additive blending on white bg.
  # This test verifies the R-side frame data is correctly formed.
  msgs <- with_mock_jgd({
    jgd_frame_ext('{"postEffects":[{"type":"glow"}]}')
    jgd_ext('{"opacity":0.5}')
    plot.new()
    rect(0.1, 0.1, 0.9, 0.9, col = "red")
    jgd_ext(NULL)
    jgd_frame_ext(NULL)
  })

  frames <- extract_frames(msgs)
  expect_true(length(frames) >= 1)

  frame <- frames[[1]]
  # Frame should have glow postEffect
  expect_false(is.null(frame$ext))
  expect_equal(frame$ext$postEffects[[1]]$type, "glow")

  # Drawing ops should have gc.ext with opacity
  rect_ops <- Filter(
    function(o) identical(o$op, "rect"),
    frame$plot$ops
  )
  expect_true(length(rect_ops) >= 1)
  expect_equal(rect_ops[[1]]$gc$ext$opacity, 0.5)
})
