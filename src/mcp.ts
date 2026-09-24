/**
 * The stdio MCP server behind `xword mcp` and the `xword/mcp` export.
 *
 * It is the same `CrosswordClient` the CLI uses, wrapped in tools whose
 * descriptions are written for a model rather than for a person: every tool
 * that costs quota, money or a human's attention says so in its own
 * description, because the model reads nothing else before it calls.
 *
 * Three rules this file lives by:
 *
 * * **stdout is the protocol.** Every diagnostic goes to stderr. A single
 *   stray `console.log` corrupts the JSON-RPC stream and the client drops the
 *   connection with no useful error, so `runMcpCli` also repoints `console.*`
 *   at stderr for anything underneath us that has not read this comment.
 * * **A failed call is a result, not a crash.** `CrosswordApiError` comes back
 *   as `isError: true` content carrying `code`, `detail`, the problem
 *   document's extra members and the quota headers — the model needs the code
 *   to decide what to do next (`GRID_SIZE_LOCKED` → retry smaller).
 * * **Grids are answered as entries, not just rows.** A model handed
 *   `["KD#MC", …]` cannot write clues from it; every fill-shaped tool also
 *   returns the numbered ACROSS/DOWN answer maps, which are exactly the keys
 *   `create_puzzle`'s `clues` wants.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  CrosswordClient,
  DEFAULT_BASE_URL,
  type Clue,
  type LanguageCode,
  type Puzzle,
  type PuzzleInput,
  type PuzzlePatch,
} from "./client.js";
import { CrosswordApiError, type RateLimitInfo } from "./errors.js";
import { resolveApiKey, resolveBaseUrl } from "./config.js";
import { VERSION } from "./cliHelp.js";
import { cellsToGrid, countBlackCells, type PublicGrid } from "./grid.js";
import {
  ALPHABET_CONFIGS,
  generateAmericanPattern,
  generateBritishPattern,
  generateFreeformPattern,
  gridAnswers,
  gridSlots,
  type PatternInfo,
} from "./local.js";
import { EMBED_SCALE_DEFAULT, embedSnippet } from "@/lib/embed";

export const MCP_AVAILABLE = true;

/** Reported to the client in `initialize`, and in the user agent we send. */
export const MCP_SERVER_NAME = "xword";

// --- Shared schema pieces --------------------------------------------------

/**
 * Derived from the constructor's own alphabet table rather than retyped from
 * the OpenAPI enum, so a language added to the web app cannot go missing here.
 */
const LANGUAGE_CODES = Object.keys(ALPHABET_CONFIGS) as [
  LanguageCode,
  ...LanguageCode[],
];

const languageSchema = z
  .enum(LANGUAGE_CODES)
  .describe(
    "ISO 639-1 puzzle language. `pt-BR` normalizes to `pt`. Call list_languages " +
      "first if unsure: a language without a deployed word database cannot be " +
      "searched or filled, and zh/ja/ko cannot fill dense grids at all."
  );

const gridSchema = z
  .array(z.string())
  .min(3)
  .max(23)
  .describe(
    "The grid as rows of text, one entry per row, square (3-23 cells a side). " +
      "`.` is an empty white cell, `#` is a black square, and any other " +
      "character is a fixed letter the solver must keep — that is how theme " +
      "answers are placed. Note a cell is not always one JavaScript character " +
      "(Devanagari aksharas are several codepoints)."
  );

const lockedSchema = z
  .array(z.string().regex(/^\d+,\d+$/, 'Locked cells are "row,col", zero-based'))
  .describe(
    'Cells the clean-up pass must never touch, as zero-based "row,col" strings ' +
      "— this is where theme entries go. Only a fully locked entry is exempt " +
      "from judging; an entry that merely crosses a locked cell is re-solved " +
      "with that letter held."
  );

const clueMapSchema = z
  .record(z.string(), z.string())
  .describe("Clue number (as a string) → clue text.");

const cluesSchema = z.object({
  across: clueMapSchema.optional(),
  down: clueMapSchema.optional(),
});

// --- Result helpers --------------------------------------------------------

function text(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }] };
}

/** A short prose headline the model reads first, then the machine-readable body. */
function result(summary: string, payload: unknown): CallToolResult {
  return text(`${summary}\n\n${JSON.stringify(payload, null, 2)}`);
}

/** Only the limit headers that were actually present, so the payload stays quiet. */
function quotaOf(rateLimit: RateLimitInfo): Record<string, number> | undefined {
  const entries = Object.entries(rateLimit).filter(
    ([, value]) => typeof value === "number"
  ) as Array<[string, number]>;
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * One actionable sentence per failure a model can actually do something about.
 * Deliberately phrased as an instruction to the caller — "retry with", "stop
 * and tell the user" — because a model reading `MEMBERS_ONLY` will otherwise
 * keep trying the same call.
 */
function upgradeHint(error: CrosswordApiError): string {
  const tier = error.extra<string>("tier");
  const url = error.extra<string>("upgradeUrl");
  const contact = error.extra<string>("contact");
  const plan = tier ? `This account is on the ${tier} plan. ` : "";
  if (url) return `${plan}Stop and tell the user they can upgrade at ${url}`;
  if (contact) return `${plan}Stop and tell the user to email ${contact} for a bulk arrangement.`;
  return `${plan}Stop and tell the user a membership lifts this limit.`;
}

function hintFor(error: CrosswordApiError): string | null {
  switch (error.code) {
    case "UNAUTHORIZED":
      return "No valid API key. Stop and tell the user to set CROSSWORD_API_KEY (or run `xword login`) with a key from https://crossword.texs.org/dashboard?tab=api (Dashboard → API).";
    case "FORBIDDEN_SCOPE":
      return `This key lacks the \`${error.extra<string>("requiredScope") ?? "required"}\` scope. Stop and tell the user; a new key can be minted with it.`;
    case "GRID_SIZE_LOCKED": {
      const max = error.extra<number>("maxGridSize") ?? 13;
      return `Retry with a grid of at most ${max}×${max}, or larger grids need a membership (23×23). ${upgradeHint(error)}`;
    }
    case "MEMBERS_ONLY":
      return `AI clue generation is a member feature. Use lookup_clues / lookup_clues_bulk instead, or write the clues yourself. ${upgradeHint(error)}`;
    case "RATE_LIMITED":
      return `Wait ${error.rateLimit.retryAfter ?? "a few"} seconds, then retry the same call.`;
    case "FILL_QUOTA_REACHED":
      return `The monthly fill allowance is spent; it resets on the 1st. Do not retry. ${upgradeHint(error)}`;
    case "AI_QUOTA_REACHED":
      return `The monthly AI-clue allowance is spent; it resets on the 1st. Fall back to lookup_clues_bulk. ${upgradeHint(error)}`;
    case "PUZZLE_QUOTA_REACHED":
      return `The monthly new-puzzle allowance is spent; it resets on the 1st. Do not retry the create. Editing and publishing existing puzzles still work. ${upgradeHint(error)}`;
    case "SHOWCASE_QUEUE_FULL":
      return "Three of this account's puzzles are already waiting for showcase review. Retry publish_puzzle with showcase: false (the puzzle still gets its page and embed), and tell the user to resubmit once one is reviewed.";
    case "SOLVER_BUSY":
      return "Too many solves are running. Wait a few seconds and retry once.";
    case "LANGUAGE_UNAVAILABLE":
      return "That language has no deployed word database. Call list_languages and pick one whose `available` is true.";
    case "NOT_FOUND":
      return "No such puzzle, or it is someone else's draft. Call list_puzzles to see what this key owns.";
    case "VALIDATION_ERROR":
      return "The request was malformed. Read `detail` (and `missingClues`, if present) and fix the input before retrying.";
    default:
      return null;
  }
}

/** Turn any thrown value into an `isError` tool result. Never rethrows. */
function toolError(error: unknown): CallToolResult {
  if (error instanceof CrosswordApiError) {
    const problem = (error.problem ?? {}) as Record<string, unknown>;
    const extras: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(problem)) {
      if (["type", "title", "status", "code", "detail"].includes(key)) continue;
      extras[key] = value;
    }
    const payload = {
      error: true,
      code: error.code,
      status: error.status,
      detail: error.problem?.detail ?? error.message,
      ...(Object.keys(extras).length > 0 ? { extra: extras } : {}),
      ...(quotaOf(error.rateLimit) ? { quota: quotaOf(error.rateLimit) } : {}),
    };
    const hint = hintFor(error);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `${error.code}: ${payload.detail}${hint ? `\n${hint}` : ""}\n\n${JSON.stringify(payload, null, 2)}`,
        },
      ],
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `${message}\n\n${JSON.stringify({ error: true, code: "CLIENT_ERROR", detail: message }, null, 2)}`,
      },
    ],
  };
}

/** Wrap a handler so a throw becomes an `isError` result rather than a protocol error. */
function guard<Args extends unknown[]>(
  handler: (...args: Args) => Promise<CallToolResult> | CallToolResult
): (...args: Args) => Promise<CallToolResult> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return toolError(error);
    }
  };
}

// --- Grid → entries --------------------------------------------------------

export interface GridEntries {
  across: Record<string, string>;
  down: Record<string, string>;
  /** Entry labels (`"6-down"`) still holding a blank, so the model knows not to clue them. */
  unfilled: string[];
}

/**
 * The numbered answers in a grid, split by direction.
 *
 * The keys are the same clue numbers `create_puzzle`'s `clues.across` /
 * `clues.down` take, so the model can write its clue map straight off this
 * without recomputing the numbering (which is the printed rule, not a simple
 * row scan).
 */
export function gridEntries(
  grid: PublicGrid,
  language: LanguageCode = "en"
): GridEntries {
  const answers = gridAnswers(grid, language);
  const entries: GridEntries = { across: {}, down: {}, unfilled: [] };
  for (const [key, word] of Object.entries(answers)) {
    const number = key.slice(0, -1);
    const direction = key.endsWith("A") ? "across" : "down";
    entries[direction][number] = word;
    if (word.includes("_")) entries.unfilled.push(`${number}-${direction}`);
  }
  return entries;
}

// --- Public URLs and the embed snippet -------------------------------------

/** `https://crossword.texs.org` from `https://crossword.texs.org/api/v1`. */
function siteOrigin(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return "https://crossword.texs.org";
  }
}

/**
 * The paste-ready embed snippet, built with the web app's own
 * `embedSnippet` so what the model hands out is byte-identical to what the
 * site's Embed dialog hands out — iframe, resize script, attribution caption.
 */
function embedFor(origin: string, puzzle: Puzzle): string {
  return embedSnippet({
    origin,
    embedPath: `/embed/${puzzle.id}`,
    puzzleTitle: puzzle.title,
    size: puzzle.size,
    options: { scheme: "auto", scale: EMBED_SCALE_DEFAULT, showTitle: true, showFooter: true },
    madeWith: "Made with {{link}}",
    siteName: "Crossword Generator",
  });
}

/** A puzzle, plus its public URL and embed snippet once it is published. */
function puzzlePayload(origin: string, puzzle: Puzzle): Record<string, unknown> {
  if (puzzle.status !== "published") return { puzzle };
  return {
    puzzle,
    url: puzzle.url ?? `${origin}/puzzle/${puzzle.id}`,
    embedUrl: puzzle.embedUrl ?? `${origin}/embed/${puzzle.id}`,
    embedSnippet: embedFor(origin, puzzle),
  };
}

// --- Pattern generation (local, free) --------------------------------------

export interface PatternResult {
  grid: PublicGrid;
  style: string;
  name: string;
  wordCount: number;
  blackPercent: number;
  blackCells: number;
  difficulty: number;
  slots: number;
  attempts: number;
}

/**
 * Generate a pattern, retrying past the shared generator's failure mode.
 *
 * `generateAmericanPattern` and the asymmetric half of
 * `generateFreeformPattern` give up after their own attempt budget and return
 * an **all-white grid** rather than throwing. That grid is not a crossword —
 * every row and column is one giant entry — and auto-fill refuses it, so this
 * retries and then reports failure instead of handing one back. Today the
 * American generator cannot satisfy sizes below 10 or above 18.
 *
 * `targetBlacks` is best-effort: the generator picks its own black-square
 * budget from the size, so this generates a handful of candidates and keeps
 * the one closest to the target rather than pretending to control it.
 */
export function generatePatternResult(
  size: number,
  style: "american" | "british" | "freeform",
  targetBlacks?: number
): PatternResult {
  const generate = (): PatternInfo =>
    style === "british"
      ? generateBritishPattern(size)
      : style === "freeform"
        ? generateFreeformPattern(size)
        : generateAmericanPattern(size);

  let best: { info: PatternInfo; grid: PublicGrid; black: number } | null = null;
  let attempts = 0;
  let usable = 0;
  // Twenty draws, because the failure is probabilistic rather than absolute:
  // freeform at 15×15 comes back open about half the time, so ten tries still
  // leaves a one-in-four-hundred chance of a bogus grid reaching the model.
  // We stop at the first usable grid unless a target was asked for, in which
  // case a dozen candidates is enough to land close.
  const MAX_ATTEMPTS = 20;
  const wanted = targetBlacks === undefined ? 1 : 12;

  for (let attempt = 0; attempt < MAX_ATTEMPTS && usable < wanted; attempt++) {
    attempts += 1;
    const info = generate();
    const grid = cellsToGrid(info.grid);
    const black = countBlackCells(grid);
    if (black === 0) continue;
    usable += 1;
    if (
      best === null ||
      (targetBlacks !== undefined &&
        Math.abs(black - targetBlacks) < Math.abs(best.black - targetBlacks))
    ) {
      best = { info, grid, black };
    }
    if (targetBlacks !== undefined && black === targetBlacks) break;
  }

  if (!best) {
    throw new Error(
      `The ${style} generator could not place any black squares at ${size}×${size} ` +
        `in ${attempts} attempts, and an all-open grid is not a crossword — ` +
        "auto-fill would refuse it. Try a size between 10 and 18, or a " +
        "different style (freeform is the most forgiving)."
    );
  }

  return {
    grid: best.grid,
    style: best.info.style,
    name: best.info.name,
    wordCount: best.info.wordCount,
    blackPercent: best.info.blackPercent,
    blackCells: best.black,
    difficulty: best.info.difficulty,
    slots: gridSlots(best.grid).length,
    attempts,
  };
}

// --- The workflow, told once -----------------------------------------------

const WORKFLOW = `End-to-end: build a puzzle and hand back an embed snippet.

1. generate_pattern (local, free, no quota) — pick a size. 11 or 15 are the
   reliable American sizes; the generator cannot satisfy American below 10 or
   above 18. Free-tier keys are capped at 13×13.
2. Place theme answers by writing their letters straight into the grid rows
   returned in step 1 — a letter in a cell is a fixed letter the solver keeps.
   Check them first with score_words: a word the index does not know comes back
   absent rather than scored 0, which is normal and fine for a theme answer.
3. fill_grid (SPENDS one monthly fill unit). Leave min_score at 40 — that is
   the "no junk" floor; 50 makes themed grids grind for minutes. Read
   \`quality.rough\`: those are entries the solver had to settle for.
4. improve_fill (SPENDS another fill unit) only if \`quality.rough\` is
   non-empty. Pass the theme cells in \`locked\` so they survive — the clean-up
   backs the whole fill out and re-solves from scratch, so expect a
   substantially different grid.
5. lookup_clues_bulk with every answer from the fill result's \`entries\` — one
   round trip, free, and it covers most answers. Only for the answers it
   returns nothing for, either write the clue yourself or call generate_clues
   (MEMBERS ONLY, and it SPENDS the monthly AI-clue allowance — ask the user
   before you do).
6. create_puzzle with the grid, a title, and \`clues.across\` / \`clues.down\`
   keyed by the numbers in the fill result's \`entries\`. Every complete entry
   needs a clue or publishing is refused.
7. publish_puzzle. It publishes unlisted by default, which mints the public URL
   and the embeddable frame. \`showcase: true\` additionally enters a human
   review queue — only pass it when the user asked for it. The result carries
   \`url\`, \`embedUrl\` and a paste-ready \`embedSnippet\`.

Quotas worth remembering: fill_grid and improve_fill each cost one unit of the
monthly fill allowance whether or not they succeed — a fill that comes back
with nothing still costs a unit, so do not retry blindly. Reads (words, clues
lookup, puzzles) are free beyond a per-minute rate limit.`;

// --- Server ----------------------------------------------------------------

export interface McpServerOptions {
  /** Defaults to `CROSSWORD_API_KEY`, then the `xword login` config file. */
  apiKey?: string;
  /** Defaults to `CROSSWORD_API_BASE`, then the stored value, then production. */
  baseUrl?: string;
  /** Injectable for tests. */
  fetch?: typeof globalThis.fetch;
  /** Read for the key and base URL when those are not passed explicitly. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Build the server with every tool registered. Exported for tests, which drive
 * it over `InMemoryTransport` rather than a pipe.
 */
export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const env = options.env ?? process.env;
  const apiKey = options.apiKey ?? resolveApiKey(env).key;
  const baseUrl = options.baseUrl ?? resolveBaseUrl(DEFAULT_BASE_URL, env);
  const origin = siteOrigin(baseUrl);

  const client = new CrosswordClient({
    apiKey,
    baseUrl,
    fetch: options.fetch,
    userAgent: "mcp",
  });

  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: VERSION, title: "Crossword Generator" },
    {
      instructions:
        "Word search, the clue corpus, CSP autofill and puzzle publishing for " +
        "crossword.texs.org, in 28 languages.\n\n" +
        WORKFLOW +
        "\n\nGrids are rows of text: `.` empty, `#` black, any other character " +
        "a fixed letter. Every tool that returns a grid also returns `entries` " +
        "— the numbered ACROSS/DOWN answers — because clue numbering is the " +
        "printed rule, not a row scan, and those numbers are what the clue " +
        "maps must be keyed by.",
    }
  );

  const quota = () => quotaOf(client.lastRateLimit);

  // --- Meta ---------------------------------------------------------------

  server.registerTool(
    "get_status",
    {
      title: "Service status",
      description:
        "Is the service up, and which language word-indexes are loaded in memory " +
        "right now. Free, needs no API key. A language that is `available` but not " +
        "`loaded` still works — the first call just pays a few seconds of cold " +
        "load. This endpoint does not fail: a solver that cannot be reached " +
        'answers `status: "degraded"` with an empty language map.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async () => {
      const status = await client.getStatus();
      const languages = Object.entries(status.languages ?? {});
      const loaded = languages.filter(([, v]) => v.loaded).map(([code]) => code);
      return result(
        `${status.status}, contract v${status.version}; ${languages.filter(([, v]) => v.available).length} of ${languages.length} languages available, resident: ${loaded.join(", ") || "none"}.`,
        { ...status, baseUrl: client.baseUrl, apiKeyConfigured: client.hasApiKey }
      );
    })
  );

  server.registerTool(
    "list_languages",
    {
      title: "List puzzle languages",
      description:
        "The 24 puzzle languages and the constraints that decide what you can build " +
        "in each: `available` (a word database is deployed — false means search and " +
        "fill will fail), `crissCrossOnly` (Chinese, Japanese and Korean cannot fill " +
        "dense interlocking grids at all), `rtl`, `puzExportable` (.puz is single-byte " +
        "Latin only), and `minSlotLength`. Free, needs no API key. Call this before " +
        "building in any language other than English.",
      inputSchema: {
        available_only: z
          .boolean()
          .default(false)
          .describe("Return only languages with a deployed word database."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ available_only }) => {
      const languages = await client.listLanguages();
      const filtered = available_only ? languages.filter((l) => l.available) : languages;
      return result(`${filtered.length} languages.`, { languages: filtered });
    })
  );

  // --- Words --------------------------------------------------------------

  server.registerTool(
    "search_words",
    {
      title: "Search words by pattern",
      description:
        "Pattern-match the language's word index — the tool for 'what fits in " +
        "`C_T`?'. `_` (or `?`) is a wildcard, every other character is a literal " +
        "letter; results come back highest-score first. Scores run 0-100 and say how " +
        "crossword-worthy an entry is: 40 is the 'no junk' floor the solver fills at, " +
        "50+ is clean published usage. Free beyond the per-minute rate limit. " +
        "`limit` caps at 100 — this is a lookup, not a bulk export, and there is no " +
        "endpoint that dumps an index.",
      inputSchema: {
        pattern: z
          .string()
          .min(1)
          .max(23)
          .describe("The slot pattern, e.g. `C_T`. `_` or `?` is an unknown cell."),
        lang: languageSchema.default("en"),
        min_score: z
          .number()
          .int()
          .min(0)
          .max(1000)
          .optional()
          .describe("Drop entries scoring below this. 40 keeps out the junk."),
        limit: z.number().int().min(1).max(100).optional().describe("Max matches (≤100)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ pattern, lang, min_score, limit }) => {
      const words = await client.searchWords({ pattern, lang, min_score, limit });
      return result(
        words.length === 0
          ? `No matches for ${pattern}.`
          : `${words.length} matches for ${pattern}, best first.`,
        { words, quota: quota() }
      );
    })
  );

  server.registerTool(
    "score_words",
    {
      title: "Score a batch of words",
      description:
        "Dictionary score for each word the index knows. Use it to sanity-check " +
        "theme answers before you place them. Words the index has no entry for — " +
        "proper nouns, phrases, anything hand-typed — are **absent** from the result " +
        "rather than scored 0, so you can tell 'unscored' from 'scored badly'; an " +
        "absent theme answer is normal and the solver will still hold it. Free.",
      inputSchema: {
        words: z.array(z.string()).min(1).max(200).describe("Up to 200 answers."),
        language: languageSchema.default("en"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ words, language }) => {
      const scores = await client.scoreWords({ words, language });
      const unknown = words.filter((word) => !(word.toUpperCase() in scores) && !(word in scores));
      return result(
        `${Object.keys(scores).length} of ${words.length} words are in the index.`,
        { scores, notInIndex: unknown, quota: quota() }
      );
    })
  );

  // --- Clues --------------------------------------------------------------

  server.registerTool(
    "lookup_clues",
    {
      title: "Clues for one answer",
      description:
        "Published and dictionary-derived clues for a single answer, best first " +
        "(quality tier, then how often the clue has appeared in print). Repeats are " +
        "collapsed server-side. **Free** — always try this before generate_clues, " +
        "which costs money. An answer with no clues returns an empty list.",
      inputSchema: {
        word: z.string().min(1).max(23).describe("The answer. Normalized server-side."),
        lang: languageSchema.default("en"),
        limit: z.number().int().min(1).max(50).optional().describe("Max clues (≤50)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ word, lang, limit }) => {
      const clues = await client.lookupClues(word, { language: lang, limit });
      return result(
        clues.length === 0
          ? `No corpus clues for ${word}.`
          : `${clues.length} clues for ${word}, best first.`,
        { clues, quota: quota() }
      );
    })
  );

  server.registerTool(
    "lookup_clues_bulk",
    {
      title: "Clues for many answers",
      description:
        "Up to five clues for each of up to 500 answers in one round trip — call " +
        "this once after a fill instead of looping lookup_clues. **Free.** Answers " +
        "with no clues are omitted, and keys come back in the corpus's normalized " +
        "form (uppercased and folded for the language), which may differ from what " +
        "you sent. Whatever is missing from the result is what you must write " +
        "yourself or hand to generate_clues.",
      inputSchema: {
        words: z.array(z.string()).min(1).max(500).describe("Up to 500 answers."),
        language: languageSchema.default("en"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ words, language }) => {
      const clues = await client.lookupCluesBulk({ words, language });
      const covered = Object.keys(clues);
      const missing = words.filter(
        (word) => !(word.toUpperCase() in clues) && !(word in clues)
      );
      return result(
        `${covered.length} of ${words.length} answers have corpus clues; ${missing.length} need writing.`,
        { clues, noCluesFor: missing, quota: quota() }
      );
    })
  );

  server.registerTool(
    "generate_clues",
    {
      title: "Generate AI clues for answers",
      description:
        "Write fresh clues for answers with a language model. **MEMBERS ONLY** (the " +
        "free tier gets `403 MEMBERS_ONLY`) and **each answer draws one unit from the " +
        "account's monthly AI-clue allowance** — it costs real money per call, so try " +
        "lookup_clues_bulk first and ask the user before spending here. Nothing is " +
        "written to the shared corpus: a clue only enters it when a puzzle using it " +
        "is published.",
      inputSchema: {
        words: z
          .array(z.string().min(2).max(23))
          .min(1)
          .max(20)
          .describe("Answers to clue. One unit of the AI allowance is spent per answer."),
        count: z.number().int().min(1).max(10).default(3).describe("Clues per answer."),
        language: languageSchema.default("en"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async ({ words, count, language }) => {
      const clues: Record<string, Clue[]> = {};
      let remaining: number | undefined;
      for (const word of words) {
        const generated = await client.generateClues({ word, count, language });
        clues[word.toUpperCase()] = generated.clues;
        remaining = generated.remaining ?? remaining;
      }
      return result(
        `Wrote clues for ${words.length} answer${words.length === 1 ? "" : "s"}. ` +
          `AI clues left this month: ${remaining === -1 ? "unlimited" : (remaining ?? "unknown")}.`,
        { clues, remaining, quota: quota() }
      );
    })
  );

  // --- Grid construction --------------------------------------------------

  server.registerTool(
    "generate_pattern",
    {
      title: "Generate a black-square pattern",
      description:
        "Generate a symmetric black-square pattern. **Runs locally — no network " +
        "call, no quota, free to call as often as you like**, and it is the same " +
        "generator the web constructor uses. Start every new puzzle here.\n\n" +
        "`american` is the NYT shape (180° rotational symmetry, every cell checked) " +
        "and is the reliable one at 11-17; it cannot satisfy sizes below 10 or above " +
        "18 and this tool reports an error rather than returning an all-open grid. " +
        "`british` is the sparse lattice (needs 9+), `freeform` is the most " +
        "forgiving. Free-tier keys can only fill grids up to 13×13.\n\n" +
        "Returns the grid as rows plus the number of answer slots it contains. " +
        "Write theme letters into those rows before calling fill_grid.",
      inputSchema: {
        size: z
          .number()
          .int()
          .min(3)
          .max(23)
          .default(15)
          .describe("Cells a side. 11 and 15 are the safe American sizes."),
        style: z
          .enum(["american", "british", "freeform"])
          .default("american")
          .describe("Grid tradition."),
        target_blacks: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Preferred black-square count. Best-effort only: the generator picks " +
              "its own budget from the size, so this generates several candidates " +
              "and keeps the closest."
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ size, style, target_blacks }) => {
      const pattern = generatePatternResult(size, style, target_blacks);
      return result(
        `${pattern.name} — ${pattern.style}, ${size}×${size}, ${pattern.slots} entries, ` +
          `${pattern.blackCells} black squares (${pattern.blackPercent}%). Generated locally; no quota spent.`,
        pattern
      );
    })
  );

  server.registerTool(
    "fill_grid",
    {
      title: "Auto-fill a grid",
      description:
        "Fill every empty white cell with real words, keeping the black squares and " +
        "any letters already placed — that is how theme answers survive: write them " +
        "into the grid and the solver holds them.\n\n" +
        "**SPENDS one unit of the account's monthly fill allowance, whether or not " +
        "it succeeds.** The quota is charged before the solve, so a fill that comes " +
        "back with nothing still costs a unit — do not retry blindly. A standard " +
        "15×15 takes roughly 1-30 seconds.\n\n" +
        "Leave `min_score` at 40: it is the 'no junk' floor the web constructor " +
        "uses, and 50 makes themed grids grind for minutes. The solver relaxes the " +
        "floor as restarts accumulate, so `quality.rough` lists what it had to " +
        "settle for — hand that grid to improve_fill.\n\n" +
        "A solve that finds nothing is **not** an error: it returns `slotsFilled: 0` " +
        "with a `reason` (`too_difficult`, `no_solution`, `cancelled`). Grid size is " +
        "gated by membership (13×13 free, 23×23 members → `GRID_SIZE_LOCKED`).",
      inputSchema: {
        grid: gridSchema,
        language: languageSchema.default("en"),
        min_score: z
          .number()
          .int()
          .min(0)
          .max(1000)
          .default(40)
          .describe("Quality floor. 40 is the default and the 'no junk' line."),
        max_time: z
          .number()
          .min(1)
          .max(55)
          .default(25)
          .describe("Wall-clock seconds the solver may spend."),
        try_hard_grid: z
          .boolean()
          .default(false)
          .describe(
            "Skip the early 'this grid looks hopeless' checks. Use it when a grid " +
              "you know is fillable keeps coming back `too_difficult`; it costs the " +
              "full time budget on grids that really are hopeless."
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async ({ grid, language, min_score, max_time, try_hard_grid }) => {
      const filled = await client.fillGrid({
        grid,
        language,
        min_score,
        max_time,
        try_hard_grid,
      });
      const rough = filled.quality?.rough ?? [];
      const complete = filled.slotsFilled >= filled.slotsTotal && filled.slotsTotal > 0;
      const summary = complete
        ? `Filled all ${filled.slotsTotal} entries${rough.length ? `, ${rough.length} rough — call improve_fill` : " cleanly"}.`
        : filled.slotsFilled === 0
          ? `Nothing was filled (${filled.reason ?? "no_solution"}). One fill unit was still spent.`
          : `Filled ${filled.slotsFilled} of ${filled.slotsTotal} entries.`;
      return result(summary, {
        ...filled,
        entries: gridEntries(filled.grid, language),
        quota: quota(),
      });
    })
  );

  server.registerTool(
    "improve_fill",
    {
      title: "Clean up a filled grid",
      description:
        "The 'Clean up fill' pass: swap the obscure entries in an already-filled grid " +
        "for common words. Call it when fill_grid came back with a non-empty " +
        "`quality.rough`.\n\n" +
        "**SPENDS one unit of the same monthly fill allowance as fill_grid.**\n\n" +
        "Its core move is a start-over — it backs the whole autofill out and re-fills " +
        "from scratch at a fixed quality floor (50, then 40), which finds clean grids " +
        "that fill_grid's relaxing floor walked past — so expect the grid to come back " +
        "substantially different, not one word changed. Put theme cells in `locked` or " +
        "they will be re-solved away. Words the dictionary does not know are treated " +
        "as your content and are never judged or replaced.\n\n" +
        "`improved: false` means there was nothing rough, or that the junk that " +
        "remains is provably forced by the pattern plus your locked entries — in " +
        "that case stop, do not call it again.",
      inputSchema: {
        grid: gridSchema,
        locked: lockedSchema.default([]),
        language: languageSchema.default("en"),
        max_time: z.number().min(1).max(30).default(25).describe("Wall-clock seconds."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async ({ grid, locked, language, max_time }) => {
      const improved = await client.improveFill({ grid, locked, language, max_time });
      const finalGrid = improved.grid ?? grid;
      const rough = improved.quality?.rough ?? [];
      return result(
        improved.improved
          ? `Cleaned up: ${improved.replaced ?? "several"} entries replaced, ${rough.length} still rough.`
          : rough.length > 0
            ? "Nothing changed — the remaining junk is forced by the pattern plus your locked cells. Do not retry."
            : "Nothing to do; the fill was already clean.",
        {
          ...improved,
          grid: finalGrid,
          entries: gridEntries(finalGrid, language),
          quota: quota(),
        }
      );
    })
  );

  // --- Puzzles ------------------------------------------------------------

  server.registerTool(
    "list_puzzles",
    {
      title: "List your puzzles",
      description:
        "Every puzzle owned by this API key's account, drafts and published alike, " +
        "newest edit first. Free. There is no endpoint for browsing other people's " +
        "work — use get_puzzle with a known id for a published puzzle.",
      inputSchema: {
        status: z.enum(["draft", "published"]).optional().describe("Filter by lifecycle state."),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ status, limit, offset }) => {
      const listed = await client.listPuzzles({ status, limit, offset });
      return result(`${listed.total} puzzle${listed.total === 1 ? "" : "s"}.`, {
        ...listed,
        quota: quota(),
      });
    })
  );

  server.registerTool(
    "get_puzzle",
    {
      title: "Get one puzzle",
      description:
        "A puzzle owned by this key's account, or any **published** puzzle by its id " +
        "— the same reach a share link has. Free. Someone else's draft returns 404, " +
        "not 403: the API does not confirm that an id it will not show you exists.",
      inputSchema: { id: z.string().min(1).describe("The puzzle id, e.g. `k3n8q1zp`.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ id }) => {
      const puzzle = await client.getPuzzle(id);
      return result(
        `${puzzle.title} — ${puzzle.size}×${puzzle.size} ${puzzle.language}, ${puzzle.status}.`,
        { ...puzzlePayload(origin, puzzle), entries: gridEntries(puzzle.grid, puzzle.language) }
      );
    })
  );

  server.registerTool(
    "create_puzzle",
    {
      title: "Create a puzzle",
      description:
        "Save a new puzzle to this key's account. The grid's own length is the size, " +
        "so there is no size field to keep in sync. Clue maps are keyed by the clue " +
        "numbers returned as `entries` by fill_grid — not by row, and not by " +
        "position.\n\n" +
        "`publish: true` creates it already published **unlisted** (public URL and " +
        "embeddable frame, no showcase submission) and applies the full " +
        "publish-readiness check first: a title, plus a clue for every entry whose " +
        "answer is complete. If that check fails the whole write fails with " +
        "`VALIDATION_ERROR` and **nothing is stored** — so when clues are still " +
        "partial, leave `publish` off and call publish_puzzle later. Grid size is " +
        "gated by membership (13×13 free, 23×23 members).",
      inputSchema: {
        title: z.string().min(1).max(200),
        author: z.string().max(100).optional().describe("Byline shown on the puzzle page."),
        language: languageSchema.default("en"),
        grid: gridSchema,
        clues: cluesSchema
          .optional()
          .describe("Clue text keyed by clue number, split by direction."),
        themeWords: z
          .array(z.string())
          .optional()
          .describe("Answers that carry the theme. Recorded, not enforced."),
        writeup: z
          .string()
          .max(2000)
          .optional()
          .describe("Constructor's note. Truncated to 2,000 characters, never rejected."),
        publish: z
          .boolean()
          .default(false)
          .describe("Publish on creation, unlisted. Requires a complete clue set."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async (args) => {
      const input: PuzzleInput = {
        title: args.title,
        language: args.language,
        grid: args.grid,
        ...(args.author !== undefined ? { author: args.author } : {}),
        ...(args.clues !== undefined ? { clues: args.clues } : {}),
        ...(args.themeWords !== undefined ? { themeWords: args.themeWords } : {}),
        ...(args.writeup !== undefined ? { writeup: args.writeup } : {}),
        ...(args.publish ? { publish: true } : {}),
      };
      const puzzle = await client.createPuzzle(input);
      return result(
        `Created ${puzzle.id} — ${puzzle.size}×${puzzle.size}, ${puzzle.status}.` +
          (puzzle.status === "published"
            ? " Published unlisted; call publish_puzzle with showcase: true to enter the public queue."
            : " Call publish_puzzle to mint its public URL."),
        { ...puzzlePayload(origin, puzzle), quota: quota() }
      );
    })
  );

  server.registerTool(
    "update_puzzle",
    {
      title: "Update a puzzle",
      description:
        "Change any subset of a puzzle you own. The pre-edit state is snapshotted to " +
        "version history first, and editing a published puzzle re-runs the moderation " +
        "scan.\n\n" +
        "**`clues` is replaced, not merged.** Sending `clues` at all replaces both " +
        "direction maps, so a patch carrying one clue leaves the puzzle with one clue " +
        "— always send the full across and down maps you want it to end up with. " +
        "Every other field is a true partial: omit it and it is left alone.",
      inputSchema: {
        id: z.string().min(1),
        title: z.string().min(1).max(200).optional(),
        author: z.string().max(100).optional(),
        language: languageSchema.optional(),
        grid: gridSchema.optional(),
        clues: cluesSchema
          .optional()
          .describe("Replaces BOTH direction maps wholesale. Send the complete set."),
        themeWords: z.array(z.string()).optional(),
        writeup: z.string().max(2000).optional(),
        showProfile: z.boolean().optional(),
        noIndex: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async ({ id, ...rest }) => {
      const patch = Object.fromEntries(
        Object.entries(rest).filter(([, value]) => value !== undefined)
      ) as PuzzlePatch;
      if (Object.keys(patch).length === 0) {
        throw new Error("Nothing to update — pass at least one field besides `id`.");
      }
      const puzzle = await client.updatePuzzle(id, patch);
      return result(`Updated ${puzzle.id} — ${puzzle.title}.`, {
        ...puzzlePayload(origin, puzzle),
        quota: quota(),
      });
    })
  );

  server.registerTool(
    "delete_puzzle",
    {
      title: "Delete a puzzle",
      description:
        "Permanently delete a puzzle you own, published or not. **Not reversible " +
        "through the API** — version history goes with it, and a published puzzle's " +
        "public URL and any live embeds stop working. Confirm with the user first.",
      inputSchema: { id: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ id }) => {
      await client.deletePuzzle(id);
      return result(`Deleted ${id}. This cannot be undone.`, { deleted: id });
    })
  );

  server.registerTool(
    "publish_puzzle",
    {
      title: "Publish a puzzle",
      description:
        "Move a draft to published, which mints its public URL and its embeddable " +
        "frame, and returns a paste-ready `embedSnippet` (iframe + resize script + " +
        "attribution caption) — the same snippet the site's Embed dialog hands out.\n\n" +
        "**Publishes unlisted by default.** `showcase: true` additionally submits it " +
        "to the public showcase queue, which a human reads — only pass it when the " +
        "user has asked for it. Publishing needs a title and a clue for every entry " +
        "whose answer is complete, or it is refused with `VALIDATION_ERROR` and a " +
        "`missingClues` list. Re-publishing is idempotent: a puzzle already in the " +
        "queue keeps its place and its two-day clock.",
      inputSchema: {
        id: z.string().min(1),
        showcase: z
          .boolean()
          .default(false)
          .describe("Enter the public showcase review queue. Ask the user first."),
        writeup: z.string().max(2000).optional().describe("Constructor's note."),
        showProfile: z.boolean().optional().describe("Link it from the author's public page."),
        noIndex: z.boolean().optional().describe("Ask search engines to stay away."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ id, showcase, writeup, showProfile, noIndex }) => {
      const puzzle = await client.publishPuzzle(id, {
        submitToShowcase: showcase,
        ...(writeup !== undefined ? { writeup } : {}),
        ...(showProfile !== undefined ? { showProfile } : {}),
        ...(noIndex !== undefined ? { noIndex } : {}),
      });
      return result(
        `${puzzle.title} is ${puzzle.status}, showcase=${puzzle.showcaseStatus ?? "unlisted"}. ` +
          `Public URL: ${puzzle.url ?? `${origin}/puzzle/${puzzle.id}`}`,
        { ...puzzlePayload(origin, puzzle), quota: quota() }
      );
    })
  );

  server.registerTool(
    "export_puzzle",
    {
      title: "Export a puzzle",
      description:
        "Download a puzzle in a solver-readable format. Free.\n\n" +
        "`json` returns the puzzle document. `html` returns one self-contained " +
        "playable page (grid, clues, small player, no external requests) as text, " +
        "for hosting on the user's own site so the clues live in their page rather " +
        "than an iframe; it needs a full grid with every entry clued. `svg` returns " +
        "the numbered grid alone as an SVG document (no clues; `solution: true` " +
        "draws the answers) for laying out a page yourself. `puz` (Across Lite) and " +
        "`pdf` (one printable page on `paper: letter|a4`, `solution: true` for the " +
        "answer key) are binary and come back **base64-encoded**, because stdio MCP " +
        "cannot hand back a file — decode and write the bytes (`base64 -d`, or " +
        "`Buffer.from(data, \"base64\")`) using the `filename` given. The .puz writer " +
        "is single-byte ISO-8859-1, so a non-Latin language returns " +
        "`VALIDATION_ERROR` rather than a corrupt file — check `puzExportable` in " +
        "list_languages first; `pdf` likewise refuses CJK, Devanagari and Thai scripts.",
      inputSchema: {
        id: z.string().min(1),
        format: z.enum(["json", "puz", "html", "pdf", "svg"]).default("json"),
        paper: z.enum(["letter", "a4"]).optional().describe("pdf only: page size (default letter)."),
        solution: z.boolean().optional().describe("pdf and svg: draw the answers."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ id, format, paper, solution }) => {
      if (format === "json") {
        const puzzle = await client.exportPuzzle(id, { format: "json" });
        return result(`${puzzle.title} as JSON.`, puzzle);
      }
      if (format === "html" || format === "svg") {
        const { data, filename } =
          format === "html"
            ? await client.exportPuzzle(id, { format: "html" })
            : await client.exportPuzzle(id, { format: "svg", solution });
        return result(`${data.length} characters of ${format.toUpperCase()}. Save as ${filename}.`, {
          filename,
          data,
        });
      }
      const { data, filename } =
        format === "puz"
          ? await client.exportPuzzle(id, { format: "puz" })
          : await client.exportPuzzle(id, { format: "pdf", paper, solution });
      const what = format === "puz" ? "Across Lite .puz" : "PDF";
      return result(
        `${data.length} bytes of ${what}, base64-encoded. Decode it and save as ${filename}.`,
        {
          filename,
          encoding: "base64",
          bytes: data.length,
          data: Buffer.from(data).toString("base64"),
        }
      );
    })
  );

  // --- Prompt -------------------------------------------------------------

  server.registerPrompt(
    "compose_puzzle",
    {
      title: "Compose and publish a puzzle",
      description:
        "The end-to-end recipe: generate a pattern, place theme answers, fill, clue, " +
        "create, publish, and return the embed snippet — with the quota costs of each " +
        "step called out.",
      argsSchema: {
        theme: z
          .string()
          .describe("What the puzzle is about, e.g. 'lighthouses' or 'jazz standards'."),
        size: z
          .string()
          .optional()
          .describe("Cells a side, as a string (default 11). Free-tier keys cap at 13."),
        language: z.string().optional().describe("Language code (default en)."),
      },
    },
    ({ theme, size, language }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Build and publish a ${size ?? "11"}×${size ?? "11"} crossword about ` +
              `${theme}${language && language !== "en" ? ` in ${language}` : ""}, then give me the embed snippet.\n\n` +
              `Follow this workflow exactly:\n\n${WORKFLOW}\n\n` +
              "Before any step that spends quota (fill_grid, improve_fill, " +
              "generate_clues), say what it will cost. Do not submit to the showcase " +
              "unless I ask. Finish by showing me the public URL and the embed snippet.",
          },
        },
      ],
    })
  );

  return server;
}

// --- Process entry point ---------------------------------------------------

/**
 * Point `console.*` at stderr.
 *
 * stdout is the JSON-RPC channel: one stray `console.log` — ours, or a
 * dependency's — corrupts the stream and the client drops the connection with
 * nothing useful to show for it. `console.error` already goes to stderr, so
 * this only moves the three that do not.
 */
function redirectConsoleToStderr(): void {
  const toStderr = (...args: unknown[]) => {
    process.stderr.write(
      `${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`
    );
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;
}

/**
 * Start the server on stdio and resolve when the connection closes.
 *
 * Resolves rather than exits so the caller decides the exit code — `xword mcp`
 * returns it from `run()` like every other command.
 */
export async function startMcpServer(options: McpServerOptions = {}): Promise<void> {
  const server = createMcpServer(options);
  const transport = new StdioServerTransport();

  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
  });

  const shutdown = () => {
    void server.close().catch(() => undefined);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await server.connect(transport);
  await closed;
}

/**
 * `xword mcp`. Returns the process exit code.
 *
 * The banner goes to stderr — a client that spawned us sees it in its server
 * log, and stdout stays clean for the protocol.
 */
export async function runMcpCli(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  redirectConsoleToStderr();
  const { source } = resolveApiKey(env);
  const baseUrl = resolveBaseUrl(DEFAULT_BASE_URL, env);
  process.stderr.write(
    `xword ${VERSION} MCP server on stdio — ${baseUrl}\n` +
      `  key: ${
        source === "none"
          ? "none (get_status and list_languages work; everything else will return UNAUTHORIZED)"
          : source === "env"
            ? "from CROSSWORD_API_KEY"
            : "from the xword login config file"
      }\n`
  );

  try {
    await startMcpServer({ env });
    return 0;
  } catch (error) {
    process.stderr.write(
      `MCP server failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
}

// No self-execute guard here on purpose. tsup bundles this module's chunk for
// `dist/cli.js` too, and an `import.meta.url === argv[1]` check would then be
// true for *every* `xword` invocation and start a server instead of running the
// command. `xword mcp` is the entry point; `xword/mcp` is the import.
