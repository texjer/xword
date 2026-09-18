/**
 * Help text. Kept apart from the command implementations so `--help` can be
 * snapshot-tested without a network client or a config directory in scope.
 */
import { COMMANDS, GLOBAL_FLAGS, type CommandSpec, type FlagSpec } from "./cliArgs.js";

export const VERSION = "0.1.2";

function flagLine(name: string, spec: FlagSpec): string {
  const rendered =
    spec.type === "boolean" ? `--${name}` : `--${name} <${spec.placeholder ?? "value"}>`;
  return `  ${rendered.padEnd(24)}${spec.describe}`;
}

export function commandHelp(spec: CommandSpec): string {
  const lines: string[] = [];
  lines.push(`xword ${spec.name}${spec.args ? ` ${spec.args}` : ""}`);
  lines.push("");
  lines.push(`  ${spec.summary}`);
  if (spec.details) {
    lines.push("");
    for (const line of spec.details.split("\n")) lines.push(`  ${line}`.trimEnd());
  }
  const flags = spec.flags ?? {};
  const names = Object.keys(flags);
  if (names.length > 0) {
    lines.push("");
    lines.push("Options");
    for (const name of names) lines.push(flagLine(name, flags[name]));
  }
  lines.push("");
  lines.push("Global options");
  for (const name of ["json", "base", "quiet", "help"]) {
    lines.push(flagLine(name, GLOBAL_FLAGS[name]));
  }
  return `${lines.join("\n")}\n`;
}

export function topLevelHelp(): string {
  const visible = COMMANDS.filter((c) => !c.hidden);
  const width = Math.max(...visible.map((c) => c.name.length)) + 2;

  const group = (title: string, names: string[]): string[] => [
    "",
    title,
    ...names.map((name) => {
      const spec = visible.find((c) => c.name === name);
      return spec ? `  ${spec.name.padEnd(width)}${spec.summary}` : "";
    }),
  ];

  return [
    `xword ${VERSION} — the Crossword Generator CLI`,
    "",
    "Usage",
    "  xword <command> [args] [--flags]",
    ...group("Account", ["login", "logout", "status"]),
    ...group("Lookup", ["languages", "words", "clues", "scores"]),
    ...group("Building", ["pattern", "fill", "improve", "generate-clues"]),
    ...group("Puzzles", [
      "puzzles list",
      "puzzles get",
      "puzzles create",
      "puzzles update",
      "puzzles delete",
      "puzzles publish",
      "export",
    ]),
    ...group("Integrations", ["mcp"]),
    "",
    "Global options",
    ...["json", "base", "quiet", "version", "help"].map((name) =>
      flagLine(name, GLOBAL_FLAGS[name])
    ),
    "",
    "Authentication",
    "  xword login                 store a key (mode 0600, OS config dir)",
    "  CROSSWORD_API_KEY=cw_live_… overrides the stored key",
    "  CROSSWORD_API_BASE=…        point at another deployment",
    "",
    "  status and languages need no key. Everything else does.",
    "",
    "Docs: https://crossword.texs.org/developers",
    "",
  ].join("\n");
}
