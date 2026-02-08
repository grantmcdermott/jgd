# jgd — Project Status

## Date: 2026-02-08

## What Works
- **Full rendering pipeline**: R → C device → JSON/NDJSON → Unix socket → VS Code extension → Canvas2D webview
- **Base graphics**: plot, hist, lines, points, text, abline, polygon, polyline, rect, circle, path, raster
- **ggplot2**: Full support (no-op stubs for pattern/mask/group callbacks prevent segfaults)
- **Plot history**: Back/forward navigation, ◀ ▶ buttons side by side
- **Incremental updates**: `plot()` + `lines()` = 1 history entry (mode(0) sends incremental, newPage commits)
- **No duplicate plots on close**: `last_flushed_ops` tracking prevents double-flush
- **Auto-discovery**: `JGD_SOCKET` env var injected into VS Code terminals via `environmentVariableCollection`
- **Discovery file**: Written to `os.tmpdir()`, `/tmp/`, and `/private/tmp/`
- **Deferred resize**: Panel dimensions stored as pending, applied on next `newPage` so next plot uses current panel size
- **Live resize**: Task callback (`addTaskCallback`) polls for pending resize and calls `GEplayDisplayList()` when R is idle, re-rendering the current plot at new dimensions with proper layout reflow. Uses `later` package (soft dependency) for automatic 200ms polling when available; falls back to task callback otherwise.
- **Text rotation**: Works correctly
- **Transparent colors**: JSON null handled properly (C writes null, JS checks `!= null`)
- **Clip regions**: save/restore stack correct with base y-flip-free transform
- **Raster positioning**: Correct handling of negative width/height from R's raster callback, synchronous image decode to preserve clip/transform state
- **Text metrics from webview**: Synchronous round-trip to measure text in the webview's Canvas2D context for accurate label positioning. Cached (512-entry hash map) to avoid repeated round-trips. Falls back to approximation when not connected.
- **Stale socket fallback**: If `JGD_SOCKET` env var points to a dead socket (e.g. restored terminal), automatically retries via discovery file
- **Export**: PNG (canvas.toBlob) and SVG (ops-to-SVG serializer) export from toolbar dropdown
- **Discovery file reliability**: Extension writes to `os.tmpdir()`, `/tmp/`, and `/private/tmp/`; C side checks `TMPDIR`, `TMP`, `/tmp`. Combined with stale socket fallback, discovery works across TMPDIR mismatches.
- **R 4.1+ compatibility**: No-op stubs for setPattern, setMask, setClipPath, defineGroup, etc.

## Rename: vscgd → jgd
- Package renamed from `vscgd` to `jgd` (JSON Graphics Device) to reflect frontend-agnostic design
- All C symbols, R functions, env vars, discovery files updated
- VS Code extension commands/config updated from `vscgd.*` to `jgd.*`

## Known Issues / TODO

### High Priority
1. **Terminal env var race (mitigated)**: `environmentVariableCollection` only applies to newly opened terminals. Restored terminals keep stale socket paths. Now mitigated: if the env var socket fails, the C code retries via discovery file automatically. Users should rarely need to open a fresh terminal.

### Medium Priority
3. **Windows support**: Currently Unix domain sockets only. Need named pipes or TCP for Windows.
4. **Multiple device support**: Currently one device at a time.

## Build Commands
```bash
# R package
cd r-pkg && R CMD build . && R CMD INSTALL jgd_0.0.1.tar.gz && cd ..

# VS Code extension
cd vscode-extension && npm install && npm run compile && cd ..

# Dev launch
cd vscode-extension && code --extensionDevelopmentPath="$(pwd)" && cd ..
```

## Test Sequence
```r
# In a fresh terminal inside dev VS Code:
library(jgd); jgd()
plot(1:10)
lines(1:10, col = "red", lwd = 3)       # should update same plot
hist(rnorm(1000), col = "steelblue")     # new plot in history
plot(cars); abline(lm(dist ~ speed, data = cars), col = "red", lwd = 2)
library(ggplot2)
ggplot(mtcars, aes(wt, mpg)) + geom_point(aes(color = factor(cyl))) + theme_minimal()
# Back/forward should cycle through 4 plots
# Resize the panel, then type 1+1 — plot should re-render at new dimensions
```

## Key Architecture Decisions
- **No y-flip**: R device coords are top-left origin (same as Canvas2D). No transform needed.
- **JSON null for transparent**: C writes `null`, JS checks `!= null` (not string `'null'`).
- **Incremental vs commit**: `mode(0)` sends `incremental: true` (replaces current in history). `newPage` sends `incremental: false` (adds new entry). `close` only sends if unsent ops exist.
- **Deferred + live resize**: Resize dimensions stored in `pending_w`/`pending_h`. Applied either on next `newPage` (deferred) or via task callback + `GEplayDisplayList()` (live, when R is idle).
- **deviceVersion = 0**: Tells R we're a basic device. Combined with no-op stubs for all R 4.1+ callbacks.
- **Frontend-agnostic**: Package renamed to `jgd` (JSON Graphics Device). The R package is a pure C recorder with no rendering — any NDJSON client can render the plots.
