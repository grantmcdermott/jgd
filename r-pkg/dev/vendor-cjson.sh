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

  # Insert modification notice after the license header.
  # Uses a temp file instead of sed -i for macOS/BSD compatibility.
  CJSON_FILE="${DEST}/cJSON.c"
  sed '/^\/\* JSON parser in C\. \*\/$/a\
/* Local modifications (applied automatically by dev/vendor-cjson.sh):\
 * - All sprintf calls replaced with snprintf for R CRAN compliance.\
 *   See src/cjson/patches/ for details.\
 * - Suppress clang -Wkeyword-macro for true/false macro definitions\
 *   (triggered by clang 21+ which treats these as C23 keywords).\
 */' "$CJSON_FILE" > "${CJSON_FILE}.tmp" && mv "${CJSON_FILE}.tmp" "$CJSON_FILE"

  # Suppress clang -Wkeyword-macro around true/false macro definitions.
  # cJSON redefines true/false for C89 compat; clang 21+ warns because
  # these are keywords in C23.
  sed '/^\/\* define our own boolean type \*\/$/a\
#if defined(__clang__)\
#pragma clang diagnostic push\
#pragma clang diagnostic ignored "-Wkeyword-macro"\
#endif' "$CJSON_FILE" > "${CJSON_FILE}.tmp" && mv "${CJSON_FILE}.tmp" "$CJSON_FILE"

  sed '/^#define false ((cJSON_bool)0)$/a\
#if defined(__clang__)\
#pragma clang diagnostic pop\
#endif' "$CJSON_FILE" > "${CJSON_FILE}.tmp" && mv "${CJSON_FILE}.tmp" "$CJSON_FILE"
fi

echo "Vendored cJSON ${TAG} into ${DEST}"
