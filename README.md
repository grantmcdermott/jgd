# jgd — JSON Graphics Device for R

**jgd** is a lightweight R graphics device that serializes every R plotting
operation as JSON and streams it over a Unix domain socket to an external
renderer. The primary renderer today is a VS Code extension that replays the
operations onto an HTML Canvas2D surface, but the protocol is
frontend-agnostic — any client that can read newline-delimited JSON can render
R plots.

## Motivation

The [httpgd](https://github.com/nx10/httpgd) and
[unigd](https://github.com/nx10/unigd) packages have been repeatedly removed
from CRAN due to C++ toolchain issues: non-API entry points, compiler
compatibility failures, and unmaintained upstream dependencies (Boost.Asio,
cpp-httplib, libfmt, etc.). These packages embedded a full C++ SVG rendering
stack and HTTP server inside the R process, which made them powerful but
fragile.

jgd takes a different approach: **the R package is pure C with zero external
dependencies**. It doesn't render anything — it records. All rendering happens
in the client (a VS Code webview, a browser tab, or any future frontend). The
only system dependency is the POSIX socket API, which R itself already uses.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  R Process                                      │
│                                                 │
│  jgd R package (pure C)                         │
│  ┌───────────────────────────────────────────┐  │
│  │ DevDesc callbacks → JSON serializer       │  │
│  │                     → Unix socket client  │──┼──┐
│  └───────────────────────────────────────────┘  │  │
└─────────────────────────────────────────────────┘  │
          Unix domain socket (NDJSON)                │
┌─────────────────────────────────────────────────┐  │
│  Renderer (e.g. VS Code extension)              │◄─┘
│                                                 │
│  Socket server → Plot history → Canvas2D webview│
└─────────────────────────────────────────────────┘
```

The R package hooks into R's graphics engine via the standard `DevDesc`
callback interface. Every primitive — lines, rectangles, circles, polygons,
text, paths, raster images, clipping regions — is captured as a JSON object
and streamed over the socket. The renderer replays these operations faithfully
using the browser's Canvas2D API.

### Design principles

- **Pure C, no C++ dependencies.** The R package compiles with `R CMD INSTALL`
  on any platform R supports. No Boost, no fmt, no Asio, no system graphics
  libraries.
- **Frontend-agnostic protocol.** The JSON ops format is a simple, versioned
  schema. The VS Code extension is the primary client, but the same stream
  could drive a browser tab, a Neovim plugin, or any other renderer.
- **Incremental updates.** Adding a line to an existing plot sends only the new
  operations, not the entire plot. The renderer appends to the current frame.
- **Client-side scaling.** The renderer can replay the same operations at any
  resolution without round-tripping to R, enabling instant resize feedback.

## What works

- **Base graphics**: `plot()`, `hist()`, `lines()`, `points()`, `text()`,
  `abline()`, `polygon()`, `polyline()`, `rect()`, `image()`, `path()`
- **ggplot2**: Full support via no-op stubs for R 4.1+ pattern/mask/group
  callbacks
- **Plot history**: Back/forward navigation with ◀ ▶ buttons
- **Incremental updates**: `plot()` + `lines()` = one history entry
- **Text rotation**, **transparent colors**, **clip regions**, **line types**,
  **raster images** (base64-encoded PNG)
- **Auto-discovery**: `JGD_SOCKET` environment variable injected into VS Code
  terminals

## Installation

### R package

```r
# From GitHub
remotes::install_github("grantmcdermott/jgd", subdir = "r-pkg")

# Or from source
# cd r-pkg && R CMD build . && R CMD INSTALL jgd_0.0.1.tar.gz && cd ..
```

### VS Code extension

```bash
# Install from .vsix
code --install-extension jgd-vscode-0.0.1.vsix

# Or for development
cd vscode-extension
npm install
npm run compile
code --extensionDevelopmentPath="$(pwd)"
cd ..
```

## Usage

In a terminal inside the VS Code development host:

```r
library(jgd)
jgd()

# Base graphics
plot(1:10)
lines(1:10, col = "red", lwd = 3)
hist(rnorm(1000), col = "steelblue")
plot(cars)
abline(lm(dist ~ speed, data = cars), col = "red", lwd = 2)

# ggplot2
library(ggplot2)
ggplot(mtcars, aes(wt, mpg)) +
  geom_point(aes(color = factor(cyl))) +
  theme_minimal()
```

Use ◀ ▶ in the plot pane (or `Alt+Left` / `Alt+Right`) to navigate plot
history.

## Roadmap

- [ ] **Live resize**: Replay R's display list at new dimensions when the panel
  resizes (currently deferred to next plot)
- [ ] **Accurate text metrics**: Round-trip measurement via the webview for
  precise label positioning (currently approximation-based)
- [ ] **Windows support**: TCP transport as alternative to Unix domain sockets
- [ ] **Browser frontend**: Standalone renderer served over HTTP/WebSocket for
  use with Neovim, Emacs, or terminal R
- [ ] **Export**: PNG export from canvas (wired), SVG/PDF export (planned)
- [ ] **CRAN submission**: Package the R side for CRAN distribution

## Project structure

```
r-pkg/
├── DESCRIPTION
├── NAMESPACE
├── R/
│   ├── device.R          # R wrapper: jgd()
│   └── zzz.R             # .onLoad
└── src/
    ├── device.c           # DevDesc setup and registration
    ├── callbacks.c        # All graphics callbacks (line, rect, text, ...)
    ├── display_list.c     # Page state and JSON frame serialization
    ├── json_writer.c      # Streaming JSON builder (no dependencies)
    ├── transport.c        # Unix socket client + discovery
    ├── metrics.c          # Approximation-based font metrics
    ├── color.c            # R color → CSS rgba() conversion
    ├── png_encoder.c      # Minimal uncompressed PNG encoder + base64
    └── init.c             # .Call registration

vscode-extension/
├── package.json
└── src/
    ├── extension.ts       # Activation, commands, env var injection
    ├── socket-server.ts   # Unix socket server + NDJSON framing
    ├── webview-provider.ts # Webview panel + Canvas2D renderer
    └── plot-history.ts    # Per-session plot history management
```

## License

MIT
