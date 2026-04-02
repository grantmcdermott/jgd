#!/usr/bin/env bash
# Download cJSON source files from a GitHub release tag.
# Usage: ./vendor-cjson.sh [TAG]
#   TAG defaults to the latest release (e.g. v1.7.18).
# Requires: gh (GitHub CLI)

set -euo pipefail

REPO="DaveGamble/cJSON"
TAG="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="$(cd "${SCRIPT_DIR}/../src" && pwd)/cjson"
PATCHES_DIR="${DEST}/patches"

if [ -z "$TAG" ]; then
  TAG=$(gh release view --repo "$REPO" --json tagName -q '.tagName')
  echo "Latest release: $TAG"
fi

mkdir -p "$DEST"

echo "Downloading cJSON ${TAG} ..."
gh api "repos/${REPO}/contents/cJSON.c?ref=${TAG}" -q '.content' | base64 -d > "${DEST}/cJSON.c"
gh api "repos/${REPO}/contents/cJSON.h?ref=${TAG}" -q '.content' | base64 -d > "${DEST}/cJSON.h"

echo "$TAG" > "${DEST}/VERSION"

# Apply local patches required for R CRAN compliance
if [ -d "$PATCHES_DIR" ]; then
  for p in "$PATCHES_DIR"/*.patch; do
    [ -f "$p" ] || continue
    echo "Applying patch: $(basename "$p")"
    patch -d "$DEST" -p1 < "$p"
  done

  # Insert modification notice and suppress clang -Wkeyword-macro around
  # true/false macro definitions (clang 21+ treats these as C23 keywords).
  # Single awk pass instead of multiple sed invocations for portability.
  CJSON_FILE="${DEST}/cJSON.c"
  awk '
    /^\/\* JSON parser in C\. \*\/$/ {
      print
      print "/* Local modifications (applied automatically by dev/vendor-cjson.sh):"
      print " * - All sprintf calls replaced with snprintf for R CRAN compliance."
      print " *   See src/cjson/patches/ for details."
      print " * - Suppress clang -Wkeyword-macro for true/false macro definitions"
      print " *   (triggered by clang 21+ which treats these as C23 keywords)."
      print " */"
      next
    }
    /^\/\* define our own boolean type \*\/$/ {
      print
      print "#if defined(__clang__)"
      print "#pragma clang diagnostic push"
      print "#pragma clang diagnostic ignored \"-Wkeyword-macro\""
      print "#endif"
      next
    }
    /^#define false \(\(cJSON_bool\)0\)$/ {
      print
      print "#if defined(__clang__)"
      print "#pragma clang diagnostic pop"
      print "#endif"
      next
    }
    { print }
  ' "$CJSON_FILE" > "${CJSON_FILE}.tmp" && mv "${CJSON_FILE}.tmp" "$CJSON_FILE"
fi

echo "Vendored cJSON ${TAG} into ${DEST}"
