## Resubmission notes

This is a resubmission addressing reviewer feedback from our previous `jgd`
submission (jgd_0.1.0, 2026-04-25):

- Authors@R: Added Dave Gamble and cJSON contributors with `cph` roles
  to properly attribute the vendored cJSON library (`src/cjson/`).
  Copyright and license details remain recorded in `inst/COPYRIGHTS`
  and the upstream headers are preserved in the vendored source files.

## Test environments

- macOS Tahoe 26.4 (aarch64), R 4.5.3
- Windows Server 2022 (x86_64), R 4.5.3 (win-builder)
- Windows Server 2022 (x86_64), R-devel (win-builder)
- GitHub Actions: Ubuntu (R-devel, R 4.1), Windows (R 4.1), macOS (R-release)

## R CMD check results

0 errors | 0 warnings | 1 note

- NOTE: New submission.

## Additional notes

- This package contains compiled C code with no external library
  dependencies. The only vendored code is cJSON (`src/cjson/`), which is
  MIT-licensed; its copyright and license details are recorded in
  `inst/COPYRIGHTS` and the upstream headers are preserved in the
  vendored source files. cJSON has been patched to replace `sprintf`
  with `snprintf` for CRAN compliance; all upstream diagnostic-suppression
  pragmas have been removed (patches tracked in `src/cjson/patches/`).
- All examples are wrapped in `\dontrun{}` because the device requires a
  running external renderer (e.g., a VS Code extension or browser-based
  server) to function.
