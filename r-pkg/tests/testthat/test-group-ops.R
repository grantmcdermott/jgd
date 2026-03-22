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

test_that("group ops errors when no jgd device is active", {
  graphics.off()
  expect_error(jgd_begin_group('{"opacity":0.5}'))
  expect_error(jgd_end_group())
})
