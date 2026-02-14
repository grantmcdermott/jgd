test_that("TCP: basic connection and close", {
  msgs = with_mock_jgd(transport = "tcp", {
    plot.new()
    rect(0, 0, 1, 1)
  })

  close_msgs = Filter(function(m) identical(m$type, "close"), msgs)
  expect_length(close_msgs, 1)
})

test_that("TCP: frame generation with correct dimensions", {
  msgs = with_mock_jgd(width = 5, height = 4, dpi = 96, transport = "tcp", {
    plot.new()
    rect(0, 0, 1, 1)
  })

  frames = extract_frames(msgs)
  expect_true(length(frames) >= 1)

  frame = frames[[1]]
  expect_equal(frame$plot$device$width, 5 * 96)
  expect_equal(frame$plot$device$height, 4 * 96)
  expect_equal(frame$plot$device$dpi, 96)
})

test_that("TCP: metrics round-trip for text", {
  msgs = with_mock_jgd(transport = "tcp", {
    plot.new()
    text(0.5, 0.5, "tcp test")
  })

  metrics_msgs = Filter(
    function(m) identical(m$type, "metrics_request"),
    msgs
  )
  expect_true(length(metrics_msgs) >= 1)
})

test_that("TCP: multiple op types", {
  msgs = with_mock_jgd(transport = "tcp", {
    plot.new()
    rect(0.2, 0.2, 0.8, 0.8, col = "red")
    text(0.5, 0.5, "hello")
    lines(c(0.2, 0.8), c(0.3, 0.7))
  })

  ops = extract_ops(msgs)
  op_types = unique(vapply(ops, function(o) o$op, character(1)))
  expect_true("rect" %in% op_types)
  expect_true("text" %in% op_types)
  expect_true("polyline" %in% op_types)
})

test_that("TCP: gc fields match unix transport", {
  msgs = with_mock_jgd(transport = "tcp", {
    plot.new()
    rect(0, 0, 1, 1, col = "red", border = "blue", lwd = 2)
  })

  rect_ops = extract_ops_by_type(msgs, "rect")
  gc = rect_ops[[1]]$gc
  expect_true(!is.null(gc))
  expect_true(!is.null(gc$col))
  expect_true(!is.null(gc$fill))
  expect_true(!is.null(gc$lwd))
  expect_true(!is.null(gc$font))
})
