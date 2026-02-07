# vscgd — Project Status

## Date: 2026-02-06

## What Works
- **Full rendering pipeline**: R → C device → JSON/NDJSON → Unix socket → VS Code extension → Canvas2D webview
- **Base graphics**: plot, hist, lines, points, text, abline, polygon, polyline, rect, circle, path, raster
- **ggplot2**: Full support (no-op stubs for pattern/mask/group callbacks prevent segfaults)
- **Plot history**: Back/forward navigation, ◀ ▶ buttons side by side
- **Incremental updates**: `plot()` + `lines()` = 1 history entry (mode(0) sends incremental, newPage commits)
- **No duplicate plots on close**: `last_flushed_ops` tracking prevents double-flush
- **Auto-discovery**: `VSCGD_SOCKET` env var injected into VS Code terminals via `environmentVariableCollection`
- **Discovery file**: Written to `os.tmpdir()`, `/tmp/`, and `/private/tmp/`
- **Deferred resize**: Panel dimensions stored as pending, applied on next `newPage` so next plot uses current panel size
- **Text rotation**: Works correctly
- **Transparent colors**: JSON null handled properly (C writes null, JS checks `!= null`)
- **Clip regions**: save/restore stack correct with base y-flip-free transform
- **R 4.1+ compatibility**: No-op stubs for setPattern, setMask, setClipPath, defineGroup, etc.

## Known Issues / TODO

### High Priority
1. **Live resize**: Resizing the panel doesn't re-render the current plot at new dimensions. Deferred resize only applies to the *next* plot. Need `GEplayDisplayList()` triggered from R's idle loop (e.g., via `R_PolledEvents` or an R-level timer) to re-record at new size.
2. **`dev.off()` should close the device cleanly**: Currently `cb_close` runs but the webview doesn't react to the R session disconnecting. Should clear/notify the webview when the device closes.
3. **Terminal env var race**: `environmentVariableCollection` only applies to newly opened terminals. Restored terminals keep stale socket paths. Users must open a fresh terminal after extension activates.

### Medium Priority
4. **Export**: PNG/SVG/PDF export UI exists in toolbar but handlers aren't fully wired.
5. **Text metrics from webview**: Currently using approximation-based `strWidth`/`metricInfo`. Should measure in the webview via round-trip for accurate layout (especially for ggplot2 label positioning).
6. **Discovery file reliability**: The C-side discovery (`transport.c`) checks TMPDIR → TMP → /tmp. Works when env var is set, but discovery file alone may not work if TMPDIR differs between extension and R.

### Low Priority
7. **Packaging for distribution**: VSIX for extension marketplace, CRAN-ready R package structure.
8. **Windows support**: Currently Unix domain sockets only. Need named pipes or TCP for Windows.
9. **Multiple device support**: Currently one device at a time.
10. **`onDidOpenTerminal` removed**: Was sending `Sys.setenv()` to all terminals. Replaced with `environmentVariableCollection`. Verify no regressions.

## Build Commands
```bash
# R package
cd r-package && R CMD build . && R CMD INSTALL vscgd_0.0.1.tar.gz

# VS Code extension
cd vscode-extension && npm install && npm run compile

# Dev launch
cd vscode-extension && code --extensionDevelopmentPath="$(pwd)"
```

## Test Sequence
```r
# In a fresh terminal inside dev VS Code:
library(vscgd); vscgd()
plot(1:10)
lines(1:10, col = "red", lwd = 3)       # should update same plot
hist(rnorm(1000), col = "steelblue")     # new plot in history
plot(cars); abline(lm(dist ~ speed, data = cars), col = "red", lwd = 2)
library(ggplot2)
ggplot(mtcars, aes(wt, mpg)) + geom_point(aes(color = factor(cyl))) + theme_minimal()
# Back/forward should cycle through 4 plots
```

## Key Architecture Decisions
- **No y-flip**: R device coords are top-left origin (same as Canvas2D). No transform needed.
- **JSON null for transparent**: C writes `null`, JS checks `!= null` (not string `'null'`).
- **Incremental vs commit**: `mode(0)` sends `incremental: true` (replaces current in history). `newPage` sends `incremental: false` (adds new entry). `close` only sends if unsent ops exist.
- **Deferred resize**: Resize dimensions stored in `pending_w`/`pending_h`, applied in `cb_newPage`.
- **deviceVersion = 0**: Tells R we're a basic device. Combined with no-op stubs for all R 4.1+ callbacks.
