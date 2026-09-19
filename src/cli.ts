#!/usr/bin/env node
/**
 * `xword` — the Crossword Generator CLI.
 *
 * Every command is the same shape: resolve a key, call one client method, print
 * either prose or `--json`. Two things are deliberate:
 *
 * * **The key is never printed and never taken on the command line.** `xword
 *   login` prompts without echo; a flag would land in shell history and in
 *   `ps`. `status` reports where the key came from, never what it is.
 * * **Commands that spend quota say so before they spend it.** `fill`,
 *   `improve` and `generate-clues` all draw from a monthly allowance; the last
 *   asks for confirmation because it costs money per call.
 *
 * Exit codes: 0 success, 1 an API problem or a failed solve, 2 a usage error.
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import {
  CrosswordClient,
  DEFAULT_BASE_URL,
  type Clue,
  type FillResult,
  type Language,
  type LanguageCode,
  type Puzzle,
  type PuzzleInput,
  type PuzzlePatch,
  type ExportFormat,
} from "./client.js";
import { CrosswordApiError } from "./errors.js";
import {
  COMMANDS,
  UsageError,
  parseArgv,
  type FlagValues,
} from "./cliArgs.js";
import { VERSION, commandHelp, topLevelHelp } from "./cliHelp.js";
import {
  clearConfig,
  configPath,
  maskApiKey,
  readConfig,
  resolveApiKey,
  resolveBaseUrl,
  writeConfig,
} from "./config.js";
import {
  cellsToGrid,
  countBlackCells,
  formatGridText,
  gridUnits,
  parseGridText,
  type PublicGrid,
} from "./grid.js";
import {
  generateAmericanPattern,
  generateBritishPattern,
  generateFreeformPattern,
  isPuzzleLanguage,
} from "./local.js";
// `./mcp.js` is imported dynamically in the `mcp` case below, not here: it
// pulls in the MCP SDK, and paying that load cost on every `xword words` would
// be silly — worse, it would make the CLI unusable if the SDK were missing.

// --- IO seam --------------------------------------------------------------

export interface Io {
  out(text: string): void;
  err(text: string): void;
  outBytes(bytes: Uint8Array): void;
  env: NodeJS.ProcessEnv;
  isTty: boolean;
  readStdin(): Promise<string>;
  promptSecret(question: string): Promise<string>;
  confirm(question: string): Promise<boolean>;
}

const nodeIo: Io = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  outBytes: (bytes) => process.stdout.write(Buffer.from(bytes)),
  env: process.env,
  get isTty() {
    return Boolean(process.stdin.isTTY);
  },
  async readStdin() {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  },
  promptSecret(question) {
    if (!process.stdin.isTTY) return nodeIo.readStdin().then((s) => s.trim());
    // readline has no masked prompt, and its `_writeToOutput` echo hook — the
    // old trick for muting one — is private and gone as of Node 25. Raw mode
    // needs no internals: read keystrokes ourselves and echo nothing.
    const stdin = process.stdin;
    process.stdout.write(question);
    return new Promise<string>((resolve, reject) => {
      let buffer = "";
      const wasRaw = stdin.isRaw;
      const finish = (err?: Error) => {
        stdin.off("data", onData);
        stdin.setRawMode(wasRaw);
        stdin.pause();
        process.stdout.write("\n");
        if (err) reject(err);
        else resolve(buffer.trim());
      };
      const onData = (chunk: Buffer) => {
        for (const ch of chunk.toString("utf8")) {
          if (ch === "\u0003") return finish(new Error("Cancelled"));
          if (ch === "\r" || ch === "\n") return finish();
          if (ch === "\u007f" || ch === "\b") buffer = buffer.slice(0, -1);
          else if (ch >= " ") buffer += ch;
        }
      };
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
    });
  },
  async confirm(question) {
    if (!process.stdin.isTTY) return false;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(`${question} [y/N] `);
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  },
};

// --- Small helpers --------------------------------------------------------

const str = (flags: FlagValues, name: string): string | undefined =>
  typeof flags[name] === "string" ? (flags[name] as string) : undefined;
const num = (flags: FlagValues, name: string): number | undefined =>
  typeof flags[name] === "number" ? (flags[name] as number) : undefined;
const bool = (flags: FlagValues, name: string): boolean => flags[name] === true;
const list = (flags: FlagValues, name: string): string[] =>
  Array.isArray(flags[name]) ? (flags[name] as string[]) : [];

/**
 * The `--lang` code, validated against the language registry before any request
 * goes out. Catching a typo'd code here beats a 400 from the server, and it is
 * the same list the grid codec normalizes letters against.
 */
function langOf(flags: FlagValues): LanguageCode {
  const value = str(flags, "lang") ?? "en";
  if (!isPuzzleLanguage(value)) {
    throw new UsageError(
      `Unknown language code "${value}". Run \`xword languages\` for the list.`
    );
  }
  return value;
}

/** Read a file argument, or all of stdin when it is `-`. */
async function readInput(path: string, io: Io): Promise<string> {
  if (path === "-") return io.readStdin();
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new UsageError(
      `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function readJsonInput<T>(path: string, io: Io): Promise<T> {
  const text = await readInput(path, io);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new UsageError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function writeOut(
  io: Io,
  text: string,
  out: string | undefined,
  quiet: boolean,
  label: string
): void {
  if (out) {
    writeFileSync(out, text);
    if (!quiet) io.err(`${label} → ${out}\n`);
  } else {
    io.out(text);
  }
}

function emitJson(io: Io, value: unknown): void {
  io.out(`${JSON.stringify(value, null, 2)}\n`);
}

/** Validate `r,c` strings and check they sit inside the grid. */
function parseLockFlags(values: string[], grid: PublicGrid, language: string): Array<[number, number]> {
  const size = grid.length;
  return values.map((raw) => {
    const match = /^(\d{1,2}),(\d{1,2})$/.exec(raw.trim());
    if (!match) {
      throw new UsageError(`--lock expects "row,col" with zero-based indices, got ${raw}`);
    }
    const row = Number(match[1]);
    const col = Number(match[2]);
    if (row >= size || col >= size) {
      throw new UsageError(`--lock ${raw} is outside a ${size}×${size} grid`);
    }
    const units = gridUnits(grid[row], language);
    if (units[col] === "#") {
      throw new UsageError(`--lock ${raw} points at a black square`);
    }
    return [row, col] as [number, number];
  });
}

function requireKey(io: Io): string {
  const { key } = resolveApiKey(io.env);
  if (!key) {
    throw new UsageError(
      "No API key. Run `xword login`, or set CROSSWORD_API_KEY.\n" +
        "Mint a key at https://crossword.texs.org/dashboard?tab=api (Dashboard → API)."
    );
  }
  return key;
}

function makeClient(io: Io, flags: FlagValues, withKey: boolean): CrosswordClient {
  return new CrosswordClient({
    apiKey: withKey ? requireKey(io) : resolveApiKey(io.env).key,
    baseUrl: str(flags, "base") ?? resolveBaseUrl(DEFAULT_BASE_URL, io.env),
  });
}

function renderGrid(grid: PublicGrid): string {
  return grid.map((row) => `  ${row}`).join("\n");
}

function renderClues(clues: Clue[]): string {
  if (clues.length === 0) return "  (no clues in the corpus)";
  return clues
    .map((clue) => {
      const pubs = typeof clue.pubCount === "number" ? `, ${clue.pubCount} pubs` : "";
      return `  • ${clue.text}  [${clue.source}${pubs}]`;
    })
    .join("\n");
}

function renderPuzzleLine(puzzle: Puzzle): string {
  const showcase = puzzle.showcaseStatus ?? "unlisted";
  return `  ${puzzle.id}  ${puzzle.size}×${puzzle.size}  ${puzzle.language}  ` +
    `${puzzle.status}/${showcase}  ${puzzle.title}`;
}

/**
 * Why a 200 fill came back empty. Present only when the solver found nothing —
 * a fill that produced no grid is still a successful request, so this is how
 * the CLI tells "the solve failed" from "the call failed".
 */
function fillReason(result: FillResult): string | undefined {
  return result.reason;
}

// --- Commands -------------------------------------------------------------

async function cmdLogin(io: Io, flags: FlagValues): Promise<number> {
  io.err("Paste an API key (input is hidden). Mint one at https://crossword.texs.org/dashboard?tab=api (Dashboard → API).\n");
  const key = await io.promptSecret("API key: ");
  if (!key) throw new UsageError("No key entered.");
  if (!/^cw_[a-z]+_[A-Za-z0-9]{16,}$/.test(key)) {
    io.err("Warning: that does not look like a cw_live_… key. Storing it anyway.\n");
  }

  const baseUrl = str(flags, "base") ?? io.env.CROSSWORD_API_BASE;
  const existing = readConfig(io.env);
  const path = writeConfig(
    { ...existing, apiKey: key, ...(baseUrl ? { baseUrl } : {}) },
    io.env
  );

  // Prove the key works before declaring success — a typo'd paste that only
  // fails on the next command is a worse experience than failing here.
  const client = new CrosswordClient({
    apiKey: key,
    baseUrl: baseUrl ?? resolveBaseUrl(DEFAULT_BASE_URL, io.env),
  });
  try {
    await client.searchWords({ pattern: "C_T", limit: 1 });
    io.err(`Key stored in ${path} (mode 0600) and verified.\n`);
  } catch (error) {
    if (error instanceof CrosswordApiError && error.status === 401) {
      clearConfig(io.env);
      throw new UsageError("That key was rejected (401). Nothing was stored.");
    }
    io.err(`Key stored in ${path} (mode 0600); could not verify it right now.\n`);
  }
  if (io.env.CROSSWORD_API_KEY) {
    io.err("Note: CROSSWORD_API_KEY is set and takes precedence over the stored key.\n");
  }
  return 0;
}

function cmdLogout(io: Io): number {
  const removed = clearConfig(io.env);
  io.err(removed ? `Removed ${configPath(io.env)}\n` : "No stored key to remove.\n");
  if (io.env.CROSSWORD_API_KEY) {
    io.err("CROSSWORD_API_KEY is still set in this shell; unset it to finish logging out.\n");
  }
  return 0;
}

async function cmdStatus(io: Io, flags: FlagValues): Promise<number> {
  const client = makeClient(io, flags, false);
  const { source, key } = resolveApiKey(io.env);
  const status = await client.getStatus();
  const entries = Object.entries(status.languages ?? {});
  const resident = entries.filter(([, v]) => v.loaded).map(([code]) => code);
  const available = entries.filter(([, v]) => v.available).length;

  if (bool(flags, "json")) {
    emitJson(io, {
      ...status,
      baseUrl: client.baseUrl,
      auth: { source, key: key ? maskApiKey(key) : null },
    });
    return 0;
  }

  io.out(`${client.baseUrl}\n`);
  io.out(`  status      ${status.status}, contract v${status.version}\n`);
  io.out(`  languages   ${available} available of ${entries.length}\n`);
  io.out(`  resident    ${resident.length ? resident.join(", ") : "none"}\n`);
  io.out(
    `  key         ${
      source === "none"
        ? "not set — run `xword login` (status and languages need none)"
        : `${maskApiKey(key ?? "")} (from ${source === "env" ? "CROSSWORD_API_KEY" : configPath(io.env)})`
    }\n`
  );
  return 0;
}

async function cmdLanguages(io: Io, flags: FlagValues): Promise<number> {
  const client = makeClient(io, flags, false);
  let languages: Language[] = await client.listLanguages();
  if (bool(flags, "available")) languages = languages.filter((l) => l.available);

  if (bool(flags, "json")) {
    emitJson(io, languages);
    return 0;
  }
  io.out(`  code  name                 native                available  notes\n`);
  for (const language of languages) {
    const notes = [
      language.crissCrossOnly ? "criss-cross only" : "",
      language.rtl ? "rtl" : "",
      language.puzExportable ? "" : "no .puz",
      language.minSlotLength !== 3 ? `min slot ${language.minSlotLength}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    const row =
      `  ${language.code.padEnd(6)}${language.name.padEnd(21)}` +
      `${language.nativeName.padEnd(22)}${(language.available ? "yes" : "no").padEnd(11)}${notes}`;
    io.out(`${row.trimEnd()}\n`);
  }
  return 0;
}

async function cmdWords(io: Io, args: string[], flags: FlagValues): Promise<number> {
  const client = makeClient(io, flags, true);
  const words = await client.searchWords({
    pattern: args[0],
    lang: langOf(flags),
    min_score: num(flags, "min-score"),
    limit: num(flags, "limit"),
  });
  if (bool(flags, "json")) {
    emitJson(io, words);
    return 0;
  }
  if (words.length === 0) {
    io.out(`  no matches for ${args[0]}\n`);
    return 0;
  }
  for (const match of words) io.out(`  ${String(match.score).padStart(3)}  ${match.word}\n`);
  return 0;
}

async function cmdClues(io: Io, args: string[], flags: FlagValues): Promise<number> {
  const client = makeClient(io, flags, true);
  const clues = await client.lookupClues(args[0], {
    language: langOf(flags),
    limit: num(flags, "limit"),
  });
  if (bool(flags, "json")) {
    emitJson(io, clues);
    return 0;
  }
  io.out(`${args[0].toUpperCase()}\n${renderClues(clues)}\n`);
  return 0;
}

async function cmdScores(io: Io, args: string[], flags: FlagValues): Promise<number> {
  const client = makeClient(io, flags, true);
  const scores = await client.scoreWords({
    words: args,
    language: langOf(flags),
  });
  if (bool(flags, "json")) {
    emitJson(io, scores);
    return 0;
  }
  for (const word of args) {
    const key = word.toUpperCase();
    const score = scores[key] ?? scores[word];
    io.out(
      `  ${score === undefined ? "  —" : String(score).padStart(3)}  ${word}` +
        `${score === undefined ? "   (not in the index — fine for a theme answer)" : ""}\n`
    );
  }
  return 0;
}

function cmdPattern(io: Io, flags: FlagValues): number {
  const size = num(flags, "size") ?? 15;
  if (!Number.isInteger(size) || size < 3 || size > 23) {
    throw new UsageError(`--size must be a whole number from 3 to 23, got ${size}`);
  }
  const style = str(flags, "style") ?? "american";
  if (!["american", "british", "freeform"].includes(style)) {
    throw new UsageError("--style must be american, british or freeform");
  }
  const generate = () =>
    style === "british"
      ? generateBritishPattern(size)
      : style === "freeform"
        ? generateFreeformPattern(size)
        : generateAmericanPattern(size);

  // Each generator gives up after its own attempt budget and returns an
  // all-white grid rather than throwing. That grid is not a crossword — every
  // row and column is one giant entry — and auto-fill refuses it, so retry a
  // few times and say plainly what happened if the size is one the generator
  // cannot satisfy (today: American below 10 and above 18).
  let info = generate();
  for (let attempt = 0; attempt < 9 && countBlackCells(cellsToGrid(info.grid)) === 0; attempt++) {
    info = generate();
  }

  const grid = cellsToGrid(info.grid);
  const openGrid = countBlackCells(grid) === 0;
  if (openGrid) {
    io.err(
      `The ${style} generator could not place any black squares at ${size}×${size}, ` +
        "so this grid is one open rectangle — auto-fill will refuse it.\n" +
        "  Try a size between 10 and 18, or a different --style.\n"
    );
    if (!bool(flags, "json")) return 1;
  }

  if (bool(flags, "json")) {
    emitJson(io, {
      grid,
      style: info.style,
      name: info.name,
      wordCount: info.wordCount,
      blackPercent: info.blackPercent,
      difficulty: info.difficulty,
      ...(openGrid ? { openGrid: true } : {}),
    });
    return openGrid ? 1 : 0;
  }
  if (!bool(flags, "quiet") && !str(flags, "out")) {
    io.err(
      `${info.name} — ${info.style}, ${info.wordCount} entries, ` +
        `${info.blackPercent}% black (generated locally, no quota spent)\n`
    );
  }
  writeOut(io, formatGridText(grid), str(flags, "out"), bool(flags, "quiet"), "Pattern");
  return 0;
}

async function cmdFill(io: Io, args: string[], flags: FlagValues): Promise<number> {
  const client = makeClient(io, flags, true);
  const language = langOf(flags);
  const grid = parseGridText(await readInput(args[0], io), language);
  // POST /fill has no `locked` list — every letter already in the grid is held
  // — so --lock here is a pre-flight assertion, not a request field.
  for (const [row, col] of parseLockFlags(list(flags, "lock"), grid, language)) {
    if (gridUnits(grid[row], language)[col] === ".") {
      throw new UsageError(
        `--lock ${row},${col} is an empty cell. /fill holds letters that are already ` +
          "placed; put the letter in the grid file, or use `xword improve --lock`."
      );
    }
  }

  const request = {
    grid,
    language,
    min_score: num(flags, "min-score"),
    max_time: num(flags, "max-time"),
    try_hard_grid: bool(flags, "try-hard") || undefined,
  };

  if (bool(flags, "stream")) return fillStreaming(io, client, request, flags);

  const result = await client.fillGrid(request);
  return reportFill(io, result, flags);
}

async function fillStreaming(
  io: Io,
  client: CrosswordClient,
  request: Parameters<CrosswordClient["fillGrid"]>[0],
  flags: FlagValues
): Promise<number> {
  const quiet = bool(flags, "quiet") || bool(flags, "json");
  let sessionId: string | undefined;

  for await (const event of client.fillGridStream(request)) {
    if (event.type === "session") {
      sessionId = event.sessionId;
      if (!quiet) io.err(`session ${event.sessionId}\n`);
    } else if (event.type === "progress") {
      // Progress is not monotonic — the solver backtracks — so this overwrites
      // one line rather than scrolling a log that appears to go backwards.
      if (!quiet) io.err(`\r  filling ${event.filled}/${event.total}   `);
    } else if (event.type === "complete") {
      if (!quiet) io.err("\r                            \r");
      return reportFill(
        io,
        {
          grid: event.grid,
          slotsFilled: event.slotsFilled,
          slotsTotal: event.slotsTotal,
          quality: event.quality,
          ...(sessionId ? { sessionId } : {}),
        },
        flags
      );
    } else if (event.type === "error") {
      if (!quiet) io.err("\r                            \r");
      if (bool(flags, "json")) {
        emitJson(io, event);
      } else {
        io.err(`Fill failed: ${event.reason}${event.message ? ` — ${event.message}` : ""}\n`);
      }
      return 1;
    }
  }
  io.err("The fill stream ended without a result.\n");
  return 1;
}

function reportFill(io: Io, result: FillResult, flags: FlagValues): number {
  if (bool(flags, "json")) {
    emitJson(io, result);
  } else {
    const rough = result.quality?.rough ?? [];
    if (!bool(flags, "quiet")) {
      io.err(
        `${result.slotsFilled}/${result.slotsTotal} entries, ${rough.length} rough` +
          `${result.sessionId ? `, session ${result.sessionId}` : ""}\n`
      );
      for (const entry of rough) {
        io.err(`  rough  ${entry.word} (${entry.score}) ${entry.number}-${entry.direction}\n`);
      }
      if (rough.length > 0) io.err("  → `xword improve` re-fills these at a fixed floor.\n");
    }
    writeOut(io, formatGridText(result.grid), str(flags, "out"), bool(flags, "quiet"), "Grid");
  }

  if (result.slotsFilled === 0 && result.slotsTotal > 0) {
    const reason = fillReason(result) ?? "no_solution";
    io.err(`Nothing was filled (${reason}).\n`);
    if (reason === "too_difficult") {
      io.err("  Try --try-hard, a lower --min-score, or a pattern with shorter entries.\n");
    }
    return 1;
  }
  return 0;
}

async function cmdImprove(io: Io, args: string[], flags: FlagValues): Promise<number> {
  const client = makeClient(io, flags, true);
  const language = langOf(flags);
  const grid = parseGridText(await readInput(args[0], io), language);
  const locked = parseLockFlags(list(flags, "lock"), grid, language).map(
    ([row, col]) => `${row},${col}`
  );

  const result = await client.improveFill({
    grid,
    locked,
    language,
    max_time: num(flags, "max-time"),
  });

  if (bool(flags, "json")) {
    emitJson(io, result);
  } else {
    const rough = result.quality?.rough ?? [];
    io.err(
      `improved=${result.improved}` +
        `${result.replaced !== undefined ? ` replaced=${result.replaced}` : ""}` +
        ` rough=${rough.length}\n`
    );
    if (!result.improved && rough.length > 0) {
      io.err("  The junk that remains is forced by the pattern plus your locked cells.\n");
    }
    const finalGrid = result.grid ?? grid;
    writeOut(io, formatGridText(finalGrid), str(flags, "out"), bool(flags, "quiet"), "Grid");
  }
  return 0;
}

async function cmdPuzzlesList(io: Io, flags: FlagValues): Promise<number> {
  const client = makeClient(io, flags, true);
  const result = await client.listPuzzles({
    status: str(flags, "status") as "draft" | "published" | undefined,
    limit: num(flags, "limit"),
    offset: num(flags, "offset"),
  });
  if (bool(flags, "json")) {
    emitJson(io, result);
    return 0;
  }
  io.out(`${result.total} puzzle${result.total === 1 ? "" : "s"}\n`);
  for (const puzzle of result.puzzles) io.out(`${renderPuzzleLine(puzzle)}\n`);
  return 0;
}

async function cmdPuzzlesGet(io: Io, args: string[], flags: FlagValues): Promise<number> {
  const client = makeClient(io, flags, true);
  const puzzle = await client.getPuzzle(args[0]);
  if (bool(flags, "json")) {
    emitJson(io, puzzle);
    return 0;
  }
  io.out(`${puzzle.title} — ${puzzle.author || "no byline"}\n`);
  io.out(`  ${puzzle.size}×${puzzle.size} ${puzzle.language}, ${puzzle.status}`);
  io.out(`${puzzle.showcaseStatus ? `/${puzzle.showcaseStatus}` : ""}\n`);
  io.out(`${renderGrid(puzzle.grid)}\n`);
  if (puzzle.url) io.out(`  ${puzzle.url}\n`);
  if (puzzle.embedUrl) io.out(`  ${puzzle.embedUrl}\n`);
  return 0;
}

async function cmdPuzzlesCreate(io: Io, args: string[], flags: FlagValues): Promise<number> {
  const client = makeClient(io, flags, true);
  const input = await readJsonInput<PuzzleInput>(args[0], io);
  if (bool(flags, "publish")) input.publish = true;
  const idempotencyKey = str(flags, "idempotency-key");
  const puzzle = await client.createPuzzle(
    input,
    idempotencyKey === undefined ? {} : { idempotencyKey }
  );
  if (bool(flags, "json")) emitJson(io, puzzle);
  else io.out(`created ${puzzle.id} — ${puzzle.size}×${puzzle.size}, ${puzzle.status}\n`);
  return 0;
}

async function cmdPuzzlesUpdate(io: Io, args: string[], flags: FlagValues): Promise<number> {
  const client = makeClient(io, flags, true);
  const patch = await readJsonInput<PuzzlePatch>(args[1], io);
  const puzzle = await client.updatePuzzle(args[0], patch);
  if (bool(flags, "json")) emitJson(io, puzzle);
  else io.out(`updated ${puzzle.id} — ${puzzle.title}\n`);
  return 0;
}

async function cmdPuzzlesDelete(io: Io, args: string[], flags: FlagValues): Promise<number> {
  const client = makeClient(io, flags, true);
  if (!bool(flags, "yes")) {
    const ok = await io.confirm(`Permanently delete ${args[0]} and its history?`);
    if (!ok) {
      io.err("Cancelled. Pass --yes to delete without a prompt.\n");
      return 2;
    }
  }
  await client.deletePuzzle(args[0]);
  if (bool(flags, "json")) emitJson(io, { deleted: args[0] });
  else io.err(`deleted ${args[0]}\n`);
  return 0;
}

async function cmdPuzzlesPublish(io: Io, args: string[], flags: FlagValues): Promise<number> {
  const client = makeClient(io, flags, true);
  const puzzle = await client.publishPuzzle(args[0], {
    // Unlisted by default: --showcase is an opt-in to a human review queue,
    // which is not something a CLI should enter on your behalf.
    submitToShowcase: bool(flags, "showcase"),
    ...(str(flags, "writeup") ? { writeup: str(flags, "writeup") } : {}),
    ...(bool(flags, "show-profile") ? { showProfile: true } : {}),
    ...(bool(flags, "no-index") ? { noIndex: true } : {}),
  });
  if (bool(flags, "json")) {
    emitJson(io, puzzle);
    return 0;
  }
  io.out(`${puzzle.status}, showcase=${puzzle.showcaseStatus ?? "unlisted"}\n`);
  if (puzzle.url) io.out(`  ${puzzle.url}\n`);
  if (puzzle.embedUrl) io.out(`  ${puzzle.embedUrl}\n`);
  return 0;
}

async function cmdExport(io: Io, args: string[], flags: FlagValues): Promise<number> {
  const client = makeClient(io, flags, true);
  const picked = (["puz", "html", "pdf", "svg"] as const).filter((f) => bool(flags, f));
  if (picked.length > 1) {
    throw new UsageError(`--${picked[0]} and --${picked[1]} ask for different files; pick one.`);
  }
  const format: ExportFormat = picked.at(0) ?? "json";
  if (format !== "json" && bool(flags, "json") && !str(flags, "out")) {
    throw new UsageError(`--${format} and --json ask for different files; pick one.`);
  }
  const paper = str(flags, "paper");
  if (paper !== undefined && paper !== "letter" && paper !== "a4") {
    throw new UsageError("--paper must be letter or a4.");
  }
  if (paper !== undefined && format !== "pdf") {
    throw new UsageError("--paper only applies to --pdf.");
  }
  const solution = bool(flags, "solution");
  if (solution && format !== "pdf" && format !== "svg") {
    throw new UsageError("--solution only applies to --pdf and --svg.");
  }
  const out = str(flags, "out");

  if (format === "html" || format === "svg") {
    const { data, filename } =
      format === "html"
        ? await client.exportPuzzle(args[0], { format: "html" })
        : await client.exportPuzzle(args[0], { format: "svg", solution });
    writeOut(io, data, out, bool(flags, "quiet"), `${format.toUpperCase()} (${filename})`);
    return 0;
  }

  if (format === "json") {
    const puzzle = await client.exportPuzzle(args[0], { format: "json" });
    const text = `${JSON.stringify(puzzle, null, 2)}\n`;
    writeOut(io, text, out, bool(flags, "quiet"), "Puzzle");
    return 0;
  }

  const { data, filename } =
    format === "puz"
      ? await client.exportPuzzle(args[0], { format: "puz" })
      : await client.exportPuzzle(args[0], { format: "pdf", paper, solution });
  if (!out && io.isTty) {
    throw new UsageError(
      `.${format} is binary. Pass --out ${filename}, or redirect stdout to a file.`
    );
  }
  if (out) {
    writeFileSync(out, data);
    if (!bool(flags, "quiet")) io.err(`${data.length} bytes → ${out}\n`);
  } else {
    io.outBytes(data);
  }
  return 0;
}

async function cmdGenerateClues(io: Io, args: string[], flags: FlagValues): Promise<number> {
  const client = makeClient(io, flags, true);
  const count = num(flags, "count") ?? 5;

  if (!bool(flags, "yes")) {
    io.err(
      `This spends ${args.length} unit${args.length === 1 ? "" : "s"} of your monthly ` +
        "AI-clue allowance (members only).\n"
    );
    const ok = await io.confirm("Continue?");
    if (!ok) {
      io.err("Cancelled. Pass --yes to skip this prompt.\n");
      return 2;
    }
  }

  const results: Record<string, Clue[]> = {};
  let remaining: number | undefined;
  for (const word of args) {
    const result = await client.generateClues({
      word,
      count,
      language: langOf(flags),
    });
    results[word.toUpperCase()] = result.clues;
    remaining = result.remaining ?? remaining;
    if (!bool(flags, "json")) {
      io.out(`${word.toUpperCase()}\n${renderClues(result.clues)}\n`);
    }
  }
  if (bool(flags, "json")) emitJson(io, { clues: results, remaining });
  else if (remaining !== undefined && !bool(flags, "quiet")) {
    io.err(`${remaining === -1 ? "unlimited" : remaining} AI clues left this month\n`);
  }
  return 0;
}

/**
 * `xword mcp` — hand the process over to the stdio MCP server.
 *
 * Nothing here may touch stdout: from this point on it is the JSON-RPC channel.
 * The module is loaded lazily so the MCP SDK is only paid for by the one
 * command that needs it, and `--base` is passed through as an environment
 * override rather than a parameter, so the server resolves its key and base URL
 * by exactly the same rules as every other command.
 */
async function cmdMcp(io: Io, flags: FlagValues): Promise<number> {
  const base = str(flags, "base");
  const env = base ? { ...io.env, CROSSWORD_API_BASE: base } : io.env;
  const { runMcpCli } = await import("./mcp.js");
  return runMcpCli(env);
}

function cmdHelp(io: Io, args: string[]): number {
  if (args.length === 0) {
    io.out(topLevelHelp());
    return 0;
  }
  const name = args.join(" ");
  const spec =
    COMMANDS.find((c) => c.name === name) ?? COMMANDS.find((c) => c.name.startsWith(`${name} `));
  if (!spec) {
    io.err(`Unknown command: ${name}\n`);
    return 2;
  }
  io.out(commandHelp(spec));
  return 0;
}

// --- Entry point ----------------------------------------------------------

export async function run(argv: string[], io: Io = nodeIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n`);
      if (error.command) {
        const spec = COMMANDS.find((c) => c.name === error.command);
        if (spec) io.err(`\n${commandHelp(spec)}`);
      } else {
        io.err("\nRun `xword help` for the command list.\n");
      }
      return 2;
    }
    throw error;
  }

  const { command, args, flags } = parsed;
  if (flags.version === true || command === "version") {
    io.out(`xword ${VERSION}\n`);
    return 0;
  }

  try {
    switch (command) {
      case "help":
        return cmdHelp(io, args);
      case "login":
        return await cmdLogin(io, flags);
      case "logout":
        return cmdLogout(io);
      case "status":
        return await cmdStatus(io, flags);
      case "languages":
        return await cmdLanguages(io, flags);
      case "words":
        return await cmdWords(io, args, flags);
      case "clues":
        return await cmdClues(io, args, flags);
      case "scores":
        return await cmdScores(io, args, flags);
      case "pattern":
        return cmdPattern(io, flags);
      case "fill":
        return await cmdFill(io, args, flags);
      case "improve":
        return await cmdImprove(io, args, flags);
      case "puzzles list":
        return await cmdPuzzlesList(io, flags);
      case "puzzles get":
        return await cmdPuzzlesGet(io, args, flags);
      case "puzzles create":
        return await cmdPuzzlesCreate(io, args, flags);
      case "puzzles update":
        return await cmdPuzzlesUpdate(io, args, flags);
      case "puzzles delete":
        return await cmdPuzzlesDelete(io, args, flags);
      case "puzzles publish":
        return await cmdPuzzlesPublish(io, args, flags);
      case "export":
        return await cmdExport(io, args, flags);
      case "generate-clues":
        return await cmdGenerateClues(io, args, flags);
      case "mcp":
        return await cmdMcp(io, flags);
      default:
        io.err(`Unknown command: ${command}\n`);
        return 2;
    }
  } catch (error) {
    return reportError(io, error, flags);
  }
}

function reportError(io: Io, error: unknown, flags: FlagValues): number {
  if (error instanceof UsageError) {
    io.err(`${error.message}\n`);
    return 2;
  }
  if (error instanceof CrosswordApiError) {
    if (bool(flags, "json")) {
      emitJson(io, error.problem ?? { status: error.status, code: error.code, detail: error.message });
    } else {
      io.err(`${error.code}: ${error.problem?.detail ?? error.message}\n`);
      const hint = errorHint(error);
      if (hint) io.err(`  ${hint}\n`);
    }
    return 1;
  }
  const message = error instanceof Error ? error.message : String(error);
  io.err(`${message}\n`);
  return 1;
}

/**
 * The way out of a membership-shaped wall, read off the problem document: the
 * server names the plan the key is on and where it upgrades (`tier`,
 * `upgradeUrl`), or whom to email once the top plan isn't enough (`contact`).
 * The server's `detail` already spells out the ladder; this is the one line
 * that says what to *do*.
 */
function upgradeHint(error: CrosswordApiError): string {
  const tier = error.extra<string>("tier");
  const url = error.extra<string>("upgradeUrl");
  const contact = error.extra<string>("contact");
  const plan = tier ? ` (this key is on the ${tier} plan)` : "";
  if (url) return `Upgrade the account${plan}: ${url}`;
  if (contact) return `Need more${plan}? Email ${contact} for a bulk arrangement.`;
  return "A membership lifts this limit: https://account.texs.org/";
}

/** One actionable line per failure the CLI can actually do something about. */
function errorHint(error: CrosswordApiError): string | null {
  switch (error.code) {
    case "UNAUTHORIZED":
      return "Run `xword login`, or check CROSSWORD_API_KEY.";
    case "FORBIDDEN_SCOPE":
      return `This key lacks the \`${error.extra<string>("requiredScope") ?? "required"}\` scope. Mint one with it at https://crossword.texs.org/dashboard?tab=api (Dashboard → API).`;
    case "GRID_SIZE_LOCKED": {
      const max = error.extra<number>("maxGridSize") ?? 13;
      return `This key caps at ${max}×${max}; members get 23×23. ${upgradeHint(error)}`;
    }
    case "MEMBERS_ONLY":
      return `AI clue generation is a member feature. ${upgradeHint(error)}`;
    case "RATE_LIMITED":
      return `Retry in ${error.rateLimit.retryAfter ?? "a few"} seconds.`;
    case "FILL_QUOTA_REACHED":
      return `Monthly fill allowance spent; it resets on the 1st. ${upgradeHint(error)}`;
    case "AI_QUOTA_REACHED":
      return `Monthly AI-clue allowance spent; it resets on the 1st. ${upgradeHint(error)}`;
    case "PUZZLE_QUOTA_REACHED":
      return `Monthly new-puzzle allowance spent; it resets on the 1st. Repeats of the same puzzle are free with --idempotency-key, and edits and publishes are never metered. ${upgradeHint(error)}`;
    case "SHOWCASE_QUEUE_FULL":
      return `${error.extra<number>("queued") ?? "Three"} of your puzzles are already waiting for showcase review. Publish without --showcase for now and resubmit once one is reviewed.`;
    case "SOLVER_BUSY":
      return "Too many solves running. Retry shortly.";
    case "NOT_FOUND":
      return "No such puzzle, or it is a draft you do not own.";
    default:
      return null;
  }
}

// Self-execute only when this file *is* the program. `realpathSync` is what
// makes the npm bin symlink (`…/bin/xword` → `…/dist/cli.js`) match; without it
// a global install would import the module and do nothing.
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
