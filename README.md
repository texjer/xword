# xword

The TypeScript client and `xword` CLI for the [Crossword Generator
API](https://crossword.texs.org/developers): word search and dictionary scores
across 24 languages, the clue corpus, CSP autofill and clean-up, AI clue
generation, and puzzle storage and publishing.

Pattern generation and `.puz` export run locally — they are the web
constructor's own code, vendored rather than reimplemented, so they cost no
round trip and no quota.

Not to be confused with [xword-dl](https://github.com/thisisparker/xword-dl),
which downloads published puzzles from newspaper sites. This package builds
new ones.

## Install

```bash
npx xword status    # no install
npm i -g xword      # then: xword status
npm i xword         # as a library
```

Node 20 or newer. The package installs one bin, `xword`.

## Authentication

Mint a key at [crossword.texs.org/dashboard?tab=api](https://crossword.texs.org/dashboard?tab=api)
(Dashboard → API). It is shown once.

```bash
xword login                      # prompts without echo, stores mode 0600
export CROSSWORD_API_KEY=cw_live_…   # always wins over the stored key
```

The stored key lives in the OS config directory
(`~/Library/Preferences/xword/config.json` on macOS,
`$XDG_CONFIG_HOME/xword/config.json` on Linux). `xword logout` deletes
it. The key is never printed, never logged, and is not accepted as a command-line
flag — a flag would land in shell history and in `ps`.

`xword status` and `xword languages` need no key.

Keys carry a subset of three scopes — `read`, `solve`, `puzzles:write` — and new
keys get all three. A key missing the scope an operation needs gets
`403 FORBIDDEN_SCOPE`.

## 60-second quickstart

```bash
xword status                                  # is the service up, which indexes are hot
xword languages --available                   # the 24 languages and their constraints

xword words "C_T" --lang en --min-score 40    # pattern search; _ is a wildcard
xword scores CAT ESNE ZZTOP                   # dictionary scores; unknown words say so
xword clues SUB --limit 3                     # corpus clues for an answer

xword pattern --size 15 --out grid.txt        # local, no key, no quota
xword fill grid.txt --stream --out filled.txt # autofill, with progress
xword improve filled.txt --out clean.txt      # swap the obscure entries out

xword puzzles create puzzle.json              # save it
xword puzzles publish k3n8q1zp                # mint the public + embed URLs
xword export k3n8q1zp --puz --out mine.puz    # Across Lite
```

`scripts/cli-walkthrough.sh` runs that whole journey end to end against a
server of your choosing (`CROSSWORD_API_BASE`, default
`http://localhost:5555/api/v1`).

## Commands

Everything takes `--json` for scripting and `--base <url>` to point at another
deployment. Exit codes: **0** success, **1** an API problem or a fill that found
nothing, **2** a usage error.

### Account

| Command | What it does |
|---|---|
| `xword login` | Prompt for a key and store it mode 0600. Verifies it before reporting success. |
| `xword logout` | Delete the stored key. |
| `xword status` | Service health, which language indexes are resident, and where your key is coming from. |

### Lookup

| Command | What it does |
|---|---|
| `xword languages [--available]` | The language registry: availability, RTL, `.puz` exportability, criss-cross-only, minimum slot length. |
| `xword words <pattern> [--lang] [--min-score] [--limit]` | Pattern search, best first. `_` or `?` is a wildcard. `--limit` caps at 100. |
| `xword clues <WORD> [--lang] [--limit]` | Corpus clues for one answer, best first, de-duplicated server-side. |
| `xword scores <WORD...> [--lang]` | Dictionary score per word. A word the index does not know is reported as unscored, not 0 — that is how you tell a theme answer from a bad one. |

### Building

| Command | What it does |
|---|---|
| `xword pattern [--size 15] [--style american\|british\|freeform] [--out]` | Generate a symmetric black-square pattern **locally**. |
| `xword fill <grid.txt\|-> [--lang] [--min-score] [--max-time] [--try-hard] [--stream] [--out]` | Auto-fill every empty cell. |
| `xword improve <grid.txt\|-> [--lock r,c ...] [--lang] [--max-time] [--out]` | Re-fill the obscure entries at a fixed quality floor. |
| `xword generate-clues <WORD...> [--lang] [--count] [--yes]` | Write fresh AI clues. Members only. |

`fill` and `improve` each draw one unit from the monthly fill quota;
`generate-clues` draws from the AI-clue allowance and asks before it spends.

**`--min-score` is the quality floor.** 40 is the "no junk" line and the
default. 50 makes themed grids grind. The solver relaxes the floor as restarts
accumulate, so a `rough` list can still come back — feed it to `improve`, whose
whole move is to back the fill out and re-solve at a fixed floor.

**`--stream`** uses the SSE response and renders progress as the solver works.
Progress is not monotonic: the solver backtracks and restarts, so a later frame
can report fewer filled entries.

**`--lock r,c`** on `improve` marks cells the solver must never touch — that is
where theme entries go. On `fill` it is a pre-flight assertion rather than a
request field: `POST /fill` has no `locked` list because every letter already in
the grid is held anyway, so `--lock` there just checks that the cells you meant
to protect really do carry a letter.

### Puzzles

| Command | What it does |
|---|---|
| `xword puzzles list [--status draft\|published] [--limit] [--offset]` | Your own puzzles, newest edit first. |
| `xword puzzles get <id>` | One of yours, or any published puzzle. |
| `xword puzzles create <puzzle.json\|-> [--publish] [--idempotency-key k]` | Save a new puzzle. The same key returns the same puzzle instead of a twin. |
| `xword puzzles update <id> <patch.json\|->` | PATCH a subset of fields; omitted ones are left alone. |
| `xword puzzles delete <id> [--yes]` | Permanent, history included. |
| `xword puzzles publish <id> [--showcase] [--writeup] [--show-profile] [--no-index]` | Mint the public and embed URLs. |
| `xword export <id> [--puz\|--json] [--out]` | Across Lite binary, or the puzzle document. |

Publishing is **unlisted by default**. `--showcase` opts into the public
showcase review queue — a human reads those, so the CLI does not enter it on
your behalf.

`.puz` is single-byte ISO-8859-1, so only Latin-script languages round-trip;
asking for it in Russian or Hebrew returns a validation error rather than a
corrupt file. `xword languages` reports `puz=false` for those.

## Grid format

A grid file is one row per line, one character per cell:

```
..#..
.....
..A..
.....
..#..
```

* `.` — an empty white cell the solver may fill
* `#` — a black square
* anything else — a fixed letter the solver must keep

Grids are square, 3–23 cells a side. `-` in place of a filename reads the grid
from stdin, so the pieces compose:

```bash
xword pattern --size 11 | xword fill - --stream
```

Blank lines and `//` comment lines are ignored, so a file you annotated by hand
still parses.

Two things the format gets deliberately right:

* **A cell is not a character.** In Devanagari one cell is a whole akshara —
  a base consonant plus its combining matra — so a row string can be longer than
  the grid size in JavaScript `.length` terms. Use `gridUnits()`, never an index.
* **Letters are normalized per language.** Uppercased, accents folded where the
  language folds them, Hebrew final forms folded to medial. What comes back may
  not be byte-identical to what you sent; it is what the web constructor would
  have stored.

## Programmatic usage

```ts
import {
  CrosswordClient,
  CrosswordApiError,
  generateAmericanPattern,
  cellsToGrid,
  exportPuzFromGrid,
} from "xword";

const client = new CrosswordClient({ apiKey: process.env.CROSSWORD_API_KEY });

// Local: no network, no quota.
const grid = cellsToGrid(generateAmericanPattern(15).grid);

// Blocking fill.
const result = await client.fillGrid({ grid, min_score: 40, language: "en" });
console.log(result.grid, result.quality.rough);

// Or stream it.
for await (const event of client.fillGridStream({ grid, max_time: 25 })) {
  if (event.type === "progress") console.log(event.filled, "/", event.total);
  if (event.type === "complete") console.log(event.grid);
  if (event.type === "error") console.error(event.reason);
}
```

### The client

`new CrosswordClient({ apiKey, baseUrl, fetch, userAgent, maxRetryDelayMs,
retryOnRateLimit })`. `baseUrl` defaults to
`https://crossword.texs.org/api/v1`. `fetch` is injectable for tests and
proxies; otherwise the global one is used, so the client and the CLI pull in
**no runtime dependencies** — the only ones in the package belong to the MCP
server, which is loaded lazily and only by `xword mcp`.

One method per operation in the spec:

| Method | Endpoint |
|---|---|
| `getStatus()` | `GET /status` |
| `listLanguages()` | `GET /languages` |
| `searchWords({ pattern, lang, min_score, limit })` | `GET /words` |
| `scoreWords({ words, language })` | `POST /words/scores` |
| `lookupClues(word, { language, limit })` | `GET /clues/{word}` |
| `lookupCluesBulk({ words, language })` | `POST /clues/bulk` |
| `generateClues({ word, count, language })` | `POST /clues/generate` |
| `fillGrid(gridOrRequest)` | `POST /fill` |
| `fillGridStream(gridOrRequest)` | `POST /fill` (SSE) |
| `improveFill(gridOrRequest)` | `POST /fill/improve` |
| `cancelFill(sessionId)` | `POST /fill/cancel` |
| `listPuzzles({ status, limit, offset })` | `GET /puzzles` |
| `createPuzzle(input)` | `POST /puzzles` |
| `getPuzzle(id)` | `GET /puzzles/{id}` |
| `updatePuzzle(id, patch)` | `PATCH /puzzles/{id}` |
| `deletePuzzle(id)` | `DELETE /puzzles/{id}` |
| `publishPuzzle(id, options)` | `POST /puzzles/{id}/publish` |
| `exportPuzzle(id, { format })` | `GET /puzzles/{id}/export` |

`fillGrid` and `improveFill` accept either a bare grid or the full request
object. `exportPuzzle` returns the `Puzzle` for `format: "json"` and
`{ data, filename }` for `format: "puz"`.

Types are generated from `openapi.yaml` (`npm run gen`), so a contract change
shows up as a type error rather than a runtime surprise. The same spec is served
at <https://crossword.texs.org/api/v1/openapi.json>.

### Errors

Every failure throws `CrosswordApiError`:

```ts
try {
  await client.fillGrid(grid);
} catch (error) {
  if (error instanceof CrosswordApiError) {
    error.code;                       // "GRID_SIZE_LOCKED" — branch on this
    error.status;                     // 403
    error.problem?.detail;            // prose, may change between releases
    error.extra<number>("maxGridSize"); // extension members of the problem doc
    error.rateLimit.retryAfter;       // Retry-After, in seconds
    error.rateLimit.fillQuotaRemaining;
  }
}
```

`code` is the stable identity; `detail` is human prose that may change. New
codes may be added — treat an unrecognized one as a generic failure of its HTTP
status class.

A 429 on a **read** is retried once automatically, honouring `Retry-After`
(and giving up rather than sleeping out an absurd one). Fill, improve, clue
generation and every puzzle write are **never** retried: the quota is already
spent, or a second attempt would create a second puzzle.

A well-formed fill the solver could not satisfy is **not** an error — it is a
200 with `slotsFilled: 0` and a `reason` (`too_difficult`, `no_solution`,
`cancelled`).

### Local helpers

Re-exported from the web constructor, so there is one implementation of each:

* `generatePattern`, `generateAmericanPattern`, `generateBritishPattern`,
  `generateFreeformPattern`
* `hasRotationalBlockSymmetry`, `getSymmetryMismatches`, `getSymmetricPosition`,
  `isCenter`
* `computeNumbers`, `extractSlots`, `getSlotAtCell`, `getSlotWord`,
  `unfillableReason`, `looksFreeform`, `createEmptyGrid`
* `exportPuz`, `exportPuzFromGrid`
* `gridFromPublic`, `cellsToGrid`, `gridToPublic`, `applyFillToPublicGrid`,
  `parseGridText`, `formatGridText`, `emptyGrid`, `gridUnits`, `gridSize`,
  `countBlackCells`, `numberGrid`, `gridSlots`, `gridAnswers`,
  `parseLockedCells`
* `ALPHABET_CONFIGS`, `normalizePuzzleText`, `isRtlLanguage`,
  `isCrissCrossOnlyLanguage`, `minSlotLength`, `getPuzzleUnits`

HTML export is not here: it reads the web app's Zustand store, so it stays a
web-app feature until that dependency is untangled.

Known limit, inherited from the shared generator: `generateAmericanPattern`
gives up outside roughly 10–18 cells a side and returns an all-white grid
instead of throwing, and `generateFreeformPattern`'s asymmetric variant does the
same about half the time. `xword pattern` retries and then says so plainly
rather than handing you a grid autofill will refuse.

## MCP

`xword mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io)
server on stdio, so Claude Code, Claude Desktop, Cursor and anything else that
speaks MCP can build and publish puzzles directly. Everything the CLI does is
exposed as a tool.

### Add it

Claude Code, one command:

```bash
claude mcp add crossword -e CROSSWORD_API_KEY=cw_live_… -- npx -y xword mcp
```

Claude Desktop (`claude_desktop_config.json`), Cursor (`~/.cursor/mcp.json`),
or a project `.mcp.json` — the same object, also in
[`examples/mcp.json`](examples/mcp.json):

```json
{
  "mcpServers": {
    "crossword": {
      "command": "npx",
      "args": ["-y", "xword", "mcp"],
      "env": { "CROSSWORD_API_KEY": "cw_live_…" }
    }
  }
}
```

The key comes from `CROSSWORD_API_KEY` or, if that is unset, the `xword login`
config file — so a machine that has already run `xword login` needs no `env`
block at all. `CROSSWORD_API_BASE` points the server at another deployment.
Without any key, `get_status` and `list_languages` still work and everything
else returns `UNAUTHORIZED`.

Then ask for a puzzle: *"make me an 11×11 about lighthouses and give me the
embed code"*. The `compose_puzzle` prompt carries the same workflow if your
client surfaces prompts.

### Tools

| Tool | What it does | Cost |
|---|---|---|
| `get_status` | Service health and which language indexes are resident. | free, no key |
| `list_languages` | The 24 languages and their constraints (`available`, `crissCrossOnly`, `rtl`, `puzExportable`, `minSlotLength`). | free, no key |
| `search_words` | Pattern search — `C_T` → `COT`, `CUT`, … best first. | free¹ |
| `score_words` | Dictionary score per word; unknown words come back absent, not zero. | free¹ |
| `lookup_clues` | Corpus clues for one answer, best first, de-duplicated. | free¹ |
| `lookup_clues_bulk` | Up to five clues for each of up to 500 answers, one round trip. | free¹ |
| `generate_clues` | Fresh AI-written clues. | **members only; spends the monthly AI-clue allowance, one unit per answer** |
| `generate_pattern` | Symmetric black-square pattern, american/british/freeform. | **free and local** — no network, no quota |
| `fill_grid` | Auto-fill every empty cell, holding the letters already placed. | **spends one monthly fill unit, success or not** |
| `improve_fill` | The "clean up fill" pass — re-solve the rough entries at a fixed floor. | **spends one monthly fill unit** |
| `list_puzzles` | Your puzzles, newest edit first. | free¹ |
| `get_puzzle` | One of yours, or any published puzzle. | free¹ |
| `create_puzzle` | Save a puzzle, optionally published (unlisted). | free¹ |
| `update_puzzle` | PATCH a subset of fields. `clues` replaces both maps wholesale. | free¹ |
| `delete_puzzle` | Permanent, history included. | free¹ |
| `publish_puzzle` | Mint the public URL and the embed snippet. | free¹ |
| `export_puzzle` | The puzzle document, or Across Lite `.puz` as base64. | free¹ |

¹ free beyond the per-minute rate limit for your tier.

Three things the server does on purpose, because a model reading rows of text
cannot infer them:

* **Every grid comes back with its entries.** `fill_grid`, `improve_fill` and
  `get_puzzle` all return an `entries` object — the numbered ACROSS and DOWN
  answers — alongside the rows, because clue numbering is the printed rule
  rather than a row scan, and those numbers are exactly the keys
  `create_puzzle`'s `clues` wants.
* **`publish_puzzle` returns a paste-ready `embedSnippet`** — iframe, resize
  script and attribution caption — built by the site's own `embedSnippet`, so
  it is identical to what the web app's Embed dialog hands out.
* **Failures come back as tool errors carrying `code`**, plus the problem
  document's extra members and the quota headers, so the model can act on
  `GRID_SIZE_LOCKED` (retry smaller) rather than on English prose.

### Quota warnings

`fill_grid` and `improve_fill` each draw one unit from the monthly fill
allowance **whether or not they find anything** — the quota is spent before the
solve, so a `too_difficult` result still costs a unit. `generate_clues` is a
member feature and spends one unit of the monthly AI-clue allowance per answer;
`lookup_clues_bulk` is free and covers most answers, so try it first. Grid size
is gated by membership exactly as it is in the web constructor — 13×13 free,
23×23 for members — which arrives as `GRID_SIZE_LOCKED`.

`publish_puzzle` publishes **unlisted** unless you pass `showcase: true`, which
enters a queue a human reads.

### Notes

* **stdout is the protocol.** The server writes diagnostics to stderr only, and
  repoints `console.log`/`info`/`debug`/`warn` at stderr for anything
  underneath it. Do not pipe anything else into its stdout.
* `scripts/mcp-smoke.mjs` spawns the built server on a real pipe and checks
  `tools/list`, the two keyless tools, local pattern generation, and that a bad
  key produces `UNAUTHORIZED`.
* Remote/HTTP MCP with OAuth is not built: a bearer key covers Claude Code and
  Cursor today, and the claude.ai custom-connector flow needs OAuth, which
  waits until someone asks for it.
* The MCP server is the only part of this package with runtime dependencies
  (`@modelcontextprotocol/sdk` and `zod`). They are loaded lazily, so every
  other `xword` command still starts without touching them, and the client and
  CLI remain dependency-free in everything but the install.

```ts
import { createMcpServer, startMcpServer } from "xword/mcp";
```

`createMcpServer({ apiKey, baseUrl, fetch, env })` returns an unconnected
`McpServer` — useful for embedding the tools in another server or for tests
over `InMemoryTransport`. `startMcpServer()` connects it to stdio and resolves
when the connection closes.

## Rate limits and quotas

Per-minute read limits and monthly fill quotas follow your membership tier.
Responses carry `X-RateLimit-Limit` / `X-RateLimit-Remaining`; solver responses
carry `X-Fill-Quota-Remaining` and clue generation carries
`X-Ai-Clues-Remaining` (`-1` means unlimited). The client exposes the most
recent set as `client.lastRateLimit`.

Grid size is gated by membership exactly as it is in the web constructor: 13×13
on the free tier, 23×23 for members.

## Attribution

Non-English word lists and parts of the clue corpus are licensed CC BY-SA; the
per-language record is on the
[developers page](https://crossword.texs.org/developers). There is no bulk
export — `words` caps at 100 results a call.

## Development

```bash
npm ci
npm run gen        # openapi.yaml → src/types.gen.ts
npm run build      # tsup → dist/
npm test           # vitest
```

`lib/` and `openapi.yaml` are copies of files in the (private) Crossword
Generator repo — the pattern generator, symmetry, grid numbering, `.puz`
encoding, alphabet tables and the public grid codec — so the SDK and the web
constructor produce identical grids. `scripts/sync-upstream.sh` refreshes them
and `prepublishOnly` refuses to release if they have drifted. Don't edit them
here; a fix belongs upstream, and the next sync would overwrite it. Everything
under `src/` is this package's own and is where contributions go.

## Licence

MIT. The puzzle data behind the API has its own terms; see
<https://crossword.texs.org/terms>.
