#!/usr/bin/env bash
# Vendor the grid libraries and the API spec from the crossword web app.
#
# Pattern generation, symmetry, grid numbering, `.puz` encoding, the alphabet
# tables and the public grid codec are the web constructor's own code. They
# live in the (private) crossword repo and are copied here rather than
# reimplemented, so the SDK and the web app agree on every grid byte-for-byte.
#
#   scripts/sync-upstream.sh          copy upstream → lib/ and openapi.yaml
#   scripts/sync-upstream.sh --check  exit 1 if anything here has drifted
#
# `prepublishOnly` runs the check so a release can't ship stale copies. Edit
# these files upstream, never here — the next sync would overwrite them.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
upstream="${CROSSWORD_REPO:-$here/../crossword}"
mode="${1:-sync}"

if [ ! -d "$upstream/frontend/src/lib" ]; then
  echo "sync-upstream: crossword repo not found at $upstream (set CROSSWORD_REPO)" >&2
  exit 1
fi

# upstream path (relative to frontend/src/lib) → local path (relative to lib/)
files=(
  types.ts
  alphabet.ts
  symmetry.ts
  gridUtils.ts
  patternGenerator.ts
  puzExport.ts
  embed.ts
  api/grid.ts
)

drift=0
for f in "${files[@]}"; do
  src="$upstream/frontend/src/lib/$f"
  dst="$here/lib/$f"
  if [ "$mode" = "--check" ]; then
    if ! cmp -s "$src" "$dst"; then echo "drift: lib/$f"; drift=1; fi
  else
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
  fi
done

spec_src="$upstream/docs/api/openapi.yaml"
spec_dst="$here/openapi.yaml"
if [ "$mode" = "--check" ]; then
  if ! cmp -s "$spec_src" "$spec_dst"; then echo "drift: openapi.yaml"; drift=1; fi
else
  cp "$spec_src" "$spec_dst"
fi

if [ "$mode" = "--check" ]; then
  [ "$drift" = 0 ] && echo "sync-upstream: lib/ and openapi.yaml match upstream"
  exit "$drift"
fi
echo "sync-upstream: copied ${#files[@]} lib files and openapi.yaml from $upstream"
