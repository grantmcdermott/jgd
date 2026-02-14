test_that("dev.off() sends close message", {
  msgs = with_mock_jgd({
    plot.new()
  })

  close_msgs = Filter(function(m) identical(m$type, "close"), msgs)
  expect_length(close_msgs, 1)
})

test_that("drawing after plot.new() generates a frame", {
  msgs = with_mock_jgd({
    plot.new()
    rect(0, 0, 1, 1)
  })

  frames = extract_frames(msgs)
  expect_true(length(frames) >= 1)
})

test_that("frame contains correct device dimensions", {
  msgs = with_mock_jgd(width = 4, height = 3, dpi = 72, {
    plot.new()
    rect(0, 0, 1, 1)
  })

  frames = extract_frames(msgs)
  frame = frames[[1]]

  expect_equal(frame$plot$version, 1)
  expect_equal(frame$plot$device$width, 4 * 72)
  expect_equal(frame$plot$device$height, 3 * 72)
  expect_equal(frame$plot$device$dpi, 72)
})

test_that("rect() produces rect op", {
  msgs = with_mock_jgd({
    plot.new()
    rect(0.2, 0.2, 0.8, 0.8)
  })

  rect_ops = extract_ops_by_type(msgs, "rect")
  expect_true(length(rect_ops) >= 1)
})

test_that("text() produces text op with correct string", {
  msgs = with_mock_jgd({
    plot.new()
    text(0.5, 0.5, "Hello jgd")
  })

  text_ops = extract_ops_by_type(msgs, "text")
  expect_true(length(text_ops) >= 1)
  expect_true(any(vapply(
    text_ops,
    function(o) identical(o$str, "Hello jgd"),
    logical(1)
  )))
})

test_that("circle() produces circle op", {
  msgs = with_mock_jgd({
    plot.new()
    symbols(0.5, 0.5, circles = 0.1, add = TRUE, inches = FALSE)
  })

  circle_ops = extract_ops_by_type(msgs, "circle")
  expect_true(length(circle_ops) >= 1)
})

test_that("lines() produces polyline op", {
  msgs = with_mock_jgd({
    plot.new()
    lines(c(0.2, 0.5, 0.8), c(0.3, 0.7, 0.3))
  })

  polyline_ops = extract_ops_by_type(msgs, "polyline")
  expect_true(length(polyline_ops) >= 1)
})

test_that("polygon() produces polygon op", {
  msgs = with_mock_jgd({
    plot.new()
    polygon(c(0.2, 0.5, 0.8), c(0.3, 0.8, 0.3))
  })

  polygon_ops = extract_ops_by_type(msgs, "polygon")
  expect_true(length(polygon_ops) >= 1)
})

test_that("gc fields are present in ops", {
  msgs = with_mock_jgd({
    plot.new()
    rect(0, 0, 1, 1, col = "red", border = "blue")
  })

  rect_ops = extract_ops_by_type(msgs, "rect")
  expect_true(length(rect_ops) >= 1)

  gc = rect_ops[[1]]$gc
  expect_true(!is.null(gc))
  expect_true(!is.null(gc$col))
  expect_true(!is.null(gc$fill))
  expect_true(!is.null(gc$lwd))
  expect_true(!is.null(gc$font))
})

test_that("clip op is generated", {
  msgs = with_mock_jgd({
    plot(1:3, 1:3)
  })

  clip_ops = extract_ops_by_type(msgs, "clip")
  expect_true(length(clip_ops) >= 1)
})

test_that("plot() generates multiple op types", {
  msgs = with_mock_jgd({
    plot(1:5, 1:5, main = "Test Plot")
  })

  ops = extract_ops(msgs)
  op_types = unique(vapply(ops, function(o) o$op, character(1)))

  # A basic scatter plot should generate at least these op types
  expect_true("clip" %in% op_types)
  expect_true("line" %in% op_types)
  expect_true("text" %in% op_types)
})

test_that("multiple pages generate multiple full frames", {
  msgs = with_mock_jgd({
    plot.new()
    rect(0, 0, 1, 1)
    plot.new()
    rect(0, 0, 0.5, 0.5)
  })

  frames = extract_frames(msgs)
  # At least 2 frames from the 2 pages (may have incremental frames too)
  expect_true(length(frames) >= 2)
})

test_that("metrics_request messages are sent for text", {
  msgs = with_mock_jgd({
    plot.new()
    text(0.5, 0.5, "metrics test")
  })

  metrics_msgs = Filter(
    function(m) identical(m$type, "metrics_request"),
    msgs
  )
  # text() triggers metrics requests (strWidth and/or metricInfo)
  expect_true(length(metrics_msgs) >= 1)
})

# --- Snapshot tests for JSON structure ---

test_that("close message JSON matches snapshot", {
  msgs = with_mock_jgd({
    plot.new()
    rect(0, 0, 1, 1)
  })

  close_msg = Filter(function(m) identical(m$type, "close"), msgs)[[1]]
  expect_json_snapshot(close_msg)
})

test_that("frame device metadata matches snapshot", {
  msgs = with_mock_jgd(width = 4, height = 3, dpi = 72, {
    plot.new()
    rect(0, 0, 1, 1)
  })

  frame = extract_frames(msgs)[[1]]
  # sessionId contains a process ID that varies — check format separately
  expect_match(frame$plot$sessionId, "^r-[0-9]+$")
  expect_json_snapshot(list(
    version = frame$plot$version,
    device = frame$plot$device
  ))
})

test_that("rect op gc fields match snapshot", {
  msgs = with_mock_jgd({
    plot.new()
    rect(0, 0, 1, 1, col = "red", border = "blue", lwd = 2)
  })

  rect_ops = extract_ops_by_type(msgs, "rect")
  expect_json_snapshot(rect_ops[[1]]$gc)
})

test_that("text op structure matches snapshot", {
  msgs = with_mock_jgd({
    par(mar = c(0, 0, 0, 0))
    plot.new()
    text(0.5, 0.5, "snapshot test")
  })

  text_ops = extract_ops_by_type(msgs, "text")
  # Snapshot only stable fields (exclude coordinates which depend on layout)
  op = text_ops[[length(text_ops)]]
  expect_json_snapshot(list(
    op = op$op,
    str = op$str,
    rot = op$rot,
    hadj = op$hadj,
    gc = op$gc
  ))
})
