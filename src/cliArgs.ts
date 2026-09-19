/**
 * The CLI's argument parser and command table.
 *
 * Hand-rolled rather than commander so the package ships with no runtime
 * dependencies — `npx xword` should download one tarball, not a tree.
 * It is a separate module from `cli.ts` so the parse and the help text can be
 * tested without running a command.
 *
 * Grammar: `xword <command> [subcommand] [positionals…] [--flags]`.
 * `--flag value`, `--flag=value`, `--bool`, `--no-bool` and repeated flags
 * (which collect) are supported; `--` stops flag parsing. An unknown flag is a
 * usage error rather than a positional, because a typo'd `--min-scor 40` that
 * silently became an argument would produce a confidently wrong answer.
 */

export type FlagType = "string" | "number" | "boolean" | "string[]";

export interface FlagSpec {
  type: FlagType;
  describe: string;
  /** Shown in help as `--name <placeholder>`. */
  placeholder?: string;
}

export interface CommandSpec {
  /** Space-separated, e.g. `"puzzles list"`. */
  name: string;
  /** Argument shape shown after the command name in help. */
  args?: string;
  summary: string;
  /** Longer explanation printed by `xword help <command>`. */
  details?: string;
  flags?: Record<string, FlagSpec>;
  minArgs?: number;
  maxArgs?: number;
  /** Suppressed from the top-level command list. */
  hidden?: boolean;
}

export type FlagValues = Record<string, string | number | boolean | string[]>;

export interface ParsedArgs {
  command: string;
  args: string[];
  flags: FlagValues;
}

export class UsageError extends Error {
  readonly name = "UsageError";
  constructor(message: string, readonly command?: string) {
    super(message);
  }
}

/** Flags every command accepts. */
export const GLOBAL_FLAGS: Record<string, FlagSpec> = {
  json: { type: "boolean", describe: "Emit machine-readable JSON instead of prose." },
  base: {
    type: "string",
    placeholder: "url",
    describe: "API base URL. Overrides CROSSWORD_API_BASE and the stored value.",
  },
  quiet: { type: "boolean", describe: "Suppress progress and hints; keep results." },
  help: { type: "boolean", describe: "Show help for this command." },
  version: { type: "boolean", describe: "Print the xword version." },
};

const LANG_FLAG: FlagSpec = {
  type: "string",
  placeholder: "code",
  describe: "Puzzle language code (default en).",
};

export const COMMANDS: CommandSpec[] = [
  {
    name: "login",
    summary: "Store an API key in the OS config directory.",
    details:
      "Prompts for the key without echoing it and writes it mode 0600.\n" +
      "CROSSWORD_API_KEY always takes precedence over the stored key.",
    flags: {
      base: GLOBAL_FLAGS.base,
    },
    maxArgs: 0,
  },
  {
    name: "logout",
    summary: "Delete the stored API key.",
    maxArgs: 0,
  },
  {
    name: "status",
    summary: "Service health and which language indexes are resident.",
    details: "Needs no key. Also reports where this CLI is getting its key from.",
    maxArgs: 0,
  },
  {
    name: "languages",
    summary: "List puzzle languages and their constraints.",
    details: "Needs no key.",
    flags: {
      available: {
        type: "boolean",
        describe: "Only languages with a deployed word database.",
      },
    },
    maxArgs: 0,
  },
  {
    name: "words",
    args: "<pattern>",
    summary: "Search a word index by pattern (`_` or `?` is a wildcard).",
    details: "Example: xword words C_T --lang en --min-score 40",
    flags: {
      lang: LANG_FLAG,
      "min-score": {
        type: "number",
        placeholder: "n",
        describe: "Drop entries below this score. 40 is the no-junk floor.",
      },
      limit: { type: "number", placeholder: "n", describe: "Max matches (1-100)." },
    },
    minArgs: 1,
    maxArgs: 1,
  },
  {
    name: "clues",
    args: "<WORD>",
    summary: "Corpus clues for one answer, best first.",
    flags: {
      lang: LANG_FLAG,
      limit: { type: "number", placeholder: "n", describe: "Max clues (1-50)." },
    },
    minArgs: 1,
    maxArgs: 1,
  },
  {
    name: "scores",
    args: "<WORD...>",
    summary: "Dictionary score for each word the index knows.",
    details:
      "Words the index has no entry for are reported as unscored rather than 0 —\n" +
      "that is how you tell a theme answer apart from a bad one.",
    flags: { lang: LANG_FLAG },
    minArgs: 1,
  },
  {
    name: "pattern",
    summary: "Generate a symmetric black-square pattern. Runs locally.",
    details:
      "No key, no quota, no network: the same generator the web constructor uses.\n" +
      "Writes one row per line — `.` empty, `#` black — which is what `fill` reads.",
    flags: {
      size: { type: "number", placeholder: "n", describe: "Grid side, 3-23 (default 15)." },
      style: {
        type: "string",
        placeholder: "name",
        describe: "american (default), british, or freeform.",
      },
      out: { type: "string", placeholder: "file", describe: "Write here instead of stdout." },
    },
    maxArgs: 0,
  },
  {
    name: "fill",
    args: "<grid.txt|->",
    summary: "Auto-fill a grid. Spends one unit of the monthly fill quota.",
    details:
      "The grid file is one row per line: `.` empty, `#` black, anything else a\n" +
      "fixed letter the solver must keep. `-` reads the grid from stdin.\n" +
      "\n" +
      "--stream renders progress as the solver works, using the SSE response.\n" +
      "--lock is a pre-flight check, not a request field: POST /fill has no\n" +
      "`locked` list because every letter already in the grid is held anyway, so\n" +
      "--lock verifies that the cells you meant to protect really do carry one.",
    flags: {
      lang: LANG_FLAG,
      "min-score": {
        type: "number",
        placeholder: "n",
        describe: "Quality floor for solver-chosen entries (default 40).",
      },
      "max-time": {
        type: "number",
        placeholder: "sec",
        describe: "Wall-clock seconds the solver may spend (default 25).",
      },
      "try-hard": {
        type: "boolean",
        describe: "Skip the hopeless-grid checks and use the whole time budget.",
      },
      lock: {
        type: "string[]",
        placeholder: "r,c",
        describe: "Assert this cell already carries a letter. Repeatable.",
      },
      stream: { type: "boolean", describe: "Stream progress (SSE) instead of blocking." },
      out: { type: "string", placeholder: "file", describe: "Write the filled grid here." },
    },
    minArgs: 1,
    maxArgs: 1,
  },
  {
    name: "improve",
    args: "<grid.txt|->",
    summary: "Clean up a filled grid. Spends one unit of the monthly fill quota.",
    details:
      "Swaps obscure entries for common ones. Cells given with --lock are never\n" +
      "touched — that is where theme entries go.",
    flags: {
      lang: LANG_FLAG,
      "max-time": {
        type: "number",
        placeholder: "sec",
        describe: "Wall-clock seconds for the clean-up pass (default 25).",
      },
      lock: {
        type: "string[]",
        placeholder: "r,c",
        describe: "Cell the solver must not touch. Repeatable.",
      },
      out: { type: "string", placeholder: "file", describe: "Write the cleaned grid here." },
    },
    minArgs: 1,
    maxArgs: 1,
  },
  {
    name: "puzzles list",
    summary: "List your puzzles, newest edit first.",
    flags: {
      status: { type: "string", placeholder: "state", describe: "draft or published." },
      limit: { type: "number", placeholder: "n", describe: "Max rows (1-100)." },
      offset: { type: "number", placeholder: "n", describe: "Skip this many." },
    },
    maxArgs: 0,
  },
  {
    name: "puzzles get",
    args: "<id>",
    summary: "Fetch one puzzle.",
    minArgs: 1,
    maxArgs: 1,
  },
  {
    name: "puzzles create",
    args: "<puzzle.json|->",
    summary: "Create a puzzle from a JSON document.",
    details:
      "The document is a PuzzleInput: title, grid, and optionally author,\n" +
      "language, clues.across / clues.down, themeWords, writeup, publish.",
    flags: {
      publish: { type: "boolean", describe: "Create it already published." },
      "idempotency-key": {
        type: "string",
        placeholder: "key",
        describe:
          "Repeat-safe: the same key returns the puzzle it first created instead of a twin.",
      },
    },
    minArgs: 1,
    maxArgs: 1,
  },
  {
    name: "puzzles update",
    args: "<id> <patch.json|->",
    summary: "PATCH a puzzle. Omitted fields are left alone.",
    minArgs: 2,
    maxArgs: 2,
  },
  {
    name: "puzzles delete",
    args: "<id>",
    summary: "Permanently delete a puzzle you own.",
    flags: {
      yes: { type: "boolean", describe: "Skip the confirmation prompt." },
    },
    minArgs: 1,
    maxArgs: 1,
  },
  {
    name: "puzzles publish",
    args: "<id>",
    summary: "Publish a draft, minting its public and embed URLs.",
    details:
      "Publishing is unlisted unless you pass --showcase, which enters the public\n" +
      "review queue.",
    flags: {
      showcase: { type: "boolean", describe: "Submit to the public showcase queue." },
      writeup: {
        type: "string",
        placeholder: "text",
        describe: "Constructor's note shown on the puzzle page.",
      },
      "show-profile": { type: "boolean", describe: "Link it from your author page." },
      "no-index": { type: "boolean", describe: "Ask search engines to stay away." },
    },
    minArgs: 1,
    maxArgs: 1,
  },
  {
    name: "export",
    args: "<id>",
    summary: "Download a puzzle as JSON, .puz, a playable HTML page, a printable PDF, or an SVG grid.",
    flags: {
      puz: { type: "boolean", describe: "Across Lite binary (Latin scripts only)." },
      html: {
        type: "boolean",
        describe: "One playable HTML file to host on your own site (needs a full, clued grid).",
      },
      pdf: {
        type: "boolean",
        describe: "One printable page: title, grid, clues in four columns (no CJK/Devanagari/Thai yet).",
      },
      svg: { type: "boolean", describe: "The numbered grid alone as a vector image, no clues." },
      paper: {
        type: "string",
        placeholder: "size",
        describe: "--pdf page size: letter (default) or a4.",
      },
      solution: { type: "boolean", describe: "--pdf / --svg: draw the answers (an answer key)." },
      json: { type: "boolean", describe: "The Puzzle document (default)." },
      out: {
        type: "string",
        placeholder: "file",
        describe: "Write here. Required for --puz and --pdf unless you redirect stdout.",
      },
    },
    minArgs: 1,
    maxArgs: 1,
  },
  {
    name: "generate-clues",
    args: "<WORD...>",
    summary: "Write fresh AI clues. Members only; spends the AI clue allowance.",
    details:
      "Every word costs one unit of the monthly AI-clue allowance, so this asks\n" +
      "for confirmation unless --yes is given.",
    flags: {
      lang: LANG_FLAG,
      count: { type: "number", placeholder: "n", describe: "Clues per word (1-10)." },
      yes: { type: "boolean", describe: "Skip the spend confirmation." },
    },
    minArgs: 1,
  },
  {
    name: "mcp",
    summary: "Run the MCP server on stdio, for Claude Code, Cursor and friends.",
    details:
      "Speaks MCP over stdin/stdout, so it is meant to be spawned by an MCP\n" +
      "client rather than run by hand — stdout is the protocol channel and\n" +
      "every diagnostic goes to stderr. Add it with:\n" +
      "\n" +
      "  claude mcp add crossword -e CROSSWORD_API_KEY=cw_live_… -- npx -y xword mcp\n" +
      "\n" +
      "The key comes from CROSSWORD_API_KEY or the `xword login` config file.\n" +
      "Without one, only get_status and list_languages work.",
    maxArgs: 0,
  },
  {
    name: "help",
    args: "[command]",
    summary: "Show help for a command.",
    hidden: true,
  },
];

const COMMAND_NAMES = COMMANDS.map((c) => c.name);

/** Longest command name that is a prefix of `argv`, so `puzzles list` wins. */
export function matchCommand(argv: string[]): { spec: CommandSpec; rest: string[] } | null {
  const two = argv.slice(0, 2).join(" ");
  const one = argv[0] ?? "";
  for (const candidate of [two, one]) {
    const spec = COMMANDS.find((c) => c.name === candidate);
    if (spec) return { spec, rest: argv.slice(spec.name.split(" ").length) };
  }
  return null;
}

function flagSpecFor(command: CommandSpec, name: string): FlagSpec | undefined {
  return command.flags?.[name] ?? GLOBAL_FLAGS[name];
}

function coerce(name: string, spec: FlagSpec, raw: string): string | number | boolean {
  if (spec.type === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new UsageError(`--${name} expects a number, got ${JSON.stringify(raw)}`);
    }
    return value;
  }
  return raw;
}

/**
 * Parse an argv tail against one command's flag table.
 *
 * Returns positionals in order and flags by name. Boolean flags take no value
 * unless written `--flag=true`; `--no-flag` sets false.
 */
export function parseFlags(
  command: CommandSpec,
  argv: string[]
): { args: string[]; flags: FlagValues } {
  const args: string[] = [];
  const flags: FlagValues = {};
  let passthrough = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (passthrough || !token.startsWith("-") || token === "-") {
      args.push(token);
      continue;
    }
    if (token === "--") {
      passthrough = true;
      continue;
    }
    if (!token.startsWith("--")) {
      // Single-dash clusters are not part of the grammar; naming them here beats
      // treating `-l en` as a positional and searching for a word called "-l".
      throw new UsageError(
        `Unknown option ${token}. This CLI uses long flags only (--lang, --limit).`,
        command.name
      );
    }

    let name = token.slice(2);
    let inlineValue: string | undefined;
    const eq = name.indexOf("=");
    if (eq !== -1) {
      inlineValue = name.slice(eq + 1);
      name = name.slice(0, eq);
    }

    let negated = false;
    let spec = flagSpecFor(command, name);
    if (!spec && name.startsWith("no-")) {
      const positive = name.slice(3);
      const positiveSpec = flagSpecFor(command, positive);
      if (positiveSpec?.type === "boolean") {
        spec = positiveSpec;
        name = positive;
        negated = true;
      }
    }
    if (!spec) {
      throw new UsageError(`Unknown option --${name}`, command.name);
    }

    if (spec.type === "boolean") {
      if (inlineValue !== undefined) {
        flags[name] = inlineValue !== "false" && inlineValue !== "0";
      } else {
        flags[name] = !negated;
      }
      continue;
    }

    const value = inlineValue ?? argv[++i];
    if (value === undefined) {
      throw new UsageError(`--${name} expects a value`, command.name);
    }
    if (spec.type === "string[]") {
      const existing = Array.isArray(flags[name]) ? (flags[name] as string[]) : [];
      flags[name] = [...existing, value];
    } else {
      flags[name] = coerce(name, spec, value);
    }
  }

  return { args, flags };
}

/**
 * Parse a whole argv (without `node` and the script path).
 *
 * `--help` and `--version` are recognized before command matching so
 * `xword --version` and `xword fill --help` both work.
 */
export function parseArgv(argv: string[]): ParsedArgs {
  if (argv.length === 0) return { command: "help", args: [], flags: {} };
  if (argv[0] === "--version" || argv[0] === "-v") {
    return { command: "version", args: [], flags: {} };
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    return { command: "help", args: [], flags: {} };
  }

  const matched = matchCommand(argv);
  if (!matched) {
    // `puzzles` alone is a common near-miss; point at its subcommands rather
    // than at the full command list.
    if (argv[0] === "puzzles") {
      throw new UsageError(
        "puzzles needs a subcommand: list, get, create, update, delete, publish",
        "puzzles list"
      );
    }
    throw new UsageError(`Unknown command: ${argv[0]}`);
  }

  const { spec, rest } = matched;
  const { args, flags } = parseFlags(spec, rest);

  if (flags.help === true) return { command: "help", args: [spec.name], flags: {} };

  if (spec.minArgs !== undefined && args.length < spec.minArgs) {
    throw new UsageError(
      `${spec.name} needs ${spec.minArgs} argument${spec.minArgs === 1 ? "" : "s"}: ` +
        `xword ${spec.name}${spec.args ? ` ${spec.args}` : ""}`,
      spec.name
    );
  }
  if (spec.maxArgs !== undefined && args.length > spec.maxArgs) {
    throw new UsageError(
      `${spec.name} takes ${spec.maxArgs === 0 ? "no arguments" : `at most ${spec.maxArgs}`}, ` +
        `got ${args.length}`,
      spec.name
    );
  }

  return { command: spec.name, args, flags };
}

export { COMMAND_NAMES };
