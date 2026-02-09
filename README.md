# jgd — JSON Graphics Device for R

![Experimental](https://img.shields.io/badge/status-experimental-orange)

**jgd** is a lightweight (zero dependency) R graphics device that serializes
every R plotting operation as JSON and streams it over a Unix domain socket to
an external renderer. The main applicaton today is a VS Code extension that
offers nice R graphics display and UX features, as per this screenshot:

![Screenshot of jgd running in VS Code](jgd-ss.png)

But the **jgd** protocol is designed to be frontend-agnostic. In principle, any
client able to read (newline-delimited) JSON could use it to render R plots.

**Caveats:** The package is experimental and may have some rough edges, despite
my best efforts at thorough local testing. More importantly, it only supports
unix-based systems (MacOS/Linux) at present. I hope to provide Windows support
soon, but will need external help with testing and validation. Finally, I want
to be transparent that this project has made _heavy_ use of AI-assisted pair
programming (Claude). It is highly doubtful that I would have been able to put
this together without AI help.

## Installation

At present, **jgd** comprises two parts: an R package and a VS Code (VSIX)
extension. To install these two components, first clone this repo to your local
system.

```bash
git clone https://github.com/grantmcdermott/jgd.git
cd jgd
```

### R package

```bash
## Build from local source
cd r-pkg && R CMD build . && R CMD INSTALL jgd_0.0.1.tar.gz && cd ..

## Or, install from GitHub (run in your R Console)
# remotes::install_github("grantmcdermott/jgd", subdir = "r-pkg")
```

### VS Code extension

```bash
## Install from local .vsix file
code --install-extension vscode-ext/jgd-vscode-0.0.1.vsix

## Or build for local development
# cd vscode-ext && npm install && npm run compile
# code --extensionDevelopmentPath="$(pwd)" && cd ..
```

## Usage

Assuming that you already have the main [R
extension](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r),
simply run the following script from VS Code. (If you don't have the extension,
open up a terminal inside VS Code, start R, and then copy the code across
manually.) You should see the same output as shown in the screenshot at the top
of this README.

```r
library(jgd)
jgd()

# Base graphics
plot(1:10)
lines(1:10, col = "red", lwd = 3)
hist(rnorm(1000), col = "steelblue")
plot(cars)
abline(lm(dist ~ speed, data = cars), col = "red", lwd = 2)

# tinyplot
library(tinyplot)
plt(bill_dep ~ bill_len | body_mass, facet = ~island,
    data = penguins, theme = "clean")

# ggplot2
library(ggplot2)
ggplot(penguins, aes(bill_len, bill_dep, col = species)) +
  geom_point() +
  facet_wrap(~island) +
  theme_minimal()
```

Use ◀ ▶ in the plot pane (or `Alt+Left` / `Alt+Right`) to navigate plot
history.

## Motivation

The primary motivation for this package is supporting a nicer R graphics
experience in VS Code. At present, the VS Code [R
extension](https://github.com/REditorSupport/vscode-R/wiki/Plot-viewer) provides
fairly crude "native" graphics support, since plots are displayed at PNGs. As a
result, users have for some time relied on the nice
[httpgd](https://github.com/nx10/httpgd) package for a better graphics
experience; indeed, the official R extension docs even recommend using it.
However, the `httpgd` alternative has become increasingly tricky to work with
due to repeated CRAN removals and lack of maintenance bandwidth. In brief, this
is because it embeds a full C++ SVG rendering stack and HTTP server inside the R
process, which is powerful but fragile. At the time of writing, both `httpgd`
and its core [unigd](https://github.com/nx10/unigd) dependency are unavailable
on CRAN due to a variety of C++ toolchain issues: non-API entry points, compiler
compatibility failures, etc. (See
[here](https://cran-archive.r-project.org/web/checks/2025/2025-04-23_check_results_httpgd.html)
and
[here](https://cran-archive.r-project.org/web/checks/2026/2026-02-06_check_results_unigd.html)).

**jgd** takes a different approach: _the R package is pure C with zero external
dependencies_. It doesn't render anything; it records. All rendering happens in
the client (a VS Code webview, a browser tab, or any future frontend). The only
system dependency is the POSIX socket API, which R itself already uses. My idea
(hope) is that we can support the main features of `httpgd`, but with a more
stable and lightweight footprint.

### What about Positron?

[Positron](https://positron.posit.co/) is a "batteries-included" fork of VS Code
by Posit PBC. It comes with many great features, including first-class support
for R (and Python) graphics. In my opinion, Positron is likely the best IDE
choice for a plurality of R users and I can happily recommend it. However, that
still leaves a non-trivial share of R users and use-cases, where a good "base"
VS Code R experience is still needed. **jgd** is aimed at supporting these
latter cases.

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
- **Export**: PNG and SVG from the toolbar dropdown

## Roadmap

- [ ] **Windows support**: TCP transport as alternative to Unix domain sockets
- [ ] **Browser frontend**: Standalone renderer served over HTTP/WebSocket for
  use with Neovim, Emacs, or terminal R
- [ ] **CRAN submission**: Package the R side for CRAN distribution
- [ ] **R extension integration**: Incorporate the code from this package into
  the main VS Code R extension (if the upstream maintainers agree).

## Limitations

- **No PDF export**: PNG and SVG export are supported. For PDF, convert the
  exported SVG using any standard tool (e.g. Inkscape, Chrome print-to-PDF).
- **No Windows support (yet)**: Currently relies on Unix domain sockets (macOS
  and Linux only). TCP transport for Windows is planned.

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

vscode-ext/
├── jgd-vscode.vsix
├── package.json
└── src/
    ├── extension.ts       # Activation, commands, env var injection
    ├── socket-server.ts   # Unix socket server + NDJSON framing
    ├── webview-provider.ts # Webview panel + Canvas2D renderer
    └── plot-history.ts    # Per-session plot history management
```

## License

MIT
