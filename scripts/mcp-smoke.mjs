#!/usr/bin/env node
/**
 * Drive the built `xword mcp` server over a real stdio pipe.
 *
 * The vitest suite talks to the server through the SDK's in-memory transport,
 * which is the right tool for asserting behaviour but proves nothing about the
 * bit most likely to break in the field: whether `dist/cli.js mcp` actually
 * speaks the protocol on a pipe without a stray byte on stdout. This spawns the
 * built binary the way an MCP client would.
 *
 *   npm run build
 *   node scripts/mcp-smoke.mjs                       # against production
 *   CROSSWORD_API_BASE=http://localhost:5555/api/v1 \
 *     CROSSWORD_API_KEY=cw_live_bogus… node scripts/mcp-smoke.mjs
 *
 * HOME is deliberately pointed at nothing, so a stored `xword login` key on the
 * developer's machine cannot quietly make this pass.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const base = process.env.CROSSWORD_API_BASE ?? "https://crossword.texs.org/api/v1";
const key = process.env.CROSSWORD_API_KEY ?? "cw_live_BOGUSKEY000000000000000000000000";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli, "mcp"],
  env: {
    PATH: process.env.PATH ?? "",
    HOME: "/nonexistent-home-so-no-stored-key",
    CROSSWORD_API_BASE: base,
    CROSSWORD_API_KEY: key,
  },
  stderr: "pipe",
});

const client = new Client({ name: "mcp-smoke", version: "0.0.0" });
await client.connect(transport);
transport.stderr?.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

const text = (result) =>
  (result.content ?? [])
    .map((part) => part.text ?? "")
    .join("\n")
    .slice(0, 400);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const { tools } = await client.listTools();
check("tools/list", tools.length === 17, `${tools.length} tools`);

const { prompts } = await client.listPrompts();
check("prompts/list", prompts.some((p) => p.name === "compose_puzzle"));

const status = await client.callTool({ name: "get_status", arguments: {} });
check("get_status (keyless)", !status.isError, text(status).split("\n")[0]);

const languages = await client.callTool({
  name: "list_languages",
  arguments: { available_only: true },
});
check("list_languages (keyless)", !languages.isError, text(languages).split("\n")[0]);

const pattern = await client.callTool({ name: "generate_pattern", arguments: { size: 11 } });
check("generate_pattern (local)", !pattern.isError, text(pattern).split("\n")[0]);

const words = await client.callTool({
  name: "search_words",
  arguments: { pattern: "C_T", min_score: 40, limit: 5 },
});
const unauthorized = words.isError && text(words).includes("UNAUTHORIZED");
check("search_words with a bogus key → UNAUTHORIZED", unauthorized, text(words).split("\n")[0]);

await client.close();
process.exitCode = failures === 0 ? 0 : 1;
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
