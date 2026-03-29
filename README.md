# jgd — JSON Graphics Device for R

<!-- badges: start -->
<a href="https://CRAN.R-project.org/package=jgd"><img src="https://www.r-pkg.org/badges/version/jgd" class="img-fluid" alt="CRAN version"></a>
<a href="https://grantmcdermott.r-universe.dev"><img src="https://grantmcdermott.r-universe.dev/badges/jgd" class="img-fluid" alt="R-universe version"></a>
<a href="https://github.com/grantmcdermott/jgd/actions/workflows/r-pkg-check.yaml"><img src="https://github.com/grantmcdermott/jgd/actions/workflows/r-pkg-check.yaml/badge.svg" class="img-fluid" alt="R CMD check"></a>
<a href="https://github.com/grantmcdermott/jgd/blob/main/r-pkg/LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-blue" class="img-fluid" alt="License"></a>
<!-- badges: end -->

**jgd** is a lightweight (C-based, zero dependency) R graphics device. It
works by serializing R plotting operations into JSON and then streaming to
an external renderer. Two renderers are currently available:

- A **VS Code extension** with an integrated plot pane
- A **standalone Deno server** for rendering inside a web browser

![Screenshot of jgd running in VS Code](jgd-ss.png)

The **jgd** protocol is designed to be frontend-agnostic. While VS Code was our
initial development focus, in principle any client able to read JSON could use
it to render R plots (e.g., Neovim, Emacs, or a custom web app).

Please note that this project has made heavy use of AI-assisted pair
programming (both Claude and Copilot). It is highly doubtful that we would have
been able to put this together without AI help.

## Installation

To run **jgd**, you need to install the R package, as well as a frontend for
displaying plots.

### R package

We plan to submit to CRAN soon. In the meantime, please install from R-universe:

```r
install.packages('jgd', repos = 'https://grantmcdermott.r-universe.dev')
```

Or, clone this repo and install locally:

```sh
git clone https://github.com/grantmcdermott/jgd.git
R CMD INSTALL r-pkg
```

### Display frontend

You have two frontend options:

#### Option 1) VS Code extension

The simplest option is to download the `.vsix` from our
[nightly release](https://github.com/grantmcdermott/jgd/releases/tag/nightly),
then install it:

```bash
curl -fsSL \
  https://github.com/grantmcdermott/jgd/releases/download/nightly/jgd-vscode-nightly.vsix \
  -o jgd-vscode-nightly.vsix
code --install-extension jgd-vscode-nightly.vsix
```

Alternatively, you can also build and install the extension from source[^1]:

```bash
cd vscode-ext && npm install && npm run compile \
  && npx @vscode/vsce@3.7.1 package \
  && code --install-extension jgd-vscode-0.0.1.vsix \
  && cd ..
```

[^1]: Requires [Node.js](https://nodejs.org/). For extension development, you can also use `code --extensionDevelopmentPath="$(pwd)"` from the `vscode-ext` directory to launch a separate dev host window.

#### Option 2) Deno server

If you're not using VS Code, our standalone Deno server provides a browser-based
renderer.
First [install Deno](https://docs.deno.com/runtime/getting_started/installation/),
then run directly (dependencies are fetched automatically):

```bash
deno run https://raw.githubusercontent.com/grantmcdermott/jgd/refs/heads/main/server/main.ts
```

Or, clone the repo and run locally:

```bash
cd server && deno task start && cd ..
```

## Use

Test your installation by running some R plotting commands, like those provided
by the script below. Note that you need to call `jgd::jgd()` first to activate
the device. The steps differ slightly depending on your chosen frontend:

- **VS Code:** Once you have installed the `jgd` extension, simply execute the
below script from an R terminal inside VS Code (either via the
[R extension](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r)
or by manually starting R inside the VS Code terminal).

- **Standalone server:** Start the Deno server, open `http://127.0.0.1:<port>/`
in your browser (the URL is printed on startup), then run the script from any
R session.

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
  theme_bw()
```

Use ◀ ▶ in the plot pane (or `Alt+Left` / `Alt+Right`) to navigate plot
history.

## Motivation

The primary motivation for this package is supporting a nicer R graphics
experience in VS Code. At present, the VS Code [R
extension](https://github.com/REditorSupport/vscode-R/wiki/Plot-viewer) provides
fairly crude "native" graphics support, since plots are displayed as PNGs. As a
result, users have for some time relied on the nice
[httpgd](https://github.com/nx10/httpgd) package for a better graphics
experience; indeed, the official R extension docs even recommend using it.
However, the `httpgd` alternative has historically been tricky to rely on
due to periodic CRAN removals and maintenance challenges. This is because it
embeds a full C++ SVG rendering stack and HTTP server inside the R process,
which is powerful but fragile. Both `httpgd` and its core
[unigd](https://github.com/nx10/unigd) dependency have been removed from CRAN
multiple times due to C++ toolchain issues (non-API entry points, compiler
compatibility failures, etc.), and while they are currently available again,
we were motivated to try a different approach. The result is **jgd**.

**jgd** doesn't render anything; it just records. All rendering happens in the client (a VS Code webview, a browser tab,
or any future frontend). Second, it is very lightweight. The core of the R
package is written in pure C with zero external dependencies. The only system
dependencies are the POSIX socket API (macOS/Linux) and Winsock (Windows),
both of which R itself already uses.

Our idea (hope) is that we can support the main features of `httpgd`, but with a
more stable and lightweight footprint. Ultimately, if the community agrees, we
might even be able to integrate this simple package into the main R extension
logic, so that we get nice graphics support in VS Code out of the box.

### What about Positron?

[Positron](https://positron.posit.co/) is a "batteries-included" fork of VS Code
by Posit PBC. It comes with many great features, including first-class support
for R (and Python) graphics. In our opinion, Positron is likely the best IDE
choice for a plurality of R users and we can happily recommend it. However, that
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
│  │                     → socket client       │──┼──┐
│  └───────────────────────────────────────────┘  │  │
└─────────────────────────────────────────────────┘  │
     Unix domain sockets (macOS/Linux),              │
     named pipes (Windows), or TCP — NDJSON          │
┌─────────────────────────────────────────────────┐  │
│  Server (Deno reference server or VS Code ext.) │◄─┘
│                                                 │
│  Listener → Plot history → Canvas2D renderer    │
│                             (browser / webview) │
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
  schema. The Deno reference server and VS Code extension are the current
  clients, but the same stream could drive a Neovim plugin or any other
  renderer.
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
- **Auto-discovery**: `JGD_SOCKET` environment variable or `discovery.json`
  file for automatic connection
- **Export**: PNG and SVG from the toolbar dropdown, with custom dimensions
  (inches + DPI)
- **Cross-platform**: Unix domain sockets on macOS/Linux, named pipes on
  Windows (default), TCP on all platforms
- **Reference server**: Deno-based server with browser frontend over
  HTTP/WebSocket
- **Extended graphics context** (experimental): Blend modes, opacity, shadows,
  and CSS filters via `jgd_ext()`
- **Drawing groups** (experimental): Group drawing operations and apply
  per-group effects via `jgd_begin_group()` / `jgd_end_group()`
- **Frame-level extensions** (experimental): Frame-wide properties such as
  post-processing effects via `jgd_frame_ext()`

## Extended graphics context (experimental)

R's standard graphics parameters (colors, line width, font, etc.) are
automatically included in every drawing operation that jgd sends to the
renderer. The **extended graphics context** (`gc.ext`) allows you to send
additional styling properties beyond what R's graphics API provides. Renderers
can use these to apply visual effects that have no R equivalent.

Because the JSON protocol is extensible, renderer implementations can define
their own extension fields. The Deno reference server and VS Code extension
currently support the fields listed below, but custom renderers could support
any fields they choose. Unknown fields are silently ignored, so extensions are
forward-compatible.

> **Note:** This API is experimental and may change in future versions.

### Supported extension fields

The Deno reference server and VS Code renderer currently support:

| Field | Canvas2D property | Example |
|-------|------------------|---------|
| `blendMode` | `globalCompositeOperation` | `"multiply"`, `"screen"`, `"lighter"` |
| `opacity` | `globalAlpha` | `0.5` |
| `shadow.blur` | `shadowBlur` | `10` |
| `shadow.color` | `shadowColor` | `"rgba(0,0,0,0.5)"` |
| `shadow.offsetX` | `shadowOffsetX` | `5` |
| `shadow.offsetY` | `shadowOffsetY` | `5` |
| `filter` | `filter` | `"blur(3px)"` |

### Usage

`jgd_ext()` accepts a JSON string and embeds it as the `ext` field in
the graphics context of every drawing operation in the current plot.
The extension applies per-plot: set it before `plot()` and it remains
active for the entire plot, including on resize. `with_jgd_ext()` provides
scoped application with automatic cleanup.

```r
library(jgd)
jgd()

# Drop shadow (scoped — automatically cleared after the block)
with_jgd_ext('{"shadow":{"blur":15,"color":"rgba(0,0,0,0.5)","offsetX":5,"offsetY":5}}', {
  plot(1:10, pch = 19, cex = 3, col = "steelblue")
})

# Semi-transparent overlay
with_jgd_ext('{"opacity":0.3}', {
  plot(1:10, pch = 19, cex = 5, col = "red")
})

# Manual set/clear (equivalent to with_jgd_ext but without scoping)
jgd_ext('{"shadow":{"blur":10,"color":"gray","offsetX":5,"offsetY":5}}')
plot(1:10, pch = 19, cex = 3, col = "steelblue")
jgd_ext(NULL)  # clear for subsequent plots
```

### Design for extension packages

`jgd_ext()` is intentionally low-level — it accepts a raw JSON string. The
JSON must be syntactically valid (it is parsed in C and invalid JSON will
error), but no higher-level or semantic validation is performed. The intent is
that higher-level packages built on top of jgd can provide user-friendly
wrappers with proper argument checking, e.g.:

```r
# Hypothetical wrapper package
jgd_blend <- function(mode = "source-over") {
  jgd_ext(jsonlite::toJSON(list(blendMode = mode), auto_unbox = TRUE))
}

jgd_shadow <- function(blur = 0, color = "black", offsetX = 0, offsetY = 0) {
  jgd_ext(jsonlite::toJSON(
    list(shadow = list(blur = blur, color = color, offsetX = offsetX, offsetY = offsetY)),
    auto_unbox = TRUE
  ))
}
```

jgd itself has no dependency on jsonlite or any serialization library —
upstream packages choose their own.

## Drawing groups (experimental)

Drawing groups let you bracket a set of drawing operations so the renderer
can apply effects to the group as a whole. Each group carries its own `ext`
fields.

> **Note:** This API is experimental and may change in future versions.

### Usage

```r
library(jgd)
jgd()

# Apply a blur filter to a group of drawing operations
plot.new()
with_jgd_group('{"filter":"blur(3px)"}', {
  rect(0.1, 0.1, 0.5, 0.5, col = "steelblue")
  rect(0.3, 0.3, 0.7, 0.7, col = "coral")
})

# Groups can be nested
plot.new()
with_jgd_group('{"opacity":0.5}', {
  rect(0.1, 0.1, 0.9, 0.9, col = "steelblue")
  with_jgd_group('{"filter":"blur(2px)"}', {
    text(0.5, 0.5, "Blurred text inside transparent group")
  })
})

# Manual begin/end (equivalent to with_jgd_group but without scoping)
plot.new()
jgd_begin_group('{"filter":"drop-shadow(5px 5px 5px gray)"}')
rect(0.2, 0.2, 0.8, 0.8, col = "steelblue")
jgd_end_group()
```

### Protocol

Group ops appear in the drawing stream as:

```json
{"op": "beginGroup", "ext": {"filter": "blur(3px)"}}
{"op": "rect", ...}
{"op": "endGroup"}
```

Groups survive resize replay via `recordGraphics()`. Unclosed groups are
automatically closed (with a warning) at page boundaries and device close.

## Frame-level extensions (experimental)

Frame-level extensions attach properties to the entire frame, independent of
individual drawing operations. This is useful for post-processing effects
that apply to the rendered image as a whole.

> **Note:** This API is experimental and may change in future versions.

### Usage

```r
library(jgd)
jgd()

# Apply post-processing effects to the entire frame
with_jgd_frame_ext('{"postEffects":[{"type":"blur","radius":2}]}', {
  plot(1:10, pch = 19, cex = 3, col = "steelblue")
})

# Frame ext and gc ext are independent — use both at once
jgd_frame_ext('{"postEffects":[{"type":"glow"}]}')
with_jgd_ext('{"opacity":0.5}', {
  plot(1:10, pch = 19, cex = 3, col = "coral")
})
jgd_frame_ext(NULL)  # clear for subsequent plots
```

### Protocol

Frame-level ext appears at the top level of the frame message:

```json
{"type": "frame", "ext": {"postEffects": [...]}, "plot": {...}}
```

Frame ext follows the same lifecycle as `gc.ext`: captured at page creation,
saved per-snapshot, and restored on plotIndex replay.

## Roadmap

- [x] **Windows support**: Named pipes (default) and TCP transport
- [x] **Browser frontend**: Deno reference server with HTTP/WebSocket renderer
- [ ] **Protocol stabilization**: Stabilize and document the NDJSON protocol
- [ ] **CRAN submission**: Package the R side for CRAN distribution
- [ ] **R extension integration**: Incorporate the code from this package into
  the main VS Code R extension (if the upstream maintainers agree).

## Limitations

- **No PDF export**: PNG and SVG export are supported. For PDF, convert the
  exported SVG using any standard tool (e.g. Inkscape, Chrome print-to-PDF).

## Project structure

| Directory | Description |
|-----------|-------------|
| `r-pkg/` | R package (pure C, zero dependencies) |
| `server/` | Deno reference server (HTTP/WebSocket renderer) |
| `vscode-ext/` | VS Code extension |
| `tests/` | End-to-end tests |

## License

MIT
