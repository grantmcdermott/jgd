# bench-plot.R — Benchmark R graphics device performance.
#
# Compares jgd against ragg and base png for common plot operations.
# Outputs results as JSON for machine-readable consumption.
#
# Usage:
#   Rscript bench-plot.R                 # uses jgd discovery

set.seed(42)
hist_data = rnorm(1000)

bench = function(label, expr_fn, times = 1L) {
  timings = numeric(times)
  for (i in seq_len(times)) {
    t0 = proc.time()
    expr_fn()
    t1 = proc.time()
    timings[i] = (t1 - t0)[["elapsed"]]
  }
  list(label = label, elapsed = median(timings), timings = timings)
}

results = list()

# --- jgd benchmarks ---
if (requireNamespace("jgd", quietly = TRUE)) {
  library(jgd)
  # jgd discovers the socket via options(jgd.socket=...) or discovery file
  run_jgd_bench = function(label, plot_fn) {
    jgd()
    on.exit(dev.off(), add = TRUE)
    bench(paste0("jgd:", label), plot_fn)
  }

  results = c(results, list(
    run_jgd_bench("plot(1:10)", function() plot(1:10, main = "Benchmark")),
    run_jgd_bench("plot(mtcars)", function() plot(mtcars)),
    run_jgd_bench("hist(rnorm(1000))", function() hist(hist_data, main = "Benchmark"))
  ))
} else {
  message("jgd package not installed, skipping")
}

# --- ragg benchmarks ---
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
} else {
  message("ragg package not installed, skipping")
}

# --- base png benchmarks ---
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

# --- Output ---
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
