# jgd — R Plot Viewer for VS Code

Renders R graphics from the [jgd](https://github.com/grantmcdermott/jgd) device in a VS Code webview.

## Features

- Real-time plot rendering via Canvas2D
- Plot history with back/forward navigation
- Live resize when the panel changes size
- PNG and SVG export

## Usage

1. Install the jgd R package
2. Install this extension
3. Open a terminal in VS Code and run:

```r
library(jgd)
jgd()
plot(1:10)
```

## Keybindings

- `Alt+Left` — Previous plot
- `Alt+Right` — Next plot
