/**
 * The typed client for the Crossword Generator API.
 *
 * One method per `operationId` in `docs/api/openapi.yaml`, with request and
 * response types generated from that file (`npm run gen`) rather than
 * hand-written, so a contract change surfaces as a type error here instead of a
 * runtime surprise in a caller.
 *
 * Zero runtime dependencies: global `fetch` and a hand-written SSE reader.
 */
import { CrosswordApiError, readRateLimit, type RateLimitInfo } from "./errors.js";
import { readSseFrames } from "./sse.js";
import type { components, operations } from "./types.gen.js";

// --- Contract types, re-exported under friendlier names -------------------

export type LanguageCode = components["schemas"]["LanguageCode"];
export type Language = components["schemas"]["Language"];
export type Status = components["schemas"]["Status"];
/** Rows of text, one grapheme per cell: `.` empty, `#` black, else a letter. */
export type Grid = components["schemas"]["Grid"];
export type LockedCells = components["schemas"]["LockedCells"];
export type WordMatch = components["schemas"]["WordMatch"];
export type Clue = components["schemas"]["Clue"];
export type RoughEntry = components["schemas"]["RoughEntry"];
export type FillQuality = components["schemas"]["FillQuality"];
export type FillRequest = components["schemas"]["FillRequest"];
export type FillResult = components["schemas"]["FillResult"];
export type ImproveRequest = components["schemas"]["ImproveRequest"];
export type ImproveResult = components["schemas"]["ImproveResult"];
export type FillEvent = components["schemas"]["FillEvent"];
export type FillSessionEvent = components["schemas"]["FillSessionEvent"];
export type FillProgressEvent = components["schemas"]["FillProgressEvent"];
export type FillCompleteEvent = components["schemas"]["FillCompleteEvent"];
export type FillErrorEvent = components["schemas"]["FillErrorEvent"];
export type Puzzle = components["schemas"]["Puzzle"];
export type PuzzleInput = components["schemas"]["PuzzleInput"];
export type PuzzlePatch = components["schemas"]["PuzzlePatch"];
export type ShowcaseStatus = components["schemas"]["ShowcaseStatus"];
export type ClueMap = components["schemas"]["ClueMap"];

export type SearchWordsParams = operations["searchWords"]["parameters"]["query"];
export type LookupCluesParams = operations["lookupClues"]["parameters"]["query"];
export type ListPuzzlesParams = operations["listPuzzles"]["parameters"]["query"];
export type ScoreWordsBody =
  operations["scoreWords"]["requestBody"]["content"]["application/json"];
export type LookupCluesBulkBody =
  operations["lookupCluesBulk"]["requestBody"]["content"]["application/json"];
export type GenerateCluesBody =
  operations["generateClues"]["requestBody"]["content"]["application/json"];
export type PublishPuzzleBody = NonNullable<
  operations["publishPuzzle"]["requestBody"]
>["content"]["application/json"];
export type CancelFillBody =
  operations["cancelFill"]["requestBody"]["content"]["application/json"];

export type GenerateCluesResult =
  operations["generateClues"]["responses"][200]["content"]["application/json"];
export type CancelFillResult =
  operations["cancelFill"]["responses"][200]["content"]["application/json"];
export type ListPuzzlesResult =
  operations["listPuzzles"]["responses"][200]["content"]["application/json"];

/** The `.puz` bytes plus the filename the server suggested. */
export interface PuzExportResult {
  data: Uint8Array;
  filename: string;
}

/** The self-contained HTML page plus the filename the server suggested. */
export interface HtmlExportResult {
  data: string;
  filename: string;
}

export const DEFAULT_BASE_URL = "https://crossword.texs.org/api/v1";

export interface CrosswordClientOptions {
  /** `cw_live_…`. Optional — `/status` and `/languages` need no key. */
  apiKey?: string;
  /** Defaults to `https://crossword.texs.org/api/v1`. */
  baseUrl?: string;
  /** Injectable for tests, proxies, or a fetch with its own agent. */
  fetch?: typeof globalThis.fetch;
  /** Appended to the default `xword/<version>` user agent. */
  userAgent?: string;
  /**
   * Longest `Retry-After` the automatic read retry will wait out, in ms.
   * Beyond this the 429 is thrown instead of slept through — a CLI that hangs
   * for eleven minutes looks broken. Default 60s.
   */
  maxRetryDelayMs?: number;
  /** Disable the single automatic retry on a rate-limited read. */
  retryOnRateLimit?: boolean;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

/** Non-body context from a successful response, when a caller wants it. */
export interface ResponseMeta {
  rateLimit: RateLimitInfo;
  sessionId?: string;
}

const PACKAGE_VERSION = "0.1.2";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Aborted"));
      },
      { once: true }
    );
  });
}

/** `["..#..", …]` or a full `FillRequest`; both are accepted everywhere. */
function asFillRequest(input: Grid | FillRequest): FillRequest {
  return Array.isArray(input) ? { grid: input } : input;
}

function asImproveRequest(input: Grid | ImproveRequest): ImproveRequest {
  return Array.isArray(input) ? { grid: input } : input;
}

function toQuery(params: Record<string, unknown> | undefined): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : "";
}

export class CrosswordClient {
  readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly userAgent: string;
  private readonly maxRetryDelayMs: number;
  private readonly retryOnRateLimit: boolean;

  /** Limit/quota headers from the most recent response. */
  lastRateLimit: RateLimitInfo = {};

  constructor(options: CrosswordClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    // Bound, not captured bare: some fetch implementations (undici's included)
    // throw "Illegal invocation" when called detached from their receiver.
    const impl = options.fetch ?? globalThis.fetch;
    if (typeof impl !== "function") {
      throw new Error(
        "No global fetch available. Use Node 20 or newer, or pass `fetch` in the client options."
      );
    }
    this.fetchImpl = options.fetch ? impl : impl.bind(globalThis);
    this.userAgent = options.userAgent
      ? `xword/${PACKAGE_VERSION} ${options.userAgent}`
      : `xword/${PACKAGE_VERSION}`;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000;
    this.retryOnRateLimit = options.retryOnRateLimit ?? true;
  }

  /** True when this client was given a key. Never exposes the key itself. */
  get hasApiKey(): boolean {
    return Boolean(this.apiKey);
  }

  private headers(extra: Record<string, string> = {}): Headers {
    const headers = new Headers({ "user-agent": this.userAgent, ...extra });
    if (this.apiKey) headers.set("authorization", `Bearer ${this.apiKey}`);
    return headers;
  }

  /**
   * One HTTP round trip.
   *
   * `retryable` is set only by read operations. Fill, improve, clue generation
   * and every puzzle write draw from a monthly quota or mutate state, so a
   * transparent retry could spend a second unit or create a second puzzle —
   * those surface the 429 and let the caller decide.
   */
  private async request(
    method: string,
    path: string,
    init: {
      query?: Record<string, unknown>;
      body?: unknown;
      accept?: string;
      retryable?: boolean;
      signal?: AbortSignal;
      /** Extra request headers (an `Idempotency-Key`). */
      headers?: Record<string, string>;
    } = {}
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}${toQuery(init.query)}`;
    const headers = this.headers({ accept: init.accept ?? "application/json" });
    for (const [name, value] of Object.entries(init.headers ?? {})) headers.set(name, value);
    let payload: string | undefined;
    if (init.body !== undefined) {
      headers.set("content-type", "application/json");
      payload = JSON.stringify(init.body);
    }

    let attempt = 0;
    for (;;) {
      const response = await this.fetchImpl(url, {
        method,
        headers,
        body: payload,
        signal: init.signal,
      });
      this.lastRateLimit = readRateLimit(response.headers);

      if (response.ok) return response;

      const canRetry =
        this.retryOnRateLimit &&
        init.retryable === true &&
        response.status === 429 &&
        attempt === 0;

      if (!canRetry) throw await CrosswordApiError.fromResponse(response);

      const retryAfter = this.lastRateLimit.retryAfter;
      const delayMs = Math.max(0, (retryAfter ?? 1) * 1000);
      if (delayMs > this.maxRetryDelayMs) {
        throw await CrosswordApiError.fromResponse(response);
      }
      // Drain so the connection can be reused.
      await response.text().catch(() => undefined);
      attempt += 1;
      await sleep(delayMs, init.signal);
    }
  }

  private async json<T>(response: Response): Promise<T> {
    return (await response.json()) as T;
  }

  // --- Meta ---------------------------------------------------------------

  /** `GET /status` — liveness and per-language index residency. No key needed. */
  async getStatus(options: RequestOptions = {}): Promise<Status> {
    const response = await this.request("GET", "/status", {
      retryable: true,
      signal: options.signal,
    });
    return this.json<Status>(response);
  }

  /** `GET /languages` — the language registry. No key needed. */
  async listLanguages(options: RequestOptions = {}): Promise<Language[]> {
    const response = await this.request("GET", "/languages", {
      retryable: true,
      signal: options.signal,
    });
    const body = await this.json<{ languages: Language[] }>(response);
    return body.languages;
  }

  // --- Words --------------------------------------------------------------

  /** `GET /words` — pattern search. `_` or `?` is a wildcard; `limit` caps at 100. */
  async searchWords(
    params: SearchWordsParams,
    options: RequestOptions = {}
  ): Promise<WordMatch[]> {
    const response = await this.request("GET", "/words", {
      query: params as Record<string, unknown>,
      retryable: true,
      signal: options.signal,
    });
    const body = await this.json<{ words: WordMatch[] }>(response);
    return body.words;
  }

  /**
   * `POST /words/scores` — dictionary score per word.
   *
   * Words the index does not know are **absent** from the map rather than
   * scored 0, which is how you tell a theme answer apart from a bad one.
   */
  async scoreWords(
    body: ScoreWordsBody,
    options: RequestOptions = {}
  ): Promise<Record<string, number>> {
    const response = await this.request("POST", "/words/scores", {
      body,
      retryable: true,
      signal: options.signal,
    });
    const parsed = await this.json<{ scores: Record<string, number> }>(response);
    return parsed.scores;
  }

  // --- Clues --------------------------------------------------------------

  /** `GET /clues/{word}` — corpus clues for one answer, best first. */
  async lookupClues(
    word: string,
    params: LookupCluesParams = {},
    options: RequestOptions = {}
  ): Promise<Clue[]> {
    const response = await this.request(
      "GET",
      `/clues/${encodeURIComponent(word)}`,
      {
        query: params as Record<string, unknown>,
        retryable: true,
        signal: options.signal,
      }
    );
    const body = await this.json<{ clues: Clue[] }>(response);
    return body.clues;
  }

  /**
   * `POST /clues/bulk` — up to five clues for each of up to 500 answers.
   *
   * Keys come back in the corpus's normalized form, which may differ from what
   * you sent; answers with no clues are omitted.
   */
  async lookupCluesBulk(
    body: LookupCluesBulkBody,
    options: RequestOptions = {}
  ): Promise<Record<string, Clue[]>> {
    const response = await this.request("POST", "/clues/bulk", {
      body,
      retryable: true,
      signal: options.signal,
    });
    const parsed = await this.json<{ clues: Record<string, Clue[]> }>(response);
    return parsed.clues;
  }

  /**
   * `POST /clues/generate` — fresh AI clue candidates. **Members only**, and
   * every call draws from the monthly AI-clue allowance, so this is never
   * retried automatically.
   */
  async generateClues(
    body: GenerateCluesBody,
    options: RequestOptions = {}
  ): Promise<GenerateCluesResult> {
    const response = await this.request("POST", "/clues/generate", {
      body,
      signal: options.signal,
    });
    return this.json<GenerateCluesResult>(response);
  }

  // --- Solver -------------------------------------------------------------

  /**
   * `POST /fill` — auto-fill a grid, blocking until the solve finishes.
   *
   * Accepts a bare grid (`["..#..", …]`) or a full `FillRequest`. A well-formed
   * grid the solver could not fill comes back 200 with `slotsFilled: 0` and a
   * `reason`, not as an error — only a bad request, a locked grid size or a
   * spent quota throws.
   */
  async fillGrid(
    input: Grid | FillRequest,
    options: RequestOptions = {}
  ): Promise<FillResult> {
    const response = await this.request("POST", "/fill", {
      body: asFillRequest(input),
      signal: options.signal,
    });
    const sessionId = response.headers.get("x-fill-session-id");
    const result = await this.json<FillResult>(response);
    return sessionId && !result.sessionId ? { ...result, sessionId } : result;
  }

  /**
   * `POST /fill` with `Accept: text/event-stream` — the same solve as an async
   * iterator of `session` → `progress`* → (`complete` | `error`).
   *
   * The `session` frame arrives first so you hold the id for `cancelFill`
   * before any work lands. Progress is **not** monotonic: the solver backtracks
   * and restarts, so render the latest frame rather than accumulating them.
   *
   * A terminal `error` frame is yielded, not thrown — it is a legitimate
   * outcome of a well-formed request (the grid was too hard, or you cancelled),
   * and the quota was spent either way. HTTP-level failures still throw.
   */
  async *fillGridStream(
    input: Grid | FillRequest,
    options: RequestOptions = {}
  ): AsyncGenerator<FillEvent> {
    const response = await this.request("POST", "/fill", {
      body: asFillRequest(input),
      accept: "text/event-stream",
      signal: options.signal,
    });
    if (!response.body) {
      throw new CrosswordApiError({
        status: response.status,
        code: "UPSTREAM_UNAVAILABLE",
        message: "The fill stream returned no body",
      });
    }
    for await (const frame of readSseFrames(response.body, options.signal)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(frame.data);
      } catch {
        // A malformed frame costs one progress tick, not the whole solve.
        continue;
      }
      if (parsed && typeof parsed === "object" && "type" in parsed) {
        yield parsed as FillEvent;
      }
    }
  }

  /**
   * `POST /fill/improve` — swap the obscure entries in a filled grid for common
   * words. Counts against the same monthly quota as a fill.
   */
  async improveFill(
    input: Grid | ImproveRequest,
    options: RequestOptions = {}
  ): Promise<ImproveResult> {
    const response = await this.request("POST", "/fill/improve", {
      body: asImproveRequest(input),
      signal: options.signal,
    });
    return this.json<ImproveResult>(response);
  }

  /** `POST /fill/cancel` — stop an in-flight streaming fill. Idempotent. */
  async cancelFill(
    sessionId: string,
    options: RequestOptions = {}
  ): Promise<CancelFillResult> {
    const response = await this.request("POST", "/fill/cancel", {
      body: { session_id: sessionId } satisfies CancelFillBody,
      signal: options.signal,
    });
    return this.json<CancelFillResult>(response);
  }

  // --- Puzzles ------------------------------------------------------------

  /** `GET /puzzles` — your own puzzles, newest edit first. */
  async listPuzzles(
    params: ListPuzzlesParams = {},
    options: RequestOptions = {}
  ): Promise<ListPuzzlesResult> {
    const response = await this.request("GET", "/puzzles", {
      query: params as Record<string, unknown>,
      retryable: true,
      signal: options.signal,
    });
    return this.json<ListPuzzlesResult>(response);
  }

  /**
   * `POST /puzzles` — save a new puzzle. Returns the stored row: 201 when it
   * was created, 200 when `idempotencyKey` matched an earlier create and this
   * is that puzzle (the server sets `Idempotent-Replayed: true`; a replay
   * spends nothing). Pass a key from anything that can fire twice — a CMS
   * save hook, a retrying queue — so a repeat can't make a twin.
   */
  async createPuzzle(
    body: PuzzleInput,
    options: RequestOptions & { idempotencyKey?: string } = {}
  ): Promise<Puzzle> {
    const response = await this.request("POST", "/puzzles", {
      body,
      signal: options.signal,
      ...(options.idempotencyKey === undefined
        ? {}
        : { headers: { "Idempotency-Key": options.idempotencyKey } }),
    });
    return this.json<Puzzle>(response);
  }

  /** `GET /puzzles/{id}` — one of yours, or any published puzzle. */
  async getPuzzle(id: string, options: RequestOptions = {}): Promise<Puzzle> {
    const response = await this.request(
      "GET",
      `/puzzles/${encodeURIComponent(id)}`,
      { retryable: true, signal: options.signal }
    );
    return this.json<Puzzle>(response);
  }

  /** `PATCH /puzzles/{id}` — change a subset of fields; omitted ones stay put. */
  async updatePuzzle(
    id: string,
    patch: PuzzlePatch,
    options: RequestOptions = {}
  ): Promise<Puzzle> {
    const response = await this.request(
      "PATCH",
      `/puzzles/${encodeURIComponent(id)}`,
      { body: patch, signal: options.signal }
    );
    return this.json<Puzzle>(response);
  }

  /** `DELETE /puzzles/{id}` — permanent, history included. Resolves on 204. */
  async deletePuzzle(id: string, options: RequestOptions = {}): Promise<void> {
    await this.request("DELETE", `/puzzles/${encodeURIComponent(id)}`, {
      signal: options.signal,
    });
  }

  /**
   * `POST /puzzles/{id}/publish` — mint the public URL and run moderation.
   * `submitToShowcase: false` publishes an unlisted link instead.
   */
  async publishPuzzle(
    id: string,
    body: PublishPuzzleBody = {},
    options: RequestOptions = {}
  ): Promise<Puzzle> {
    const response = await this.request(
      "POST",
      `/puzzles/${encodeURIComponent(id)}/publish`,
      { body, signal: options.signal }
    );
    return this.json<Puzzle>(response);
  }

  /**
   * `GET /puzzles/{id}/export` — the `Puzzle` document, the Across Lite
   * binary, or a self-contained HTML page to host yourself. `.puz` is
   * single-byte ISO-8859-1, so a language whose `puzExportable` is `false`
   * returns `400 VALIDATION_ERROR` instead of a corrupt file; `html` needs a
   * full grid with every entry clued and returns the same error otherwise.
   */
  async exportPuzzle(
    id: string,
    options?: { format?: "json" } & RequestOptions
  ): Promise<Puzzle>;
  async exportPuzzle(
    id: string,
    options: { format: "puz" } & RequestOptions
  ): Promise<PuzExportResult>;
  async exportPuzzle(
    id: string,
    options: { format: "html" } & RequestOptions
  ): Promise<HtmlExportResult>;
  async exportPuzzle(
    id: string,
    options: { format?: "json" | "puz" | "html" } & RequestOptions = {}
  ): Promise<Puzzle | PuzExportResult | HtmlExportResult> {
    const format = options.format ?? "json";
    const accept = { json: "application/json", puz: "application/x-crossword", html: "text/html" }[format];
    const response = await this.request(
      "GET",
      `/puzzles/${encodeURIComponent(id)}/export`,
      { query: { format }, accept, retryable: true, signal: options.signal }
    );
    if (format === "json") return this.json<Puzzle>(response);
    const filename = filenameFrom(response.headers, id, format);
    if (format === "html") return { data: await response.text(), filename };
    return { data: new Uint8Array(await response.arrayBuffer()), filename };
  }
}

/** Pull the filename out of `Content-Disposition`, falling back to the id. */
function filenameFrom(headers: Headers, id: string, ext: string): string {
  const disposition = headers.get("content-disposition") ?? "";
  const star = /filename\*=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  if (star) return decodeURIComponent(star[1]);
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain ? plain[1] : `${id}.${ext}`;
}
