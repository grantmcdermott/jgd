## Submission notes

This is a patch release (0.1.0 -> 0.1.1). It contains internal bug fixes
and documentation updates only; there are no user-facing API changes.

- Fixed the unprotected-variable (`[UP]`) warnings reported for jgd 0.1.0
  by the CRAN `rchk` checks
  (<https://raw.githubusercontent.com/kalibera/cran-checks/master/rchk/results/jgd.out>).
  `PROTECT`/`UNPROTECT` handling has been tightened around allocating calls
  in `replay_snapshot` (`src/device.c`) and `C_jgd_discover`
  (`src/transport.c`).
- Documentation updates noting that the package's VS Code support is now
  provided by the upstream VS Code R extension.

## Test environments

- macOS (aarch64), R 4.6.1
- Win Builder (x86_64), R 4.6.1
- GitHub Actions: Ubuntu (R-devel, R 4.6.1), Windows (R 4.6.1), macOS (R-release)

## R CMD check results

0 errors | 0 warnings | 0 notes

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
