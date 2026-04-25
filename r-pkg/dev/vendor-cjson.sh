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

# Apply local patches required for R CRAN compliance. See patches/*.patch
# for the exact modifications (e.g. sprintf -> snprintf, clang -Wkeyword-macro
# pragmas around true/false macros).
if [ -d "$PATCHES_DIR" ]; then
  for p in "$PATCHES_DIR"/*.patch; do
    [ -f "$p" ] || continue
    echo "Applying patch: $(basename "$p")"
    patch -d "$DEST" -p1 < "$p"
  done
  # GNU patch leaves .orig backups next to patched files; remove them.
  find "$DEST" -maxdepth 1 -name '*.orig' -delete
fi

echo "Vendored cJSON ${TAG} into ${DEST}"
