# jgd — Project Status

## Date: 2026-02-26

## Overview

**jgd** (JSON Graphics Device) is a lightweight R graphics device that
serializes plotting operations to JSON and streams them to an external
renderer. Pure C, zero dependencies. Two frontends exist: a VS Code
extension and a standalone Deno server with browser UI.

## Architecture

```
R Process (jgd R package, pure C)
  DevDesc callbacks → JSON serializer → socket/pipe client
    ↕ NDJSON over Unix socket / named pipe / TCP
Frontend (VS Code extension OR Deno server)
  Listener → Plot history → Canvas2D renderer (webview / browser)
```

### Protocol

- Transport: Unix domain sockets (macOS/Linux), named pipes (Windows default), TCP (all platforms)
- Framing: NDJSON (newline-delimited JSON)
- Message types: `frame`, `metrics_request`, `metrics_response`, `resize`, `close`, `server_info`
- Handshake: server sends `server_info` + initial `resize` on first message from R (deferred welcome)

## Components

### R package (`r-pkg/`)
- `device.c` — DevDesc setup and registration
- `callbacks.c` — All graphics primitives (line, rect, text, polygon, path, raster, etc.)
- `display_list.c` — Page state and JSON frame serialization
- `json_writer.c` — Streaming JSON builder
- `transport.c` — Socket/pipe/TCP client + discovery
- `metrics.c` — Font metrics (approximation + synchronous round-trip to frontend with caching)
- `color.c` — R color → CSS rgba()
- `png_encoder.c` — Minimal uncompressed PNG encoder + base64
- `init.c` — .Call registration

### Deno server (`server/`)
- `main.ts` — CLI entry, accepts connections via Unix socket, named pipe, or TCP
- `hub.ts` — Routes messages between R sessions and browser clients
- `r_session.ts` — Per-connection NDJSON parsing and write-back
- `named_pipe.ts` — Windows named pipe support
- `websocket.ts` / `static.ts` / `web_assets.ts` — HTTP/WebSocket for browser frontend
- `discovery.ts` — Socket path discovery

### VS Code extension (`vscode-ext/`)
- `extension.ts` — Activation, commands, `JGD_SOCKET` env var injection
- `socket-server.ts` — Socket server + NDJSON framing + per-session resize state
- `webview-provider.ts` — Webview panel + Canvas2D renderer
- `plot-history.ts` — Per-session plot history with back/forward navigation

## What Works
- Base graphics, ggplot2, tinyplot, lattice
- Plot history with back/forward navigation
- Incremental updates (plot + lines = one history entry)
- Text metrics via synchronous round-trip to frontend (cached)
- Live resize via task callback + GEplayDisplayList
- Export: PNG and SVG with custom dimensions
- Auto-discovery: `JGD_SOCKET` env var + `jgd-discovery.json` file
- Cross-platform: Unix sockets (macOS/Linux), named pipes (Windows), TCP (all)
- Delta encoding for incremental frames
- Deferred welcome handshake (server_info + resize on first R message)
- Resize-after-delete guard (latestDeleted flag prevents deleted plots from resurrecting)

## Build Commands

```bash
# R package (from repo root)
cd r-pkg && R CMD build . && R CMD INSTALL jgd_0.0.1.tar.gz && cd ..

# VS Code extension — build, package, install
cd vscode-ext && npm install && npm run compile \
  && npx vsce package \
  && code --install-extension jgd-vscode-0.0.1.vsix \
  && cd ..

# VS Code extension — tests
cd vscode-ext && npx vitest run && cd ..

# Deno server
cd server && deno task start

# Deno server — tests
cd server && deno task test
```

## Test Sequence

```r
library(jgd); jgd()
plot(1:10)
lines(1:10, col = "red", lwd = 3)
hist(rnorm(1000), col = "steelblue")
plot(cars); abline(lm(dist ~ speed, data = cars), col = "red", lwd = 2)
library(ggplot2)
ggplot(mtcars, aes(wt, mpg)) + geom_point(aes(color = factor(cyl))) + theme_minimal()
# Back/forward should cycle through plots
# Resize panel — plot should re-render at new dimensions
# Delete latest plot, resize — deleted plot should NOT reappear
```

## Key Design Decisions
- Pure C, no C++ — compiles anywhere R does
- No y-flip: R device coords are top-left origin (same as Canvas2D)
- JSON null for transparent colors
- Incremental vs commit: `mode(0)` sends `incremental: true`, `newPage` sends new frame
- Deferred + live resize: pending dimensions applied on next newPage or via GEplayDisplayList
- Frontend-agnostic: any NDJSON client can render the plots
- `latestDeleted` flag in PlotHistory prevents resize from resurrecting deleted plots

## Known Limitations
- No PDF export (use SVG → external converter)
- Surviving plot doesn't re-render after deleting latest and resizing (follow-up needed)
- Protocol not yet stabilized

## Roadmap
- [ ] Protocol stabilization and documentation
- [ ] CRAN submission
- [ ] R extension integration (if upstream agrees)
