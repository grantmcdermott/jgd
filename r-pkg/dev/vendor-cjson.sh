#!/usr/bin/env bash
# Download cJSON source files from a GitHub release tag.
# Usage: ./vendor-cjson.sh [TAG]
#   TAG defaults to the latest release (e.g. v1.7.18).
# Requires: gh (GitHub CLI)

set -euo pipefail

REPO="DaveGamble/cJSON"
TAG="${1:-}"
DEST="$(cd "$(dirname "$0")/../src" && pwd)/cjson"

if [ -z "$TAG" ]; then
  TAG=$(gh release view --repo "$REPO" --json tagName -q '.tagName')
  echo "Latest release: $TAG"
fi

mkdir -p "$DEST"

echo "Downloading cJSON ${TAG} ..."
gh api "repos/${REPO}/contents/cJSON.c?ref=${TAG}" -q '.content' | base64 -d > "${DEST}/cJSON.c"
gh api "repos/${REPO}/contents/cJSON.h?ref=${TAG}" -q '.content' | base64 -d > "${DEST}/cJSON.h"

echo "$TAG" > "${DEST}/VERSION"

echo "Vendored cJSON ${TAG} into ${DEST}"
