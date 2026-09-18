#!/usr/bin/env bash
#
# End-to-end walkthrough of the public API using only `xword`.
#
# The full journey — status, languages, words, clues, fill, improve, save,
# publish, export — with every step a CLI command. It mirrors the curl
# walkthrough that lives with the API itself; where that one proves the HTTP
# contract, this one proves the CLI is a complete front end for it: if you
# never need to drop back to curl, the CLI is done.
#
#   CROSSWORD_API_BASE=http://localhost:5555/api/v1 \
#   CROSSWORD_API_KEY=cw_live_… \
#   packages/xword/scripts/cli-walkthrough.sh
#
# The two unauthenticated steps (status, languages) run without a key, so the
# script is useful before you have minted one. Everything after that stops with
# a clear message if CROSSWORD_API_KEY is unset.
#
# Requires: node >= 20, jq, and a built package (npm run build).
#
# Run it with an ordinary key, not an admin's. Publishing under a clue
# contributor (admin / CLUE_CONTRIBUTOR_EMAILS) harvests the answer/clue pairs
# into the shared corpus, and this script clues everything "Placeholder clue".
# If that happens, remove them on the box:
#   DELETE FROM clues WHERE clue_text = 'Placeholder clue' AND source = 'user-published'

set -euo pipefail

PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
XWORD="${XWORD:-node ${PACKAGE_DIR}/dist/cli.js}"
export CROSSWORD_API_BASE="${CROSSWORD_API_BASE:-http://localhost:5555/api/v1}"
LANG_CODE="${LANG_CODE:-en}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
dim() { printf '\033[2m%s\033[0m\n' "$*"; }
fail() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }

command -v jq >/dev/null || fail "jq is required (brew install jq)"
[ -f "${PACKAGE_DIR}/dist/cli.js" ] || fail "Build first: (cd ${PACKAGE_DIR} && npm run build)"

work="$(mktemp -d -t xword-walkthrough)"
trap 'rm -rf "$work"' EXIT

need_key() {
  [ -n "${CROSSWORD_API_KEY:-}" ] || {
    echo
    bold "Stopping here: the rest of the walkthrough needs a key."
    dim  "Mint one at Account → API keys, then re-run with:"
    dim  "  CROSSWORD_API_KEY=cw_live_… $0"
    dim  "(or run \`xword login\` once — the CLI reads the stored key too)"
    exit 0
  }
}

bold "xword walkthrough — ${CROSSWORD_API_BASE}"
echo

# ---------------------------------------------------------------- 1. status --
bold "1. xword status"
$XWORD status || fail "status"

# ------------------------------------------------------------- 2. languages --
bold "2. xword languages"
$XWORD languages --json |
  jq -r --arg code "$LANG_CODE" '
    .[] | select(.code == $code) |
    "   \(.name) (\(.nativeName)) — available=\(.available) rtl=\(.rtl)"
    + " crissCrossOnly=\(.crissCrossOnly) puz=\(.puzExportable) minSlot=\(.minSlotLength)"
  ' || fail "languages"

need_key

# ----------------------------------------------------------------- 3. words --
bold "3. xword words C_T"
$XWORD words "C_T" --lang "$LANG_CODE" --min-score 40 --limit 5 || fail "words"

bold "4. xword scores CAT ESNE ZZTOPQX"
$XWORD scores CAT ESNE ZZTOPQX --lang en || fail "scores"

# ----------------------------------------------------------------- 5. clues --
bold "5. xword clues SUB"
$XWORD clues SUB --lang en --limit 3 || fail "clues"

# --------------------------------------------------------------- 6. pattern --
# Local, no key and no quota. Written to a file so `fill` can read it — this is
# the seam that makes the CLI composable.
bold "6. xword pattern (local, no quota)"
$XWORD pattern --size 5 --out "$work/grid.txt" || fail "pattern"
# A 5×5 stays inside the Free tier's 13×13 ceiling and fills in well under a
# second, so the walkthrough works on any account. Overwrite the generated
# pattern with a known-good one for reproducibility.
printf '..#..\n.....\n..A..\n.....\n..#..\n' > "$work/grid.txt"
sed 's/^/   /' "$work/grid.txt"

# ------------------------------------------------------------------ 7. fill --
bold "7. xword fill"
$XWORD fill "$work/grid.txt" --lang en --min-score 40 --max-time 20 \
  --out "$work/filled.txt" || fail "fill"
sed 's/^/   /' "$work/filled.txt"

bold "8. xword improve"
$XWORD improve "$work/filled.txt" --lang en --max-time 20 \
  --out "$work/clean.txt" || fail "improve"
sed 's/^/   /' "$work/clean.txt"

# --------------------------------------------------------------- 9. puzzles --
bold "9. xword puzzles create"
# Publishing needs a clue for every complete entry, and the numbering depends on
# the black squares the pattern ended up with — so rather than hardcode numbers
# that would silently go stale, clue every number a 5×5 could carry. Clues for
# numbers the grid doesn't use are stored but never shown — the puzzle page
# reads by slot number — so the export below carries all 25 keys back.
jq -nc \
  --argjson grid "$(jq -Rn '[inputs]' < "$work/clean.txt")" \
  --argjson clues "$(jq -nc '[range(1;26)] | map({(tostring): "Placeholder clue"}) | add')" '{
    title: "CLI walkthrough",
    author: "xword",
    language: "en",
    grid: $grid,
    clues: { across: $clues, down: $clues },
    themeWords: []
  }' > "$work/puzzle.json"

created="$($XWORD puzzles create "$work/puzzle.json" --json)" || fail "puzzles create"
puzzle_id="$(jq -r '.id' <<<"$created")"
jq -r '"   created \(.id) — \(.size)×\(.size), status=\(.status)"' <<<"$created"

bold "10. xword puzzles get ${puzzle_id}"
$XWORD puzzles get "$puzzle_id" || fail "puzzles get"

bold "11. xword puzzles update ${puzzle_id}"
printf '{"title":"CLI walkthrough (edited)"}\n' > "$work/patch.json"
$XWORD puzzles update "$puzzle_id" "$work/patch.json" || fail "puzzles update"

bold "12. xword puzzles publish ${puzzle_id}"
# No --showcase: publishing here should not enter the human review queue.
$XWORD puzzles publish "$puzzle_id" --writeup "Published by cli-walkthrough.sh" ||
  fail "publish (a puzzle needs a title and a clue for every complete entry)"

bold "13. xword export ${puzzle_id} --puz"
$XWORD export "$puzzle_id" --puz --out "$work/puzzle.puz" || fail "export"
# Bytes 2-12 of a .puz are the literal string ACROSS&DOWN.
if [ "$(dd if="$work/puzzle.puz" bs=1 skip=2 count=11 2>/dev/null)" = "ACROSS&DOWN" ]; then
  echo "   $(wc -c <"$work/puzzle.puz" | tr -d ' ') bytes, valid Across Lite header"
else
  fail "export produced something that is not a .puz"
fi

bold "14. xword export ${puzzle_id} --json"
$XWORD export "$puzzle_id" --json --out "$work/puzzle-export.json" || fail "export json"
jq -r '"   \(.title) — \(.size)×\(.size), \(.clues.across | length) across clue keys"' < "$work/puzzle-export.json"

echo
bold "All steps passed."
dim "Clean up with: xword puzzles delete ${puzzle_id} --yes"
