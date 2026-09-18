/**
 * The one error type every client method throws.
 *
 * The API answers failures as RFC 9457 problem documents, and the contract is
 * explicit that `code` is the stable identity while `detail` is prose that may
 * change — so `code` is a first-class field here and `detail` is deliberately
 * only the message. Problems may also carry extra members (`limit`,
 * `remaining`, `maxGridSize`, `requiredScope`, `field`), which are kept in
 * `problem` rather than flattened: a new extra member should not need an SDK
 * release to be readable.
 */
import type { components } from "./types.gen.js";

export type Problem = components["schemas"]["Problem"];
export type ProblemCode = components["schemas"]["ProblemCode"];

/** Rate-limit and quota counters lifted off the response headers. */
export interface RateLimitInfo {
  /** `X-RateLimit-Limit` — requests allowed this minute for the key's tier. */
  limit?: number;
  /** `X-RateLimit-Remaining` — requests left this minute. */
  remaining?: number;
  /** `Retry-After`, in seconds. */
  retryAfter?: number;
  /** `X-Fill-Quota-Remaining`; `-1` means unlimited. */
  fillQuotaRemaining?: number;
  /** `X-Ai-Clues-Remaining`; `-1` means unlimited. */
  aiCluesRemaining?: number;
}

function intHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

/** Read every documented limit header off a response, present or not. */
export function readRateLimit(headers: Headers): RateLimitInfo {
  return {
    limit: intHeader(headers, "x-ratelimit-limit"),
    remaining: intHeader(headers, "x-ratelimit-remaining"),
    retryAfter: intHeader(headers, "retry-after"),
    fillQuotaRemaining: intHeader(headers, "x-fill-quota-remaining"),
    aiCluesRemaining: intHeader(headers, "x-ai-clues-remaining"),
  };
}

export class CrosswordApiError extends Error {
  readonly name = "CrosswordApiError";
  /** HTTP status. */
  readonly status: number;
  /**
   * The stable machine-readable failure identity. Branch on this. Typed as the
   * documented enum widened with `string`, because the contract says new codes
   * may appear and an unrecognized one should be treated as a generic failure
   * of its status class rather than crashing a `switch`.
   */
  readonly code: ProblemCode | (string & {});
  /** The whole parsed problem document, including any extra members. */
  readonly problem: Problem | null;
  /** Limit/quota counters from the response headers. */
  readonly rateLimit: RateLimitInfo;
  /** The raw body, when it was not parseable problem+json. */
  readonly body: string | null;

  constructor(init: {
    status: number;
    code?: string;
    message: string;
    problem?: Problem | null;
    rateLimit?: RateLimitInfo;
    body?: string | null;
  }) {
    super(init.message);
    this.status = init.status;
    this.code = init.code ?? "UNKNOWN";
    this.problem = init.problem ?? null;
    this.rateLimit = init.rateLimit ?? {};
    this.body = init.body ?? null;
  }

  /** An extra member of the problem document (`limit`, `maxGridSize`, …). */
  extra<T = unknown>(key: string): T | undefined {
    return this.problem ? (this.problem as Record<string, unknown>)[key] as T : undefined;
  }

  /** True for the three 429 codes plus anything else the server rate-limits. */
  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /**
   * Build one from a failed response. Anything that is not parseable JSON —
   * an HTML error page from a proxy, an empty 502 — still produces a usable
   * error rather than a `SyntaxError` from the parse.
   */
  static async fromResponse(response: Response): Promise<CrosswordApiError> {
    const rateLimit = readRateLimit(response.headers);
    let body: string | null = null;
    try {
      body = await response.text();
    } catch {
      /* body already consumed or the connection dropped */
    }

    let problem: Problem | null = null;
    if (body) {
      try {
        const parsed: unknown = JSON.parse(body);
        if (parsed && typeof parsed === "object") problem = parsed as Problem;
      } catch {
        /* not JSON */
      }
    }

    const code = typeof problem?.code === "string" ? problem.code : undefined;
    const detail =
      (typeof problem?.detail === "string" && problem.detail) ||
      (typeof problem?.title === "string" && problem.title) ||
      (body ? body.slice(0, 200) : response.statusText) ||
      `HTTP ${response.status}`;

    return new CrosswordApiError({
      status: response.status,
      code,
      message: code ? `${code}: ${detail}` : detail,
      problem,
      rateLimit,
      body,
    });
  }
}
