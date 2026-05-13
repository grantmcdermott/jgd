# E2E Tests

End-to-end tests for jgd. Tests that require a missing tool are automatically
skipped.

## Prerequisites

- **R** with the jgd package installed:
- **Deno** v2.x
- **arf** v0.3.0+ — required for browser↔R interaction tests

## Running Tests

```sh
deno task test
```
