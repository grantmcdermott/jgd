# Tests for frame-level ext field

test_that("jgd_frame_ext adds ext to frame message", {
  msgs = with_mock_jgd({
    jgd_frame_ext('{"postEffects":[{"type":"blur","radius":5}]}')
    plot.new()
    rect(0, 0, 1, 1)
  })

  frames = extract_frames(msgs)
  expect_true(length(frames) >= 1)

  frame = frames[[1]]
  expect_false(is.null(frame$ext))
  expect_length(frame$ext$postEffects, 1)
  expect_equal(frame$ext$postEffects[[1]]$type, "blur")
  expect_equal(frame$ext$postEffects[[1]]$radius, 5)
})

test_that("frame ext is absent when not set", {
  msgs = with_mock_jgd({
    plot.new()
    rect(0, 0, 1, 1)
  })

  frames = extract_frames(msgs)
  expect_true(length(frames) >= 1)
  expect_null(frames[[1]]$ext)
})

test_that("jgd_frame_ext(NULL) clears frame ext", {
  msgs = with_mock_jgd({
    jgd_frame_ext('{"postEffects":[{"type":"blur"}]}')
    plot.new()
    rect(0, 0, 1, 1)
    # Clear and draw second plot
    jgd_frame_ext(NULL)
    plot.new()
    rect(0, 0, 0.5, 0.5)
  })

  frames = extract_frames(msgs)
  expect_true(length(frames) >= 2)

  # First frame should have ext
  expect_false(is.null(frames[[1]]$ext))

  # Find the second full (non-incremental) frame
  full_frames = Filter(function(f) !isTRUE(f$incremental), frames)
  expect_true(length(full_frames) >= 2)
  expect_null(full_frames[[2]]$ext)
})

test_that("with_jgd_frame_ext scopes frame ext", {
  msgs = with_mock_jgd({
    with_jgd_frame_ext('{"postEffects":[{"type":"glow"}]}', {
      plot.new()
      rect(0, 0, 1, 1)
    })
    # After scope, draw another plot — frame ext should be cleared
    plot.new()
    rect(0, 0, 0.5, 0.5)
  })

  frames = extract_frames(msgs)
  full_frames = Filter(function(f) !isTRUE(f$incremental), frames)
  expect_true(length(full_frames) >= 2)

  expect_false(is.null(full_frames[[1]]$ext))
  expect_null(full_frames[[2]]$ext)
})

test_that("with_jgd_frame_ext returns expr result", {
  open_jgd = function() suppressWarnings(jgd(socket = "tcp://127.0.0.1:1"))
  open_jgd()
  on.exit(dev.off(), add = TRUE)

  result = with_jgd_frame_ext('{"postEffects":[]}', 42L)
  expect_equal(result, 42L)
})

test_that("jgd_frame_ext rejects invalid JSON", {
  open_jgd = function() suppressWarnings(jgd(socket = "tcp://127.0.0.1:1"))
  open_jgd()
  on.exit({ graphics.off() }, add = TRUE)

  expect_error(jgd_frame_ext("not valid json"), "invalid JSON")
  expect_error(jgd_frame_ext("{unclosed"), "invalid JSON")
  # Empty string clears (same as NULL)
  expect_invisible(jgd_frame_ext(""))
})

test_that("jgd_frame_ext rejects non-string input", {
  open_jgd = function() suppressWarnings(jgd(socket = "tcp://127.0.0.1:1"))
  open_jgd()
  on.exit({ graphics.off() }, add = TRUE)

  expect_error(jgd_frame_ext(42))
  expect_error(jgd_frame_ext(list(a = 1)))
})

test_that("jgd_frame_ext errors when no jgd device is active", {
  graphics.off()
  expect_error(jgd_frame_ext('{"postEffects":[]}'))
})

test_that("frame ext is independent of gc ext", {
  msgs = with_mock_jgd({
    jgd_frame_ext('{"postEffects":[{"type":"blur"}]}')
    jgd_ext('{"blendMode":"multiply"}')
    plot.new()
    rect(0, 0, 1, 1)
  })

  frames = extract_frames(msgs)
  frame = frames[[1]]

  # Frame-level ext
  expect_false(is.null(frame$ext))
  expect_equal(frame$ext$postEffects[[1]]$type, "blur")

  # gc-level ext on drawing ops
  rect_ops = extract_ops_by_type(msgs, "rect")
  expect_true(length(rect_ops) >= 1)
  gc_ext = rect_ops[[1]]$gc$ext
  expect_false(is.null(gc_ext))
  expect_equal(gc_ext$blendMode, "multiply")
})
