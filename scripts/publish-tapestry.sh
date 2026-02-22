#!/usr/bin/env bash
# Publish tapestry(s) to GitHub Pages.
# Usage: ./scripts/publish-tapestry.sh [city...]
#   No args → exports all cities in manifest
#   With args → exports only named cities
# Flags:
#   --force  Re-download all artifacts (skip cache)

set -euo pipefail
cd "$(dirname "$0")/.."

FORCE=""
CITIES=()
for arg in "$@"; do
  case "$arg" in
    --force) FORCE="--force" ;;
    *) CITIES+=("$arg") ;;
  esac
done

# If no cities specified, export all from manifest
if [ ${#CITIES[@]} -eq 0 ]; then
  CITIES=($(python3 -c "
import json
with open('docs/data/manifest.json') as f:
    for t in json.load(f):
        print(t['name'])
"))
fi

# 1. Build static site
echo "Building static site..."
npm run build:static --silent

# 2. Export each city
for city in "${CITIES[@]}"; do
  echo "Exporting ${city}..."
  npx tsx scripts/export-tapestry.ts "$city" $FORCE 2>&1 | tail -1
done

# 3. Commit and push
cd docs
if git diff --quiet && git diff --cached --quiet; then
  echo "No changes to push."
  exit 0
fi

git add -A
SUMMARY=$(git diff --cached --stat | tail -1)
git commit -m "Update tapestry: ${CITIES[*]}" --quiet
git push --quiet
echo "Pushed: ${SUMMARY}"
