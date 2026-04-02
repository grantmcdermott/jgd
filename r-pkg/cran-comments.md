## Test environments

- macOS Tahoe 26.4 (aarch64), R 4.5.3
- Windows Server 2022 (x86_64), R 4.5.3 (win-builder)
- Windows Server 2022 (x86_64), R 4.6.0 alpha (win-builder)
- GitHub Actions: Ubuntu (R-devel, R 4.1), Windows (R 4.1), macOS (R-release)

## Resubmission

Previous submission failed the Debian auto-check due to
`-Wkeyword-macro` warnings from clang 21 in vendored cJSON code.
Fixed by adding a targeted `#pragma clang diagnostic ignored` around
the `true`/`false` macro definitions.

## R CMD check results

0 errors | 0 warnings | 2 notes

- NOTE: New submission.
- NOTE: Pragma suppressing diagnostics in `src/cjson/cJSON.c`. This is
  vendored third-party code (cJSON v1.7.19, MIT licensed) included for
  JSON parsing. The pragmas are part of the upstream source, plus a
  targeted suppression of `-Wkeyword-macro` (clang 21+) for the
  `true`/`false` macro definitions that cJSON uses for C89 compatibility.

## Additional notes

- I get a "Possibly misspelled words in DESCRIPTION: `frontends` and
  `renderer`" flag in the Win-builder check, but these are false positives
  since both are used correctly in context.
- This package contains compiled C code with no external library
  dependencies. The only vendored code is cJSON (src/cjson/), which has
  been patched to replace sprintf with snprintf for CRAN compliance.
- All examples are wrapped in `\dontrun{}` because the device requires a
  running external renderer (e.g., a VS Code extension or browser-based
  server) to function.
