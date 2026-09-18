import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  COMMANDS,
  GLOBAL_FLAGS,
  UsageError,
  matchCommand,
  parseArgv,
  parseFlags,
} from "../src/cliArgs.js";
import { commandHelp, topLevelHelp } from "../src/cliHelp.js";
import {
  configPath,
  maskApiKey,
  readConfig,
  resolveApiKey,
  writeConfig,
} from "../src/config.js";
import { run, type Io } from "../src/cli.js";

// --- argument parsing -----------------------------------------------------

describe("parseArgv", () => {
  it("parses a simple command with flags", () => {
    expect(parseArgv(["words", "C_T", "--lang", "fr", "--min-score", "40"])).toEqual({
      command: "words",
      args: ["C_T"],
      flags: { lang: "fr", "min-score": 40 },
    });
  });

  it("accepts --flag=value", () => {
    expect(parseArgv(["words", "C_T", "--lang=de", "--limit=5"]).flags).toEqual({
      lang: "de",
      limit: 5,
    });
  });

  it("prefers the two-word command over the one-word one", () => {
    const parsed = parseArgv(["puzzles", "get", "k3n8q1zp"]);
    expect(parsed.command).toBe("puzzles get");
    expect(parsed.args).toEqual(["k3n8q1zp"]);
  });

  it("collects a repeated flag", () => {
    expect(parseArgv(["improve", "g.txt", "--lock", "0,0", "--lock", "0,1"]).flags.lock).toEqual([
      "0,0",
      "0,1",
    ]);
  });

  it("treats a bare boolean as true and --no-x as false", () => {
    expect(parseArgv(["fill", "g.txt", "--stream"]).flags.stream).toBe(true);
    expect(parseArgv(["puzzles", "publish", "abc", "--no-showcase"]).flags.showcase).toBe(false);
  });

  it("stops flag parsing at --", () => {
    expect(parseArgv(["scores", "--", "--weird", "CAT"]).args).toEqual(["--weird", "CAT"]);
  });

  it("reads `-` as a positional, not a flag", () => {
    expect(parseArgv(["fill", "-"]).args).toEqual(["-"]);
  });

  it("rejects an unknown flag instead of taking it as an argument", () => {
    // A typo'd --min-scor that became a positional would produce a confidently
    // wrong answer, which is worse than an error.
    expect(() => parseArgv(["words", "C_T", "--min-scor", "40"])).toThrow(UsageError);
  });

  it("rejects an unknown command", () => {
    expect(() => parseArgv(["frobnicate"])).toThrow(/Unknown command/);
  });

  it("names the subcommands when `puzzles` is used bare", () => {
    expect(() => parseArgv(["puzzles"])).toThrow(/list, get, create, update, delete, publish/);
  });

  it("rejects a numeric flag given a non-number", () => {
    expect(() => parseArgv(["words", "C_T", "--limit", "many"])).toThrow(/expects a number/);
  });

  it("rejects a flag with no value", () => {
    expect(() => parseArgv(["words", "C_T", "--lang"])).toThrow(/expects a value/);
  });

  it("enforces the argument count", () => {
    expect(() => parseArgv(["words"])).toThrow(/needs 1 argument/);
    expect(() => parseArgv(["status", "extra"])).toThrow(/takes no arguments/);
    expect(() => parseArgv(["puzzles", "update", "abc"])).toThrow(/needs 2 arguments/);
  });

  it("routes --help on a command to help for that command", () => {
    expect(parseArgv(["fill", "--help"])).toEqual({ command: "help", args: ["fill"], flags: {} });
  });

  it("handles bare --version and no arguments", () => {
    expect(parseArgv(["--version"]).command).toBe("version");
    expect(parseArgv([]).command).toBe("help");
  });

  it("rejects short-flag clusters with an explanation", () => {
    expect(() => parseArgv(["words", "C_T", "-l", "fr"])).toThrow(/long flags only/);
  });
});

describe("matchCommand", () => {
  it("returns the rest of argv after the command", () => {
    expect(matchCommand(["puzzles", "list", "--limit", "5"])?.rest).toEqual(["--limit", "5"]);
    expect(matchCommand(["status"])?.rest).toEqual([]);
    expect(matchCommand(["nope"])).toBeNull();
  });
});

describe("the command table itself", () => {
  it("has no duplicate names", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("describes every flag it accepts", () => {
    for (const command of COMMANDS) {
      for (const [name, spec] of Object.entries(command.flags ?? {})) {
        expect(spec.describe, `${command.name} --${name}`).toBeTruthy();
        if (spec.type !== "boolean") {
          expect(spec.placeholder, `${command.name} --${name}`).toBeTruthy();
        }
      }
    }
  });

  it("covers every operation the plan's CLI list names", () => {
    const names = COMMANDS.map((c) => c.name);
    for (const expected of [
      "login",
      "logout",
      "status",
      "languages",
      "words",
      "clues",
      "scores",
      "pattern",
      "fill",
      "improve",
      "puzzles list",
      "puzzles get",
      "puzzles create",
      "puzzles update",
      "puzzles delete",
      "puzzles publish",
      "export",
      "generate-clues",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("parses each command's own example flags", () => {
    for (const command of COMMANDS) {
      const argv = Object.entries(command.flags ?? {}).flatMap(([name, spec]) =>
        spec.type === "boolean" ? [`--${name}`] : [`--${name}`, spec.type === "number" ? "1" : "x"]
      );
      const args = Array.from({ length: command.minArgs ?? 0 }, (_, i) => `arg${i}`);
      expect(() => parseFlags(command, [...args, ...argv])).not.toThrow();
    }
  });
});

// --- help -----------------------------------------------------------------

describe("help output", () => {
  it("top-level help is stable", () => {
    expect(topLevelHelp()).toMatchSnapshot();
  });

  it("fill help is stable", () => {
    expect(commandHelp(COMMANDS.find((c) => c.name === "fill")!)).toMatchSnapshot();
  });

  it("every visible command appears in the top-level list", () => {
    const help = topLevelHelp();
    for (const command of COMMANDS.filter((c) => !c.hidden)) {
      expect(help).toContain(command.name);
    }
  });

  it("global flags are documented once at the top level", () => {
    const help = topLevelHelp();
    for (const name of Object.keys(GLOBAL_FLAGS)) {
      expect(help).toContain(`--${name}`);
    }
  });
});

// --- run() with a fake IO --------------------------------------------------

interface Captured {
  io: Io;
  out: () => string;
  err: () => string;
  bytes: () => Uint8Array[];
}

function fakeIo(options: {
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  secret?: string;
  confirm?: boolean;
  isTty?: boolean;
}): Captured {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const byteChunks: Uint8Array[] = [];
  return {
    out: () => outChunks.join(""),
    err: () => errChunks.join(""),
    bytes: () => byteChunks,
    io: {
      out: (text) => outChunks.push(text),
      err: (text) => errChunks.push(text),
      outBytes: (bytes) => byteChunks.push(bytes),
      env: options.env ?? {},
      isTty: options.isTty ?? false,
      readStdin: async () => options.stdin ?? "",
      promptSecret: async () => options.secret ?? "",
      confirm: async () => options.confirm ?? false,
    },
  };
}

describe("run()", () => {
  it("prints help and exits 0", async () => {
    const io = fakeIo({});
    expect(await run(["help"], io.io)).toBe(0);
    expect(io.out()).toContain("xword <command>");
  });

  it("prints the version", async () => {
    const io = fakeIo({});
    expect(await run(["--version"], io.io)).toBe(0);
    expect(io.out()).toMatch(/^xword \d+\.\d+\.\d+\n$/);
  });

  it("exits 2 on a usage error and shows that command's help", async () => {
    const io = fakeIo({});
    expect(await run(["words"], io.io)).toBe(2);
    expect(io.err()).toContain("needs 1 argument");
    expect(io.err()).toContain("xword words <pattern>");
  });

  it("exits 2 when a gated command has no key", async () => {
    const io = fakeIo({ env: {} });
    expect(await run(["words", "C_T"], io.io)).toBe(2);
    expect(io.err()).toContain("xword login");
  });

  it("rejects an unknown language before any request", async () => {
    const io = fakeIo({ env: { CROSSWORD_API_KEY: "cw_live_x" } });
    expect(await run(["words", "C_T", "--lang", "klingon"], io.io)).toBe(2);
    expect(io.err()).toContain("Unknown language code");
  });

  it("generates a pattern locally, with no key and no network", async () => {
    const io = fakeIo({ env: {} });
    expect(await run(["pattern", "--size", "15"], io.io)).toBe(0);
    const rows = io.out().trimEnd().split("\n");
    expect(rows).toHaveLength(15);
    expect(rows.every((row) => row.length === 15)).toBe(true);
    expect(rows.join("")).toMatch(/#/);
  });

  it("refuses a pattern size the generator cannot satisfy", async () => {
    const io = fakeIo({ env: {} });
    expect(await run(["pattern", "--size", "9"], io.io)).toBe(1);
    expect(io.err()).toContain("could not place any black squares");
  });

  it("validates --size before generating", async () => {
    const io = fakeIo({ env: {} });
    expect(await run(["pattern", "--size", "40"], io.io)).toBe(2);
    expect(io.err()).toContain("--size must be");
  });

  it("emits --json for pattern", async () => {
    const io = fakeIo({ env: {} });
    expect(await run(["pattern", "--size", "15", "--json"], io.io)).toBe(0);
    const parsed = JSON.parse(io.out()) as { grid: string[]; style: string };
    expect(parsed.style).toBe("american");
    expect(parsed.grid).toHaveLength(15);
  });

  it("never prints the key", async () => {
    const key = "cw_live_SECRETSECRETSECRETSECRET00";
    const io = fakeIo({ env: { CROSSWORD_API_KEY: key } });
    await run(["words", "C_T", "--base", "http://127.0.0.1:1/api/v1"], io.io);
    expect(io.out()).not.toContain(key);
    expect(io.err()).not.toContain(key);
  });

  it("reports a network failure as exit 1, not a crash", async () => {
    const io = fakeIo({ env: { CROSSWORD_API_KEY: "cw_live_x" } });
    // Port 1 refuses instantly on every platform we support.
    expect(await run(["words", "C_T", "--base", "http://127.0.0.1:1/api/v1"], io.io)).toBe(1);
  });
});

// --- key storage ----------------------------------------------------------

describe("key storage", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "xword-test-"));
    env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), APPDATA: join(home, "AppData") };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("writes the config mode 0600 and reads it back", async () => {
    const io = fakeIo({ env, secret: "cw_live_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" });
    // No server to verify against; login stores first, then fails to verify.
    await run(["login", "--base", "http://127.0.0.1:1/api/v1"], io.io);

    const path = configPath(env);
    expect(readConfig(env).apiKey).toBe("cw_live_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(io.out()).not.toContain("ABCDEFGH");
  });

  it("logout removes it", async () => {
    const io = fakeIo({ env, secret: "cw_live_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" });
    await run(["login", "--base", "http://127.0.0.1:1/api/v1"], io.io);
    expect(await run(["logout"], io.io)).toBe(0);
    expect(readConfig(env).apiKey).toBeUndefined();
  });

  it("the environment wins over the stored key", () => {
    writeConfig({ apiKey: "cw_live_stored" }, env);
    expect(resolveApiKey(env)).toEqual({ key: "cw_live_stored", source: "config" });
    expect(resolveApiKey({ ...env, CROSSWORD_API_KEY: "cw_live_env" })).toEqual({
      key: "cw_live_env",
      source: "env",
    });
  });

  it("reports no key when nothing is stored or set", () => {
    expect(resolveApiKey(env)).toEqual({ source: "none" });
  });

  it("treats a corrupt config as logged out rather than failing every command", () => {
    writeConfig({ apiKey: "cw_live_stored" }, env);
    writeFileSync(configPath(env), "{ this is not json");
    expect(readConfig(env)).toEqual({});
    expect(resolveApiKey(env)).toEqual({ source: "none" });
  });

  it("masks a key for display", () => {
    expect(maskApiKey("cw_live_ABCDEFGHIJKLMNOP")).toBe("cw_live_ABCD••••••••");
    expect(maskApiKey("cw_live_ABCDEFGHIJKLMNOP")).not.toContain("EFGH");
  });
});

// --- grid file plumbing ---------------------------------------------------

describe("fill input handling", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "xword-grid-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("rejects a ragged grid file before spending quota", async () => {
    const path = join(dir, "grid.txt");
    writeFileSync(path, "...\n....\n...\n");
    const io = fakeIo({ env: { CROSSWORD_API_KEY: "cw_live_x" } });
    expect(await run(["fill", path, "--base", "http://127.0.0.1:1/api/v1"], io.io)).toBe(1);
    expect(io.err()).toContain("row 1");
  });

  it("rejects --lock on an empty cell, with the reason", async () => {
    const path = join(dir, "grid.txt");
    writeFileSync(path, "..#..\n.....\n..A..\n.....\n..#..\n");
    const io = fakeIo({ env: { CROSSWORD_API_KEY: "cw_live_x" } });
    expect(
      await run(
        ["fill", path, "--lock", "0,0", "--base", "http://127.0.0.1:1/api/v1"],
        io.io
      )
    ).toBe(2);
    expect(io.err()).toContain("xword improve --lock");
  });

  it("rejects --lock on a black square", async () => {
    const path = join(dir, "grid.txt");
    writeFileSync(path, "..#..\n.....\n..A..\n.....\n..#..\n");
    const io = fakeIo({ env: { CROSSWORD_API_KEY: "cw_live_x" } });
    expect(
      await run(
        ["improve", path, "--lock", "0,2", "--base", "http://127.0.0.1:1/api/v1"],
        io.io
      )
    ).toBe(2);
    expect(io.err()).toContain("black square");
  });

  it("reads a grid from stdin when the path is -", async () => {
    const io = fakeIo({
      env: { CROSSWORD_API_KEY: "cw_live_x" },
      stdin: "..#..\n.....\n..A..\n.....\n..#..\n",
    });
    // The request fails (no server), but reaching the network means the stdin
    // grid parsed — a parse failure would have exited before the fetch.
    expect(await run(["fill", "-", "--base", "http://127.0.0.1:1/api/v1"], io.io)).toBe(1);
    expect(io.err()).not.toContain("Grid must be");
  });

  it("writes the pattern to --out", async () => {
    const path = join(dir, "pattern.txt");
    const io = fakeIo({ env: {} });
    expect(await run(["pattern", "--size", "15", "--out", path], io.io)).toBe(0);
    expect(readFileSync(path, "utf8").trimEnd().split("\n")).toHaveLength(15);
  });
});
