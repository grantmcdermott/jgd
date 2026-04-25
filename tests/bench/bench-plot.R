# bench-plot.R — Benchmark R graphics device performance.
#
# Compares jgd against ragg and base png for common plot operations.
# Outputs results as JSON for machine-readable consumption.
#
# Usage:
#   Rscript bench-plot.R                 # uses jgd discovery
#   JGD_BENCH_SOCKET=... Rscript bench-plot.R  # explicit socket

# Accept socket address via environment variable (set by run.ts)
.jgd_bench_socket = Sys.getenv("JGD_BENCH_SOCKET", "")
if (nzchar(.jgd_bench_socket)) {
  options(jgd.socket = .jgd_bench_socket)
}

set.seed(42)
hist_data = rnorm(1000)

step_log = function(msg) {
  cat(sprintf("[bench-step] %s | %s\n", format(Sys.time(), "%Y-%m-%d %H:%M:%S"), msg))
  flush.console()
}

bench = function(label, expr_fn, times = 1L) {
  step_log(sprintf("BEGIN %s", label))
  timings = numeric(times)
  for (i in seq_len(times)) {
    t0 = proc.time()
    expr_fn()
    t1 = proc.time()
    timings[i] = (t1 - t0)[["elapsed"]]
  }
  step_log(sprintf("END %s (median=%.3fs)", label, median(timings)))
  list(label = label, elapsed = median(timings), timings = timings)
}

results = list()

# --- jgd benchmarks ---
step_log("SECTION jgd: start")
if (requireNamespace("jgd", quietly = TRUE)) {
  library(jgd)
  # jgd discovers the socket via options(jgd.socket=...) or discovery file
  run_jgd_bench = function(label, plot_fn) {
    step_log(sprintf("jgd() open device for %s", label))
    jgd()
    on.exit(dev.off(), add = TRUE)
    bench(paste0("jgd:", label), plot_fn)
  }

  results = c(results, list(
    run_jgd_bench("plot(1:10)", function() plot(1:10, main = "Benchmark")),
    run_jgd_bench("plot(mtcars)", function() plot(mtcars)),
    run_jgd_bench("hist(rnorm(1000))", function() hist(hist_data, main = "Benchmark"))
  ))
  step_log("SECTION jgd: done")
} else {
  message("jgd package not installed, skipping")
  step_log("SECTION jgd: skipped")
}

# --- ragg benchmarks ---
step_log("SECTION ragg: start")
if (requireNamespace("ragg", quietly = TRUE)) {
  library(ragg)

  run_ragg_bench = function(label, plot_fn) {
    f = tempfile(fileext = ".png")
    agg_png(f, width = 800, height = 600)
    on.exit(dev.off(), add = TRUE)
    on.exit(unlink(f), add = TRUE)
    bench(paste0("ragg:", label), plot_fn)
  }

  results = c(results, list(
    run_ragg_bench("plot(1:10)", function() plot(1:10, main = "Benchmark")),
    run_ragg_bench("plot(mtcars)", function() plot(mtcars)),
    run_ragg_bench("hist(rnorm(1000))", function() hist(hist_data, main = "Benchmark"))
  ))
  step_log("SECTION ragg: done")
} else {
  message("ragg package not installed, skipping")
  step_log("SECTION ragg: skipped")
}

# --- base png benchmarks ---
step_log("SECTION png: start")
run_png_bench = function(label, plot_fn) {
  f = tempfile(fileext = ".png")
  png(f, width = 800, height = 600)
  on.exit(dev.off(), add = TRUE)
  on.exit(unlink(f), add = TRUE)
  bench(paste0("png:", label), plot_fn)
}

results = c(results, list(
  run_png_bench("plot(1:10)", function() plot(1:10, main = "Benchmark")),
  run_png_bench("plot(mtcars)", function() plot(mtcars)),
  run_png_bench("hist(rnorm(1000))", function() hist(hist_data, main = "Benchmark"))
))
step_log("SECTION png: done")

# --- Output ---
step_log("OUTPUT: rendering summary")
cat("\n=== Benchmark Results ===\n")
for (r in results) {
  cat(sprintf("  %-30s  %.3fs\n", r$label, r$elapsed))
}

# JSON output for programmatic use
json_results = lapply(results, function(r) {
  list(label = r$label, elapsed = r$elapsed)
})
json_str = paste0(
  "[",
  paste(
    vapply(json_results, function(x) {
      sprintf('{"label":"%s","elapsed":%.4f}', x$label, x$elapsed)
    }, character(1)),
    collapse = ","
  ),
  "]"
)
cat("\n=== JSON ===\n")
cat(json_str, "\n")
step_log("OUTPUT: done")
