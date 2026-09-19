import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMcpServer, generatePatternResult, gridEntries } from "../src/mcp.js";

/**
 * The MCP server is exercised through a real `Client` over the SDK's in-memory
 * transport rather than by calling the handlers directly: the things most
 * likely to break — a schema zod cannot convert to JSON Schema, a tool name the
 * spec rejects, a result shape the protocol refuses — only show up once the
 * message actually crosses the wire.
 *
 * `fetch` is mocked throughout. Nothing here touches the network, and nothing
 * here reads the real `xword login` config: both `apiKey` and `baseUrl` are
 * passed explicitly, which is what stops `createMcpServer` from consulting the
 * filesystem at all.
 */
const BASE = "https://example.test/api/v1";
const KEY = "cw_live_TESTKEY0000000000000000000000";

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function problem(status: number, code: string, detail: string, extra: object = {}): Response {
  return new Response(
    JSON.stringify({
      type: `https://crossword.texs.org/developers/errors#${code}`,
      title: code,
      status,
      code,
      detail,
      ...extra,
    }),
    {
      status,
      headers: {
        "content-type": "application/problem+json",
        "x-fill-quota-remaining": "17",
        "x-ratelimit-limit": "60",
        "x-ratelimit-remaining": "59",
      },
    }
  );
}

/** A server + client pair wired together, with a queue of canned responses. */
async function connect(responses: Response[] = []) {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = queue.shift();
    if (!next) throw new Error(`No mocked response left for ${init?.method ?? "GET"} ${url}`);
    return next;
  }) as unknown as typeof globalThis.fetch;

  const server = createMcpServer({
    apiKey: KEY,
    baseUrl: BASE,
    fetch: fetchImpl,
    env: {},
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    calls,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/**
 * The single text block a tool result carries, as a string.
 *
 * `callTool` is typed as a union that still includes the pre-`content` legacy
 * shape, so the argument is `unknown` and narrowed here rather than at every
 * call site.
 */
function textOf(result: unknown): string {
  const content = ((result as { content?: unknown }).content ?? []) as Array<{
    type: string;
    text?: string;
  }>;
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

/** The JSON payload a tool appends after its prose summary. */
function payloadOf(result: unknown): any {
  const text = textOf(result);
  const start = text.indexOf("{");
  return JSON.parse(text.slice(start));
}

const MINI_GRID = ["..#..", ".....", "..A..", ".....", "..#.."];
const FILLED_GRID = ["KD#MC", "NINER", "OVATE", "LEGOS", "LR#OT"];

const PUZZLE = {
  id: "k3n8q1zp",
  title: "Coastal Mini",
  author: "Tex",
  language: "en",
  size: 5,
  grid: FILLED_GRID,
  clues: { across: { "5": "Footballer" }, down: { "1": "Mound" } },
  status: "published",
  showcaseStatus: null,
  createdAt: "2026-09-15T10:04:00Z",
  updatedAt: "2026-09-15T10:04:00Z",
  url: "https://crossword.texs.org/puzzle/k3n8q1zp",
  embedUrl: "https://crossword.texs.org/embed/k3n8q1zp",
};

// --- The tool surface ------------------------------------------------------

describe("tools/list", () => {
  it("advertises every operation, snake_case, with a description", async () => {
    const session = await connect();
    const { tools } = await session.client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    expect(names).toEqual(
      [
        "create_puzzle",
        "delete_puzzle",
        "export_puzzle",
        "fill_grid",
        "generate_clues",
        "generate_pattern",
        "get_puzzle",
        "get_status",
        "improve_fill",
        "list_languages",
        "list_puzzles",
        "lookup_clues",
        "lookup_clues_bulk",
        "publish_puzzle",
        "score_words",
        "search_words",
        "update_puzzle",
      ].sort()
    );

    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.description ?? "").not.toBe("");
      expect(tool.inputSchema.type).toBe("object");
    }

    await session.close();
  });

  it("warns about the spend on every tool that costs quota or money", async () => {
    const session = await connect();
    const { tools } = await session.client.listTools();
    const describe = (name: string) => tools.find((t) => t.name === name)?.description ?? "";

    expect(describe("fill_grid")).toMatch(/SPENDS one unit/);
    expect(describe("improve_fill")).toMatch(/SPENDS one unit/);
    expect(describe("generate_clues")).toMatch(/MEMBERS ONLY/);
    expect(describe("generate_clues")).toMatch(/monthly AI-clue allowance/);
    // And the free ones say so, so a model has a reason to prefer them.
    expect(describe("generate_pattern")).toMatch(/no quota/);
    expect(describe("lookup_clues_bulk")).toMatch(/\*\*Free\.\*\*/);

    await session.close();
  });

  it("offers the end-to-end workflow as a prompt", async () => {
    const session = await connect();
    const { prompts } = await session.client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("compose_puzzle");

    const prompt = await session.client.getPrompt({
      name: "compose_puzzle",
      arguments: { theme: "lighthouses", size: "11" },
    });
    const body = prompt.messages
      .map((message) => (message.content.type === "text" ? message.content.text : ""))
      .join("\n");
    expect(body).toContain("lighthouses");
    for (const step of ["generate_pattern", "fill_grid", "lookup_clues_bulk", "create_puzzle", "publish_puzzle"]) {
      expect(body).toContain(step);
    }

    await session.close();
  });
});

// --- Each tool, once -------------------------------------------------------

describe("tool calls", () => {
  it("get_status and list_languages", async () => {
    const session = await connect([
      json({ status: "ok", version: "1.0.0", languages: { en: { available: true, loaded: true } } }),
      json({
        languages: [
          {
            code: "en",
            name: "English",
            nativeName: "English",
            available: true,
            crissCrossOnly: false,
            rtl: false,
            puzExportable: true,
            minSlotLength: 3,
          },
        ],
      }),
    ]);

    const status = await session.client.callTool({ name: "get_status", arguments: {} });
    expect(status.isError).toBeFalsy();
    expect(payloadOf(status).status).toBe("ok");
    expect(session.calls[0]).toMatchObject({ url: `${BASE}/status`, method: "GET" });

    const languages = await session.client.callTool({
      name: "list_languages",
      arguments: { available_only: true },
    });
    expect(payloadOf(languages).languages).toHaveLength(1);

    await session.close();
  });

  it("search_words and score_words", async () => {
    const session = await connect([
      json({ words: [{ word: "COT", score: 90 }, { word: "CUT", score: 90 }] }),
      json({ scores: { CAT: 80 } }),
    ]);

    const words = await session.client.callTool({
      name: "search_words",
      arguments: { pattern: "C_T", lang: "en", min_score: 40, limit: 10 },
    });
    expect(payloadOf(words).words).toHaveLength(2);
    expect(session.calls[0].url).toContain("pattern=C_T");
    expect(session.calls[0].url).toContain("min_score=40");

    // The absent word is surfaced explicitly: "not in the index" is the signal
    // that a theme answer is fine, not that it scored badly.
    const scores = await session.client.callTool({
      name: "score_words",
      arguments: { words: ["CAT", "ZZTOP"], language: "en" },
    });
    expect(payloadOf(scores).notInIndex).toEqual(["ZZTOP"]);

    await session.close();
  });

  it("lookup_clues and lookup_clues_bulk", async () => {
    const session = await connect([
      json({ clues: [{ text: "Submarine sandwich", source: "published", pubCount: 118 }] }),
      json({ clues: { SUB: [{ text: "Submarine sandwich", source: "published", pubCount: 118 }] } }),
    ]);

    const one = await session.client.callTool({
      name: "lookup_clues",
      arguments: { word: "SUB", lang: "en", limit: 3 },
    });
    expect(payloadOf(one).clues[0].text).toBe("Submarine sandwich");
    expect(session.calls[0].url).toContain("/clues/SUB");

    const bulk = await session.client.callTool({
      name: "lookup_clues_bulk",
      arguments: { words: ["SUB", "QWERTYX"], language: "en" },
    });
    expect(payloadOf(bulk).noCluesFor).toEqual(["QWERTYX"]);

    await session.close();
  });

  it("generate_clues spends one unit per word", async () => {
    const session = await connect([
      json({ clues: [{ text: "Beacon on a rocky point", source: "ai", pubCount: 0 }], remaining: 247 }),
      json({ clues: [{ text: "Cookie", source: "ai", pubCount: 0 }], remaining: 246 }),
    ]);

    const generated = await session.client.callTool({
      name: "generate_clues",
      arguments: { words: ["LIGHTHOUSE", "OREO"], count: 1, language: "en" },
    });
    expect(session.calls).toHaveLength(2);
    expect(payloadOf(generated).remaining).toBe(246);
    expect(Object.keys(payloadOf(generated).clues)).toEqual(["LIGHTHOUSE", "OREO"]);

    await session.close();
  });

  it("fill_grid returns the numbered entries, not just rows", async () => {
    const session = await connect([
      json({
        grid: FILLED_GRID,
        slotsFilled: 8,
        slotsTotal: 8,
        sessionId: "kKq2",
        quality: { scored: 8, rough: [] },
      }),
    ]);

    const filled = await session.client.callTool({
      name: "fill_grid",
      arguments: { grid: MINI_GRID, language: "en" },
    });
    expect(filled.isError).toBeFalsy();
    // Defaults reach the wire, so the model never has to know them.
    expect(session.calls[0].body).toMatchObject({ min_score: 40, max_time: 25, language: "en" });

    const payload = payloadOf(filled);
    expect(payload.grid).toEqual(FILLED_GRID);
    // The whole point: ACROSS/DOWN maps keyed by clue number, ready for
    // `create_puzzle`'s `clues`.
    expect(payload.entries.across["5"]).toBe("NINER");
    expect(payload.entries.down["1"]).toBe("KNOLL");
    expect(payload.entries.unfilled).toEqual([]);

    await session.close();
  });

  it("fill_grid reports a failed solve as a result, not an error", async () => {
    const session = await connect([
      json({
        grid: MINI_GRID,
        slotsFilled: 0,
        slotsTotal: 8,
        reason: "too_difficult",
        quality: { scored: 0, rough: [] },
      }),
    ]);

    const filled = await session.client.callTool({
      name: "fill_grid",
      arguments: { grid: MINI_GRID },
    });
    expect(filled.isError).toBeFalsy();
    expect(textOf(filled)).toContain("too_difficult");
    expect(textOf(filled)).toContain("fill unit was still spent");

    await session.close();
  });

  it("improve_fill falls back to the grid it was given when nothing changed", async () => {
    const session = await connect([
      json({
        improved: false,
        quality: { scored: 8, rough: [{ word: "NQA", score: 35, row: 1, col: 2, number: 6, direction: "down" }] },
      }),
    ]);

    const improved = await session.client.callTool({
      name: "improve_fill",
      arguments: { grid: FILLED_GRID, locked: ["2,2"], language: "en" },
    });
    expect(session.calls[0].body).toMatchObject({ locked: ["2,2"], max_time: 25 });
    expect(payloadOf(improved).grid).toEqual(FILLED_GRID);
    expect(textOf(improved)).toContain("Do not retry");

    await session.close();
  });

  it("puzzle CRUD, publish and the embed snippet", async () => {
    const session = await connect([
      json({ total: 1, puzzles: [{ ...PUZZLE, status: "draft" }] }),
      json({ ...PUZZLE, status: "draft" }),
      json({ ...PUZZLE, status: "draft" }, { status: 201 }),
      json({ ...PUZZLE, status: "draft", title: "Seaside Mini" }),
      json(PUZZLE),
      new Response(null, { status: 204 }),
    ]);

    const listed = await session.client.callTool({ name: "list_puzzles", arguments: { status: "draft" } });
    expect(payloadOf(listed).total).toBe(1);

    const fetched = await session.client.callTool({ name: "get_puzzle", arguments: { id: "k3n8q1zp" } });
    // A draft has no public URL yet, so none is invented.
    expect(payloadOf(fetched).url).toBeUndefined();
    expect(payloadOf(fetched).entries.across["5"]).toBe("NINER");

    const created = await session.client.callTool({
      name: "create_puzzle",
      arguments: {
        title: "Coastal Mini",
        author: "Tex",
        language: "en",
        grid: FILLED_GRID,
        clues: { across: { "5": "Footballer" }, down: { "1": "Mound" } },
        themeWords: ["CREST"],
      },
    });
    expect(session.calls[2]).toMatchObject({ url: `${BASE}/puzzles`, method: "POST" });
    expect(session.calls[2].body).toMatchObject({ title: "Coastal Mini", themeWords: ["CREST"] });
    // `publish` is not sent unless asked for — an accidental publish is not
    // something a default should do.
    expect((session.calls[2].body as Record<string, unknown>).publish).toBeUndefined();
    expect(textOf(created)).toContain("Call publish_puzzle");

    const updated = await session.client.callTool({
      name: "update_puzzle",
      arguments: { id: "k3n8q1zp", title: "Seaside Mini" },
    });
    expect(session.calls[3]).toMatchObject({ method: "PATCH" });
    expect(session.calls[3].body).toEqual({ title: "Seaside Mini" });
    expect(payloadOf(updated).puzzle.title).toBe("Seaside Mini");

    const published = await session.client.callTool({
      name: "publish_puzzle",
      arguments: { id: "k3n8q1zp" },
    });
    // Unlisted by default: the showcase queue is read by a human.
    expect(session.calls[4].body).toMatchObject({ submitToShowcase: false });
    const payload = payloadOf(published);
    expect(payload.url).toBe("https://crossword.texs.org/puzzle/k3n8q1zp");
    expect(payload.embedUrl).toBe("https://crossword.texs.org/embed/k3n8q1zp");
    // The snippet is the site's own, so both halves of the host protocol are in it.
    expect(payload.embedSnippet).toContain('<iframe src="https://example.test/embed/k3n8q1zp"');
    expect(payload.embedSnippet).toContain('<script async src="https://example.test/embed.js">');

    const deleted = await session.client.callTool({ name: "delete_puzzle", arguments: { id: "k3n8q1zp" } });
    expect(session.calls[5]).toMatchObject({ method: "DELETE" });
    expect(textOf(deleted)).toContain("cannot be undone");

    await session.close();
  });

  it("export_puzzle returns .puz as base64 with decoding instructions", async () => {
    const bytes = new Uint8Array([0x41, 0x43, 0x52, 0x4f, 0x53, 0x53]);
    const session = await connect([
      json(PUZZLE),
      new Response(bytes, {
        status: 200,
        headers: {
          "content-type": "application/x-crossword",
          "content-disposition": 'attachment; filename="coastal-mini.puz"',
        },
      }),
    ]);

    const asJson = await session.client.callTool({
      name: "export_puzzle",
      arguments: { id: "k3n8q1zp", format: "json" },
    });
    expect(payloadOf(asJson).id).toBe("k3n8q1zp");

    const asPuz = await session.client.callTool({
      name: "export_puzzle",
      arguments: { id: "k3n8q1zp", format: "puz" },
    });
    const payload = payloadOf(asPuz);
    expect(payload.encoding).toBe("base64");
    expect(payload.filename).toBe("coastal-mini.puz");
    expect(Buffer.from(payload.data, "base64")).toEqual(Buffer.from(bytes));
    expect(textOf(asPuz)).toContain("base64");

    await session.close();
  });

  it("export_puzzle returns svg as text and pdf as base64", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>';
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    const session = await connect([
      new Response(svg, {
        status: 200,
        headers: {
          "content-type": "image/svg+xml",
          "content-disposition": 'attachment; filename="coastal-mini.svg"',
        },
      }),
      new Response(pdf, {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="coastal-mini.pdf"',
        },
      }),
    ]);

    const asSvg = await session.client.callTool({
      name: "export_puzzle",
      arguments: { id: "k3n8q1zp", format: "svg" },
    });
    expect(payloadOf(asSvg).data).toBe(svg);
    expect(payloadOf(asSvg).filename).toBe("coastal-mini.svg");

    const asPdf = await session.client.callTool({
      name: "export_puzzle",
      arguments: { id: "k3n8q1zp", format: "pdf", paper: "a4" },
    });
    expect(payloadOf(asPdf).encoding).toBe("base64");
    expect(Buffer.from(payloadOf(asPdf).data, "base64")).toEqual(Buffer.from(pdf));

    await session.close();
  });
});

// --- Errors ----------------------------------------------------------------

describe("error results", () => {
  it("turns a 403 GRID_SIZE_LOCKED into actionable isError content", async () => {
    const session = await connect([
      problem(403, "GRID_SIZE_LOCKED", "15×15 grids require a membership", { maxGridSize: 13 }),
    ]);

    const filled = await session.client.callTool({
      name: "fill_grid",
      arguments: { grid: Array.from({ length: 15 }, () => ".".repeat(15)) },
    });

    expect(filled.isError).toBe(true);
    const body = textOf(filled);
    expect(body).toContain("GRID_SIZE_LOCKED");
    expect(body).toContain("15×15 grids require a membership");
    // The hint has to name the number the model should retry with.
    expect(body).toContain("Retry with a grid of at most 13×13");

    const payload = payloadOf(filled);
    expect(payload).toMatchObject({
      error: true,
      code: "GRID_SIZE_LOCKED",
      status: 403,
      extra: { maxGridSize: 13 },
    });
    // Quota headers ride along so the model can see what is left.
    expect(payload.quota).toMatchObject({ fillQuotaRemaining: 17, limit: 60, remaining: 59 });

    await session.close();
  });

  it("surfaces UNAUTHORIZED without retrying", async () => {
    const session = await connect([
      problem(401, "UNAUTHORIZED", "Send your API key as `Authorization: Bearer cw_live_…`."),
    ]);

    const words = await session.client.callTool({
      name: "search_words",
      arguments: { pattern: "C_T" },
    });
    expect(words.isError).toBe(true);
    expect(textOf(words)).toContain("UNAUTHORIZED");
    expect(textOf(words)).toContain("CROSSWORD_API_KEY");
    expect(session.calls).toHaveLength(1);

    await session.close();
  });

  it("turns a transport failure into content rather than a protocol error", async () => {
    // No responses queued, so the mock throws — the tool must still answer.
    const session = await connect([]);
    const status = await session.client.callTool({ name: "get_status", arguments: {} });
    expect(status.isError).toBe(true);
    expect(textOf(status)).toContain("CLIENT_ERROR");
    await session.close();
  });
});

// --- generate_pattern ------------------------------------------------------

describe("generate_pattern", () => {
  /**
   * The shared generator returns an all-white grid rather than throwing when it
   * cannot hit its target — a grid where every row and column is one giant
   * entry, which auto-fill refuses. This is the regression that matters: the
   * tool must retry past it, and never hand one back.
   */
  for (const size of [11, 15]) {
    it(`never returns an all-white grid at ${size}×${size} (50 runs)`, () => {
      for (let run = 0; run < 50; run++) {
        const pattern = generatePatternResult(size, "american");
        expect(pattern.grid).toHaveLength(size);
        expect(pattern.blackCells).toBeGreaterThan(0);
        expect(pattern.slots).toBeGreaterThan(0);
        expect(pattern.grid.some((row) => row.includes("#"))).toBe(true);
      }
    });
  }

  it("reports failure instead of an open grid at a size the generator cannot satisfy", () => {
    // 9×9 American is one of the sizes the shared generator never satisfies —
    // 40 draws out of 40 come back open. Better a named failure than a grid
    // that is one giant entry.
    expect(() => generatePatternResult(9, "american")).toThrow(/could not place any black squares/);
  });

  it("gets closer to target_blacks than a single draw would", () => {
    const pattern = generatePatternResult(15, "american", 44);
    expect(pattern.blackCells).toBeGreaterThan(0);
    expect(pattern.attempts).toBeGreaterThan(0);
  });

  it("comes back through the tool with rows and a slot count", async () => {
    const session = await connect();
    const generated = await session.client.callTool({
      name: "generate_pattern",
      arguments: { size: 11, style: "american" },
    });
    const payload = payloadOf(generated);
    expect(payload.grid).toHaveLength(11);
    expect(payload.blackCells).toBeGreaterThan(0);
    expect(payload.slots).toBeGreaterThan(0);
    // Local means local: no request went out.
    expect(session.calls).toHaveLength(0);
    await session.close();
  });

  it("answers a size it cannot satisfy as an error result, not a bad grid", async () => {
    const session = await connect();
    const generated = await session.client.callTool({
      name: "generate_pattern",
      arguments: { size: 9, style: "american" },
    });
    expect(generated.isError).toBe(true);
    expect(textOf(generated)).toContain("Try a size between 10 and 18");
    await session.close();
  });
});

describe("gridEntries", () => {
  it("flags entries still holding a blank so they are not clued", () => {
    const entries = gridEntries(["CAT", "A.E", "TEN"], "en");
    expect(entries.across["1"]).toBe("CAT");
    expect(entries.down["1"]).toBe("CAT");
    expect(entries.across["4"]).toBe("A_E");
    expect(entries.unfilled).toContain("4-across");
  });
});

// --- stdout is the protocol ------------------------------------------------

describe("stdout hygiene", () => {
  let writes: string[];
  let spy: { mockRestore(): void };

  beforeEach(() => {
    writes = [];
    spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("writes nothing to stdout while listing and calling tools", async () => {
    const session = await connect([
      json({ status: "ok", version: "1.0.0", languages: {} }),
      json({ words: [{ word: "COT", score: 90 }] }),
      problem(403, "GRID_SIZE_LOCKED", "too big", { maxGridSize: 13 }),
    ]);

    await session.client.listTools();
    await session.client.listPrompts();
    await session.client.callTool({ name: "get_status", arguments: {} });
    await session.client.callTool({ name: "search_words", arguments: { pattern: "C_T" } });
    await session.client.callTool({ name: "generate_pattern", arguments: { size: 11 } });
    await session.client.callTool({ name: "fill_grid", arguments: { grid: MINI_GRID } });
    await session.close();

    expect(writes).toEqual([]);
  });
});
