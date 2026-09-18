/**
 * `xword` — the TypeScript client for the Crossword Generator API,
 * plus the pieces of the constructor that run locally.
 *
 * ```ts
 * import { CrosswordClient, generatePattern, cellsToGrid } from "xword";
 *
 * const client = new CrosswordClient({ apiKey: process.env.CROSSWORD_API_KEY });
 * const grid = cellsToGrid(generatePattern(11));
 * const filled = await client.fillGrid({ grid, min_score: 40, language: "en" });
 * ```
 */
export {
  CrosswordClient,
  DEFAULT_BASE_URL,
  type CrosswordClientOptions,
  type RequestOptions,
  type ResponseMeta,
  type PuzExportResult,
  type HtmlExportResult,
  // Contract types
  type LanguageCode,
  type Language,
  type Status,
  type Grid,
  type LockedCells,
  type WordMatch,
  type Clue,
  type RoughEntry,
  type FillQuality,
  type FillRequest,
  type FillResult,
  type ImproveRequest,
  type ImproveResult,
  type FillEvent,
  type FillSessionEvent,
  type FillProgressEvent,
  type FillCompleteEvent,
  type FillErrorEvent,
  type Puzzle,
  type PuzzleInput,
  type PuzzlePatch,
  type ShowcaseStatus,
  type ClueMap,
  type SearchWordsParams,
  type LookupCluesParams,
  type ListPuzzlesParams,
  type ScoreWordsBody,
  type LookupCluesBulkBody,
  type GenerateCluesBody,
  type PublishPuzzleBody,
  type CancelFillBody,
  type GenerateCluesResult,
  type CancelFillResult,
  type ListPuzzlesResult,
} from "./client.js";

export {
  CrosswordApiError,
  readRateLimit,
  type Problem,
  type ProblemCode,
  type RateLimitInfo,
} from "./errors.js";

export { readSseFrames, type SseFrame } from "./sse.js";

export * from "./grid.js";
export * from "./local.js";

export type { components, operations, paths } from "./types.gen.js";
