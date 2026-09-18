import { describe, expect, it, vi } from "vitest";

import { CrosswordApiError, CrosswordClient } from "../src/index.js";

const BASE = "https://example.test/api/v1";

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

/**
 * A fetch stand-in that replays a queue of responses and records what it was
 * asked for. Every client method is exercised through this rather than against
 * a live server: the point of these tests is the request the SDK *builds* —
 * method, path, query, body, headers — which a live test would not pin down.
 */
function mockFetch(responses: Response[]) {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = queue.shift();
    if (!next) throw new Error(`No mocked response left for ${url}`);
    return next;
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
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
    { status, headers: { "content-type": "application/problem+json" } }
  );
}

function client(responses: Response[], options = {}) {
  const { fetchImpl, calls } = mockFetch(responses);
  return {
    calls,
    client: new CrosswordClient({
      apiKey: "cw_live_TESTKEY0000000000000000000000",
      baseUrl: BASE,
      fetch: fetchImpl,
      ...options,
    }),
  };
}

describe("CrosswordClient — one call per operation", () => {
  it("getStatus", async () => {
    const { client: c, calls } = client([
      json({ status: "ok", version: "1.0.0", languages: { en: { available: true, loaded: true } } }),
    ]);
    const status = await c.getStatus();
    expect(status.status).toBe("ok");
    expect(calls[0]).toMatchObject({ url: `${BASE}/status`, method: "GET" });
  });

  it("listLanguages unwraps the envelope", async () => {
    const { client: c } = client([json({ languages: [{ code: "en", name: "English" }] })]);
    const languages = await c.listLanguages();
    expect(languages).toHaveLength(1);
    expect(languages[0].code).toBe("en");
  });

  it("searchWords builds the query string", async () => {
    const { client: c, calls } = client([json({ words: [{ word: "CAT", score: 80 }] })]);
    const words = await c.searchWords({ pattern: "C_T", lang: "en", min_score: 40, limit: 5 });
    expect(words[0].word).toBe("CAT");
    expect(calls[0].url).toBe(`${BASE}/words?pattern=C_T&lang=en&min_score=40&limit=5`);
  });

  it("searchWords omits undefined params rather than sending 'undefined'", async () => {
    const { client: c, calls } = client([json({ words: [] })]);
    await c.searchWords({ pattern: "C_T", min_score: undefined });
    expect(calls[0].url).toBe(`${BASE}/words?pattern=C_T`);
  });

  it("scoreWords returns the map, unknown words absent", async () => {
    const { client: c, calls } = client([json({ scores: { CAT: 80, ESNE: 25 } })]);
    const scores = await c.scoreWords({ words: ["CAT", "ESNE", "ZZTOP"], language: "en" });
    expect(scores).toEqual({ CAT: 80, ESNE: 25 });
    expect(scores.ZZTOP).toBeUndefined();
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ words: ["CAT", "ESNE", "ZZTOP"], language: "en" });
  });

  it("lookupClues encodes the answer into the path", async () => {
    const { client: c, calls } = client([
      json({ clues: [{ text: "Submarine sandwich", source: "xd", pubCount: 118 }] }),
    ]);
    const clues = await c.lookupClues("SUB", { language: "en", limit: 3 });
    expect(clues[0].pubCount).toBe(118);
    expect(calls[0].url).toBe(`${BASE}/clues/SUB?language=en&limit=3`);
  });

  it("lookupClues percent-encodes a non-ASCII answer", async () => {
    const { client: c, calls } = client([json({ clues: [] })]);
    await c.lookupClues("ЛУНА", { language: "ru" });
    expect(calls[0].url).toBe(`${BASE}/clues/${encodeURIComponent("ЛУНА")}?language=ru`);
  });

  it("lookupCluesBulk", async () => {
    const { client: c, calls } = client([
      json({ clues: { SUB: [{ text: "Stand-in", source: "xd" }] } }),
    ]);
    const clues = await c.lookupCluesBulk({ words: ["SUB", "QWERTYX"], language: "en" });
    expect(Object.keys(clues)).toEqual(["SUB"]);
    expect(calls[0].url).toBe(`${BASE}/clues/bulk`);
  });

  it("generateClues", async () => {
    const { client: c, calls } = client([
      json(
        { clues: [{ text: "Beacon on a rocky point", source: "ai", pubCount: 0 }], remaining: 247 },
        { headers: { "x-ai-clues-remaining": "247" } }
      ),
    ]);
    const result = await c.generateClues({ word: "LIGHTHOUSE", count: 3, language: "en" });
    expect(result.remaining).toBe(247);
    expect(c.lastRateLimit.aiCluesRemaining).toBe(247);
    expect(calls[0].body).toEqual({ word: "LIGHTHOUSE", count: 3, language: "en" });
  });

  it("fillGrid accepts a bare grid and lifts the session header", async () => {
    const { client: c, calls } = client([
      json(
        {
          grid: ["SPA#TO", "TONER.", "ARABS.", "REBUT.", "SNL#ES"],
          slotsFilled: 12,
          slotsTotal: 12,
          quality: { scored: 12, rough: [] },
        },
        { headers: { "x-fill-session-id": "sess-1", "x-fill-quota-remaining": "183" } }
      ),
    ]);
    const result = await c.fillGrid(["..#..", ".....", "..A..", ".....", "..#.."]);
    expect(result.sessionId).toBe("sess-1");
    expect(c.lastRateLimit.fillQuotaRemaining).toBe(183);
    expect(calls[0].body).toEqual({ grid: ["..#..", ".....", "..A..", ".....", "..#.."] });
  });

  it("fillGrid surfaces a 200 that filled nothing, with its reason", async () => {
    // A well-formed request the solver could not satisfy is a 200 with
    // slotsFilled: 0 and a `reason`, not an error — so it must not throw.
    const { client: c } = client([
      json({
        grid: ["..#..", ".....", "..A..", ".....", "..#.."],
        slotsFilled: 0,
        slotsTotal: 12,
        quality: { scored: 0, rough: [] },
        reason: "too_difficult",
      }),
    ]);
    const result = await c.fillGrid(["..#..", ".....", "..A..", ".....", "..#.."]);
    expect(result.slotsFilled).toBe(0);
    expect(result.reason).toBe("too_difficult");
  });

  it("improveFill", async () => {
    const { client: c, calls } = client([
      json({ improved: true, replaced: 3, grid: ["AB#", "CDE", "FGH"], quality: { scored: 4, rough: [] } }),
    ]);
    const result = await c.improveFill({ grid: ["AB#", "CDE", "FGH"], locked: ["0,0"], language: "en" });
    expect(result.replaced).toBe(3);
    expect(calls[0].url).toBe(`${BASE}/fill/improve`);
    expect(calls[0].body).toMatchObject({ locked: ["0,0"] });
  });

  it("cancelFill sends snake_case session_id", async () => {
    const { client: c, calls } = client([json({ cancelled: true, sessionId: "sess-1" })]);
    const result = await c.cancelFill("sess-1");
    expect(result.cancelled).toBe(true);
    expect(calls[0].body).toEqual({ session_id: "sess-1" });
  });

  it("listPuzzles", async () => {
    const { client: c, calls } = client([json({ total: 0, puzzles: [] })]);
    const result = await c.listPuzzles({ status: "draft", limit: 10 });
    expect(result.total).toBe(0);
    expect(calls[0].url).toBe(`${BASE}/puzzles?status=draft&limit=10`);
  });

  it("createPuzzle", async () => {
    const { client: c, calls } = client([
      json({ id: "k3n8q1zp", title: "Lighthouses" }, { status: 201 }),
    ]);
    const puzzle = await c.createPuzzle({ title: "Lighthouses", grid: ["AB#", "CDE", "FGH"] });
    expect(puzzle.id).toBe("k3n8q1zp");
    expect(calls[0].method).toBe("POST");
  });

  it("getPuzzle", async () => {
    const { client: c, calls } = client([json({ id: "k3n8q1zp" })]);
    await c.getPuzzle("k3n8q1zp");
    expect(calls[0].url).toBe(`${BASE}/puzzles/k3n8q1zp`);
  });

  it("updatePuzzle uses PATCH", async () => {
    const { client: c, calls } = client([json({ id: "k3n8q1zp", title: "Beacons" })]);
    const puzzle = await c.updatePuzzle("k3n8q1zp", { title: "Beacons" });
    expect(puzzle.title).toBe("Beacons");
    expect(calls[0].method).toBe("PATCH");
  });

  it("deletePuzzle resolves on 204", async () => {
    const { client: c, calls } = client([new Response(null, { status: 204 })]);
    await expect(c.deletePuzzle("k3n8q1zp")).resolves.toBeUndefined();
    expect(calls[0].method).toBe("DELETE");
  });

  it("publishPuzzle", async () => {
    const { client: c, calls } = client([
      json({ id: "k3n8q1zp", status: "published", url: "https://crossword.texs.org/puzzle/k3n8q1zp" }),
    ]);
    const puzzle = await c.publishPuzzle("k3n8q1zp", { submitToShowcase: false, writeup: "hi" });
    expect(puzzle.url).toContain("/puzzle/k3n8q1zp");
    expect(calls[0].url).toBe(`${BASE}/puzzles/k3n8q1zp/publish`);
    expect(calls[0].body).toEqual({ submitToShowcase: false, writeup: "hi" });
  });

  it("exportPuzzle json", async () => {
    const { client: c, calls } = client([json({ id: "k3n8q1zp", title: "Lighthouses" })]);
    const puzzle = await c.exportPuzzle("k3n8q1zp");
    expect(puzzle.title).toBe("Lighthouses");
    expect(calls[0].url).toBe(`${BASE}/puzzles/k3n8q1zp/export?format=json`);
  });

  it("exportPuzzle puz returns bytes and the suggested filename", async () => {
    const bytes = new Uint8Array([0, 0, 65, 67, 82, 79, 83, 83]);
    const { client: c, calls } = client([
      new Response(bytes, {
        status: 200,
        headers: {
          "content-type": "application/x-crossword",
          "content-disposition": 'attachment; filename="lighthouses.puz"',
        },
      }),
    ]);
    const result = await c.exportPuzzle("k3n8q1zp", { format: "puz" });
    expect(result.filename).toBe("lighthouses.puz");
    expect(Array.from(result.data)).toEqual(Array.from(bytes));
    expect(calls[0].headers.get("accept")).toBe("application/x-crossword");
  });
});

describe("authentication and headers", () => {
  it("sends the bearer token and a user agent", async () => {
    const { client: c, calls } = client([json({ words: [] })]);
    await c.searchWords({ pattern: "C_T" });
    expect(calls[0].headers.get("authorization")).toBe(
      "Bearer cw_live_TESTKEY0000000000000000000000"
    );
    expect(calls[0].headers.get("user-agent")).toMatch(/^xword\//);
  });

  it("omits the header entirely when there is no key", async () => {
    const { fetchImpl, calls } = mockFetch([json({ languages: [] })]);
    const c = new CrosswordClient({ baseUrl: BASE, fetch: fetchImpl });
    await c.listLanguages();
    expect(calls[0].headers.get("authorization")).toBeNull();
    expect(c.hasApiKey).toBe(false);
  });
});

describe("problem+json parsing", () => {
  it("carries code, detail and extras", async () => {
    const { client: c } = client([
      problem(403, "GRID_SIZE_LOCKED", "15×15 grids require a membership", { maxGridSize: 13 }),
    ]);
    await expect(c.fillGrid(["...", "...", "..."])).rejects.toThrow(CrosswordApiError);

    const { client: c2 } = client([
      problem(403, "GRID_SIZE_LOCKED", "15×15 grids require a membership", { maxGridSize: 13 }),
    ]);
    const error = await c2.fillGrid(["...", "...", "..."]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CrosswordApiError);
    const apiError = error as CrosswordApiError;
    expect(apiError.status).toBe(403);
    expect(apiError.code).toBe("GRID_SIZE_LOCKED");
    expect(apiError.problem?.detail).toBe("15×15 grids require a membership");
    expect(apiError.extra<number>("maxGridSize")).toBe(13);
    expect(apiError.message).toContain("GRID_SIZE_LOCKED");
  });

  it("survives a non-JSON error body", async () => {
    const { client: c } = client([
      new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    ]);
    const error = (await c.getPuzzle("k3n8q1zp").catch((e: unknown) => e)) as CrosswordApiError;
    expect(error.status).toBe(502);
    expect(error.code).toBe("UNKNOWN");
    expect(error.problem).toBeNull();
    expect(error.body).toContain("502 Bad Gateway");
  });

  it("reads rate-limit headers off a 429", async () => {
    const { client: c } = client(
      [
        problem(429, "RATE_LIMITED", "60 requests per minute exceeded", { limit: 60 }),
      ],
      { retryOnRateLimit: false }
    );
    const error = (await c.searchWords({ pattern: "C_T" }).catch((e: unknown) => e)) as CrosswordApiError;
    expect(error.isRateLimited).toBe(true);
    expect(error.extra<number>("limit")).toBe(60);
  });
});

describe("Retry-After handling", () => {
  function limited(retryAfter: string): Response {
    return new Response(
      JSON.stringify({ type: "x", title: "Rate limited", status: 429, code: "RATE_LIMITED" }),
      { status: 429, headers: { "retry-after": retryAfter, "content-type": "application/problem+json" } }
    );
  }

  it("retries a read exactly once and returns the second answer", async () => {
    const { client: c, calls } = client([limited("0"), json({ words: [{ word: "CAT", score: 80 }] })]);
    const words = await c.searchWords({ pattern: "C_T" });
    expect(words).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("gives up after one retry rather than looping", async () => {
    const { client: c, calls } = client([limited("0"), limited("0")]);
    await expect(c.searchWords({ pattern: "C_T" })).rejects.toThrow(CrosswordApiError);
    expect(calls).toHaveLength(2);
  });

  it("never retries a fill — the quota is already spent", async () => {
    const { client: c, calls } = client([limited("0"), json({ grid: [], slotsFilled: 0 })]);
    await expect(c.fillGrid(["...", "...", "..."])).rejects.toThrow(CrosswordApiError);
    expect(calls).toHaveLength(1);
  });

  it("never retries clue generation — it costs money per call", async () => {
    const { client: c, calls } = client([limited("0"), json({ clues: [] })]);
    await expect(c.generateClues({ word: "CAT" })).rejects.toThrow(CrosswordApiError);
    expect(calls).toHaveLength(1);
  });

  it("does not sleep out an absurd Retry-After", async () => {
    const { client: c, calls } = client([limited("3600")], { maxRetryDelayMs: 1000 });
    await expect(c.searchWords({ pattern: "C_T" })).rejects.toThrow(CrosswordApiError);
    expect(calls).toHaveLength(1);
  });
});

describe("fillGridStream", () => {
  function sseResponse(frames: string[]): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  it("yields session first, then progress, then complete", async () => {
    const { client: c, calls } = client([
      sseResponse([
        'data: {"type":"session","sessionId":"sess-1"}\n\n',
        'data: {"type":"progress","filled":4,"total":12,"fill":{"0,0":"S"}}\n\n',
        'data: {"type":"complete","grid":["SPA#TO"],"fill":{},"slotsFilled":12,"slotsTotal":12,"quality":{"scored":12,"rough":[]}}\n\n',
      ]),
    ]);

    const events = [];
    for await (const event of c.fillGridStream(["..#..", ".....", "..A..", ".....", "..#.."])) {
      events.push(event);
    }

    expect(events.map((e) => e.type)).toEqual(["session", "progress", "complete"]);
    expect(events[0]).toMatchObject({ sessionId: "sess-1" });
    expect(calls[0].headers.get("accept")).toBe("text/event-stream");
  });

  it("yields a terminal error frame with its reason instead of throwing", async () => {
    const { client: c } = client([
      sseResponse([
        'data: {"type":"session","sessionId":"sess-2"}\n\n',
        'data: {"type":"error","reason":"too_difficult","message":"Grid looks hopeless"}\n\n',
      ]),
    ]);
    const events = [];
    for await (const event of c.fillGridStream(["...", "...", "..."])) events.push(event);
    expect(events[1]).toMatchObject({ type: "error", reason: "too_difficult" });
  });

  it("reassembles a frame split across chunk boundaries", async () => {
    const { client: c } = client([
      sseResponse([
        'data: {"type":"sess',
        'ion","sessionId":"sess-3"}\n\ndata: {"type":"progress","fil',
        'led":1,"total":2,"fill":{}}\n\n',
      ]),
    ]);
    const events = [];
    for await (const event of c.fillGridStream(["...", "...", "..."])) events.push(event);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ sessionId: "sess-3" });
  });

  it("skips a malformed frame rather than failing the solve", async () => {
    const { client: c } = client([
      sseResponse([
        ": keep-alive\n\n",
        "data: {not json}\n\n",
        'data: {"type":"complete","grid":["AB#"],"fill":{},"slotsFilled":1,"slotsTotal":1,"quality":{"scored":1,"rough":[]}}\n\n',
      ]),
    ]);
    const events = [];
    for await (const event of c.fillGridStream(["...", "...", "..."])) events.push(event);
    expect(events.map((e) => e.type)).toEqual(["complete"]);
  });

  it("handles CRLF line endings", async () => {
    const { client: c } = client([
      sseResponse(['data: {"type":"session","sessionId":"sess-4"}\r\n\r\n']),
    ]);
    const events = [];
    for await (const event of c.fillGridStream(["...", "...", "..."])) events.push(event);
    expect(events[0]).toMatchObject({ sessionId: "sess-4" });
  });

  it("throws on an HTTP failure before the stream starts", async () => {
    const { client: c } = client([problem(429, "SOLVER_BUSY", "Too many solves running")]);
    const iterate = async () => {
      for await (const _event of c.fillGridStream(["...", "...", "..."])) void _event;
    };
    await expect(iterate()).rejects.toThrow(CrosswordApiError);
  });
});
