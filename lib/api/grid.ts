/**
 * Codec between the public API's grid encoding and the internal one.
 *
 * Public (`Grid`, see `docs/api/openapi.yaml`): an array of row strings, one
 * character per cell — `.` empty white, `#` black, anything else a fixed letter.
 *
 * Internal (`CellState[][]` from `@/lib/types`): `{ type, letter, number }` per
 * cell. The backend's Pydantic `CellData` is structurally the same object, and
 * `PuzzleRow.grid_data` is this array verbatim (the designs POST handler stores
 * `body.cells` unchanged), so one internal representation covers all three.
 *
 * Two things this file exists to get right:
 *
 * 1. **A cell is not a character.** In Devanagari one cell is a whole akshara —
 *    a base consonant plus its combining matra — so `row[i]` is meaningless and
 *    `row.length` is not the grid size. Everything here segments with
 *    `getPuzzleUnits`, which uses `Intl.Segmenter` for grapheme-cluster
 *    languages and codepoints (`Array.from`) elsewhere. Never index a row.
 * 2. **Letters are normalized per language.** Uppercasing, accent folding,
 *    Hebrew final forms → medial, hiragana → katakana. `normalizePuzzleText`
 *    is the same function the constructor types through, so a grid that
 *    round-trips here matches what the web app would have stored.
 */
import {
  ALPHABET_CONFIGS,
  getPuzzleUnits,
  isPuzzleLanguage,
  normalizePuzzleText,
  type PuzzleLanguage,
} from "@/lib/alphabet";
import { computeNumbers } from "@/lib/gridUtils";
import type { CellState } from "@/lib/types";

/** The public encoding: rows of text, top row first. */
export type PublicGrid = string[];

/** `"row,col"` keys, zero-based, row first. Matches the solver's `locked` list. */
export type LockedCells = string[];

export const EMPTY_CELL = ".";
export const BLACK_CELL = "#";

export const MIN_GRID_SIZE = 3;
export const MAX_GRID_SIZE = 23;

/**
 * Thrown by every function here on bad input. Carries the `field` and any
 * coordinates so a route handler can hand it straight to
 * `problem(400, "VALIDATION_ERROR", err.message, err.extra)`.
 */
export class GridValidationError extends Error {
  readonly code = "VALIDATION_ERROR" as const;
  readonly extra: Record<string, unknown>;

  constructor(message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "GridValidationError";
    this.extra = { field: "grid", ...extra };
  }
}

function assertLanguage(language: string): PuzzleLanguage {
  if (!isPuzzleLanguage(language)) {
    throw new GridValidationError(`Unsupported puzzle language: ${language}`, {
      field: "language",
    });
  }
  return language;
}

/**
 * The single normalized unit `raw` represents, or `null` if it is not one
 * letter of this language's alphabet.
 *
 * Folding can change the unit count in both directions — German `ß` → `SS` is
 * two cells and must be rejected as a cell letter; a Devanagari akshara is
 * several codepoints but one cell — so the check is on units after folding, not
 * on the input's length.
 */
function normalizeCellLetter(
  raw: string,
  language: PuzzleLanguage
): string | null {
  const normalized = normalizePuzzleText(raw, language);
  if (!normalized) return null;
  const units = getPuzzleUnits(normalized, language);
  return units.length === 1 ? normalized : null;
}

// ---------------------------------------------------------------------------
// Public → internal
// ---------------------------------------------------------------------------

export interface GridFromPublicOptions {
  /**
   * Recompute clue numbers from the black-square pattern. On by default: a
   * public grid carries no numbers, and every consumer (solver, storage,
   * renderer) wants them. Turn it off only when you are about to renumber
   * anyway.
   */
  withNumbers?: boolean;
}

/**
 * Decode a public `Grid` into `CellState[][]`.
 *
 * Validates squareness, the 3–23 size band, and every glyph. An unknown glyph
 * is a `GridValidationError`, not a silently dropped cell: a grid that quietly
 * lost a theme letter would fill wrong and the caller would never know.
 */
export function gridFromPublic(
  grid: unknown,
  language: string = "en",
  options: GridFromPublicOptions = {}
): CellState[][] {
  const code = assertLanguage(language);

  if (!Array.isArray(grid)) {
    throw new GridValidationError("Grid must be an array of row strings");
  }
  const size = grid.length;
  if (size < MIN_GRID_SIZE || size > MAX_GRID_SIZE) {
    throw new GridValidationError(
      `Grid must be between ${MIN_GRID_SIZE} and ${MAX_GRID_SIZE} rows, got ${size}`,
      { size }
    );
  }

  const cells: CellState[][] = grid.map((row, r) => {
    if (typeof row !== "string") {
      throw new GridValidationError(`Row ${r} must be a string`, { row: r });
    }
    const units = getPuzzleUnits(row, code);
    if (units.length !== size) {
      throw new GridValidationError(
        `Grid must be square: row ${r} has ${units.length} cells, expected ${size}`,
        { row: r, expected: size, actual: units.length }
      );
    }
    return units.map((unit, c) => {
      if (unit === BLACK_CELL) {
        return { type: "black" as const, letter: "", number: null };
      }
      if (unit === EMPTY_CELL) {
        return { type: "white" as const, letter: "", number: null };
      }
      const letter = normalizeCellLetter(unit, code);
      if (letter === null) {
        throw new GridValidationError(
          `Row ${r}, column ${c}: ${JSON.stringify(unit)} is not a letter of the ` +
            `${ALPHABET_CONFIGS[code].name} alphabet (use "." for empty, "#" for black)`,
          { row: r, col: c, glyph: unit, language: code }
        );
      }
      return { type: "white" as const, letter, number: null };
    });
  });

  return options.withNumbers === false ? cells : computeNumbers(cells);
}

// ---------------------------------------------------------------------------
// Internal → public
// ---------------------------------------------------------------------------

/**
 * The shape every internal grid shares. Deliberately loose on `type` so the
 * backend's `CellData`, the store's `CellState`, and an unvalidated
 * `PuzzleRow.grid_data` all satisfy it.
 */
interface CellLike {
  type?: unknown;
  letter?: unknown;
  number?: unknown;
}

/** Encode `CellState[][]` (or backend `CellData[][]`) as a public `Grid`. */
export function gridToPublicFromCells(
  cells: readonly (readonly CellLike[])[],
  language: string = "en"
): PublicGrid {
  const code = assertLanguage(language);
  const size = cells.length;
  if (size < MIN_GRID_SIZE || size > MAX_GRID_SIZE) {
    throw new GridValidationError(
      `Grid must be between ${MIN_GRID_SIZE} and ${MAX_GRID_SIZE} rows, got ${size}`,
      { size }
    );
  }

  return cells.map((row, r) => {
    if (!Array.isArray(row) || row.length !== size) {
      throw new GridValidationError(
        `Grid must be square: row ${r} has ${Array.isArray(row) ? row.length : 0} cells, expected ${size}`,
        { row: r, expected: size }
      );
    }
    return row
      .map((cell, c) => {
        if (cell?.type === "black") return BLACK_CELL;
        if (cell?.type !== "white") {
          throw new GridValidationError(
            `Row ${r}, column ${c}: cell type must be "white" or "black"`,
            { row: r, col: c }
          );
        }
        const raw = typeof cell.letter === "string" ? cell.letter : "";
        if (!raw) return EMPTY_CELL;
        const letter = normalizeCellLetter(raw, code);
        if (letter === null) {
          throw new GridValidationError(
            `Row ${r}, column ${c}: stored letter ${JSON.stringify(raw)} is not a ` +
              `letter of the ${ALPHABET_CONFIGS[code].name} alphabet`,
            { row: r, col: c, glyph: raw, language: code }
          );
        }
        return letter;
      })
      .join("");
  });
}

/**
 * Encode a stored `PuzzleRow.grid_data` as a public `Grid`.
 *
 * `grid_data` is typed `unknown` in `puzzlesDb.ts` because it is a Supabase
 * `jsonb` column written straight from `body.cells` — nothing has ever
 * validated it on the way out. Rows saved by every shipped version of the app
 * are `CellState[][]`, so that is what this expects; anything else raises a
 * `VALIDATION_ERROR` rather than producing a grid of `undefined`.
 */
export function gridToPublic(
  gridData: unknown,
  language: string = "en"
): PublicGrid {
  if (!Array.isArray(gridData)) {
    throw new GridValidationError("Stored grid_data is not a grid", {
      field: "grid_data",
    });
  }
  return gridToPublicFromCells(gridData as CellLike[][], language);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Size of a public grid without decoding it. Also the cheapest pre-flight for
 * the membership grid-size gate, which must answer before any solver work.
 */
export function publicGridSize(grid: unknown): number {
  if (!Array.isArray(grid)) {
    throw new GridValidationError("Grid must be an array of row strings");
  }
  return grid.length;
}

/**
 * Apply the solver's `{"r,c": letter}` fill map to a public grid, returning a
 * new one. This is how a `fill`/`improve` response becomes a `Grid`: the
 * backend answers in cell coordinates, the contract answers in rows.
 *
 * Coordinates outside the grid, and writes onto a black square, are ignored —
 * the solver never emits either, and throwing would turn a good fill into a
 * failed request.
 */
export function applyFillToPublicGrid(
  grid: PublicGrid,
  fill: Record<string, string>,
  language: string = "en"
): PublicGrid {
  const code = assertLanguage(language);
  const cells = gridFromPublic(grid, code, { withNumbers: false });
  for (const [key, rawLetter] of Object.entries(fill)) {
    const [rowText, colText] = key.split(",");
    const r = Number(rowText);
    const c = Number(colText);
    if (!Number.isInteger(r) || !Number.isInteger(c)) continue;
    if (!cells[r]?.[c] || cells[r][c].type === "black") continue;
    const letter = normalizeCellLetter(rawLetter, code);
    if (letter === null) continue;
    cells[r][c] = { ...cells[r][c], letter };
  }
  return gridToPublicFromCells(cells, code);
}

/**
 * Validate a `locked` list against a grid of `size`, returning it normalized.
 *
 * Unlike the fill map this is strict: a locked cell the caller got wrong means
 * the theme entry they meant to protect is not protected, and a solver that
 * quietly overwrites a theme word is worse than a 400.
 */
export function parseLockedCells(locked: unknown, size: number): LockedCells {
  if (locked === undefined || locked === null) return [];
  if (!Array.isArray(locked)) {
    throw new GridValidationError("`locked` must be an array of \"row,col\" strings", {
      field: "locked",
    });
  }
  const seen = new Set<string>();
  for (const entry of locked) {
    if (typeof entry !== "string" || !/^\d{1,2},\d{1,2}$/.test(entry)) {
      throw new GridValidationError(
        `Invalid locked cell ${JSON.stringify(entry)}; expected "row,col"`,
        { field: "locked", entry }
      );
    }
    const [r, c] = entry.split(",").map(Number);
    if (r >= size || c >= size) {
      throw new GridValidationError(
        `Locked cell ${entry} is outside a ${size}×${size} grid`,
        { field: "locked", entry, size }
      );
    }
    seen.add(`${r},${c}`);
  }
  return [...seen];
}
