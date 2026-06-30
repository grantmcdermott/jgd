# jgd 0.1.1

## Internals

- Fixed potential GC protection issues in the C internals (flagged by
  `rchk`) by tightening `PROTECT`/`UNPROTECT` handling around allocations
  in `replay_snapshot` and `C_jgd_discover`. (#61)

## Documentation

- Improved visibility of protocol specification. (#58)
- Minor documentation updates reflecting the fact that our VS Code
  functionality has been absorbed into the main/upstream VS Code R extension.
  (<https://github.com/REditorSupport/vscode-R/pull/1706>).

# jgd 0.1.0

Initial CRAN release.

- C-based graphics device that serializes R plotting operations to JSON
  (JSONL) and streams them over a local connection to an external renderer.
- Transport support for Unix domain sockets (Linux/macOS), Windows named
  pipes, and TCP.
- Automatic server discovery via platform-specific cache directory.
- Remote font metrics: the device queries the renderer for string widths
  and glyph metrics, enabling accurate text layout without local font
  dependencies.
- Plot history with resize replay: snapshots are captured per page so
  historical plots can be re-rendered at new dimensions.
- Experimental extension API (`jgd_ext()`, `jgd_frame_ext()`,
  `jgd_begin_group()`) for injecting renderer-specific properties beyond
  R's standard graphics parameters.
- Bundled cJSON (v1.7.19) for zero external dependencies.
