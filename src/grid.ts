/**
 * The grid codec, re-exported from the web app's own copy.
 *
 * `frontend/src/lib/api/grid.ts` is the single implementation: the Next route
 * handlers encode responses with it and this package decodes them with the same
 * code, so "what the server means by a grid" cannot drift from "what the SDK
 * means by a grid". Nothing here is a copy — the file is pulled in through the
 * `@/lib/*` build alias (see `tsup.config.ts`).
 *
 * The edge case worth knowing before you write a loop over a row: **a cell is
 * not a character**. In Devanagari one cell is a whole akshara, several
 * codepoints; in every language the row may be longer than `size` in JavaScript
 * `.length` terms. Use `gridUnits` / `gridSize` rather than indexing.
 */
export {
  gridFromPublic,
  gridToPublic,
  gridToPublicFromCells,
  applyFillToPublicGrid,
  parseLockedCells,
  publicGridSize,
  GridValidationError,
  EMPTY_CELL,
  BLACK_CELL,
  MIN_GRID_SIZE,
  MAX_GRID_SIZE,
  type PublicGrid,
  type LockedCells as LockedCellList,
  type GridFromPublicOptions,
} from "@/lib/api/grid";

import {
  BLACK_CELL,
  EMPTY_CELL,
  GridValidationError,
  gridToPublicFromCells,
  type PublicGrid,
} from "@/lib/api/grid";
import { getPuzzleUnits, isPuzzleLanguage, type PuzzleLanguage } from "@/lib/alphabet";
import type { CellState } from "@/lib/types";

/** Cells of one row, segmented the way the language counts them. */
export function gridUnits(row: string, language: string = "en"): string[] {
  const code: PuzzleLanguage = isPuzzleLanguage(language) ? language : "en";
  return getPuzzleUnits(row, code);
}

/** Side length of a grid, in cells. */
export function gridSize(grid: PublicGrid): number {
  return grid.length;
}

/**
 * Read a grid file: one row per line, `.` empty, `#` black, anything else a
 * letter. Blank lines and `#!`-style comment lines are dropped, and trailing
 * whitespace is trimmed, so a file you edited by hand still parses.
 *
 * A bare `#` line would be ambiguous with a comment, so comments must start
 * with `//` — the grid alphabet has no use for a slash.
 */
export function parseGridText(text: string, language: string = "en"): PublicGrid {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0 && !line.startsWith("//"));

  if (rows.length === 0) {
    throw new GridValidationError("Grid file is empty");
  }
  const size = rows.length;
  rows.forEach((row, index) => {
    const units = gridUnits(row, language);
    if (units.length !== size) {
      throw new GridValidationError(
        `Grid must be square: row ${index} has ${units.length} cells, expected ${size}`,
        { row: index, expected: size, actual: units.length }
      );
    }
  });
  return rows;
}

/** Render a grid back to the text-file form `parseGridText` reads. */
export function formatGridText(grid: PublicGrid): string {
  return `${grid.join("\n")}\n`;
}

/**
 * Build an all-white grid of `size` cells a side — the starting point for a
 * hand-drawn pattern.
 */
export function emptyGrid(size: number): PublicGrid {
  return Array.from({ length: size }, () => EMPTY_CELL.repeat(size));
}

/** `CellState[][]` (what the local libs work in) → the public row encoding. */
export function cellsToGrid(
  cells: readonly (readonly CellState[])[],
  language: string = "en"
): PublicGrid {
  return gridToPublicFromCells(cells, language);
}

/** How many cells in a grid are black. Useful for sanity-checking a pattern. */
export function countBlackCells(grid: PublicGrid, language: string = "en"): number {
  let black = 0;
  for (const row of grid) {
    for (const unit of gridUnits(row, language)) {
      if (unit === BLACK_CELL) black += 1;
    }
  }
  return black;
}
