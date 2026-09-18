/**
 * The parts of the constructor that need no server.
 *
 * Pattern generation, symmetry checking, slot extraction, clue numbering and
 * `.puz` encoding are all pure TypeScript in the web app, so they are imported
 * here by build alias instead of being reimplemented — generating a pattern
 * costs no quota and no round trip, and the pattern you get from the CLI is
 * byte-for-byte the pattern the web constructor would have drawn.
 *
 * Deliberately left out: `downloadPuz` from the same file (it reaches for
 * `document` and `URL.createObjectURL`) and `html5Export.ts` (it reads the
 * Zustand store). `exportPuz`, the half that actually encodes, is here.
 */
import { exportPuz as exportPuzBytes } from "@/lib/puzExport";
import { computeNumbers, extractSlots } from "@/lib/gridUtils";
import {
  ALPHABET_CONFIGS,
  minSlotLength,
  isPuzzleLanguage,
  type PuzzleLanguage,
} from "@/lib/alphabet";
import type { CellState, Slot } from "@/lib/types";
import { gridFromPublic, type PublicGrid } from "@/lib/api/grid";

export {
  generatePattern,
  generateAmericanPattern,
  generateBritishPattern,
  generateFreeformPattern,
  type PatternInfo,
  type PatternStyle,
} from "@/lib/patternGenerator";

export {
  getSymmetricPosition,
  isCenter,
  hasRotationalBlockSymmetry,
  getSymmetryMismatches,
} from "@/lib/symmetry";

export {
  createEmptyGrid,
  computeNumbers,
  extractSlots,
  getSlotAtCell,
  getSlotWord,
  looksFreeform,
  unfillableReason,
} from "@/lib/gridUtils";

export {
  ALPHABET_CONFIGS,
  AVAILABLE_PUZZLE_LANGUAGES,
  isPuzzleLanguage,
  isRtlLanguage,
  isCrissCrossOnlyLanguage,
  minSlotLength,
  normalizePuzzleText,
  normalizePuzzlePattern,
  getPuzzleUnits,
  type AlphabetConfig,
  type PuzzleLanguage,
} from "@/lib/alphabet";

export type { CellState, CellType, Direction, Position, Slot } from "@/lib/types";

export { exportPuz } from "@/lib/puzExport";

function asLanguage(language: string): PuzzleLanguage {
  return isPuzzleLanguage(language) ? language : "en";
}

/**
 * Clue numbers for a public grid, keyed `"row,col"`.
 *
 * The numbering rule is the printed one — a cell is numbered when it starts an
 * across entry or a down entry — so these are the numbers your `clues.across` /
 * `clues.down` maps must use.
 */
export function numberGrid(
  grid: PublicGrid,
  language: string = "en"
): Record<string, number> {
  const cells = computeNumbers(gridFromPublic(grid, asLanguage(language)));
  const numbers: Record<string, number> = {};
  cells.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (cell.number !== null) numbers[`${r},${c}`] = cell.number;
    })
  );
  return numbers;
}

/**
 * Every answer slot in a public grid, across then down.
 *
 * `minLength` defaults to the language's own floor — 3 for alphabetic
 * languages, 2 for the criss-cross CJK ones, whose words are commonly two
 * glyphs. Passing 3 for Japanese silently drops most of the grid.
 */
export function gridSlots(
  grid: PublicGrid,
  language: string = "en",
  minLength?: number
): Slot[] {
  const code = asLanguage(language);
  const cells = computeNumbers(gridFromPublic(grid, code));
  return extractSlots(cells, minLength ?? minSlotLength(code));
}

/** The answer sitting in each slot, keyed `"<number><A|D>"`. */
export function gridAnswers(
  grid: PublicGrid,
  language: string = "en"
): Record<string, string> {
  const code = asLanguage(language);
  const cells = computeNumbers(gridFromPublic(grid, code));
  const answers: Record<string, string> = {};
  for (const slot of extractSlots(cells, minSlotLength(code))) {
    const word = slot.cells
      .map(({ row, col }) => cells[row][col].letter || "_")
      .join("");
    answers[`${slot.number}${slot.direction === "across" ? "A" : "D"}`] = word;
  }
  return answers;
}

export interface PuzExportInput {
  title: string;
  author?: string;
  grid: PublicGrid;
  clues: {
    across: Record<string | number, string>;
    down: Record<string | number, string>;
  };
  language?: string;
}

/**
 * Encode a public grid as Across Lite `.puz` bytes, locally.
 *
 * The writer is single-byte ISO-8859-1, so only Latin-script languages survive;
 * this refuses rather than emitting a file whose every letter is `?`. The same
 * rule is why `GET /puzzles/{id}/export?format=puz` 400s for those languages.
 */
export function exportPuzFromGrid(input: PuzExportInput): Uint8Array {
  const code = asLanguage(input.language ?? "en");
  if (!ALPHABET_CONFIGS[code].puzExportable) {
    throw new Error(
      `${ALPHABET_CONFIGS[code].name} puzzles cannot be exported as .puz ` +
        "(the format is single-byte ISO-8859-1)"
    );
  }
  const cells: CellState[][] = computeNumbers(gridFromPublic(input.grid, code));
  const toNumberKeys = (map: Record<string | number, string>) => {
    const out: Record<number, string> = {};
    for (const [key, value] of Object.entries(map ?? {})) {
      const number = Number(key);
      if (Number.isInteger(number)) out[number] = value;
    }
    return out;
  };
  return exportPuzBytes({
    title: input.title,
    author: input.author ?? "",
    size: cells.length,
    cells,
    clues: {
      across: toNumberKeys(input.clues?.across ?? {}),
      down: toNumberKeys(input.clues?.down ?? {}),
    },
  });
}
