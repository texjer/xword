import { CellState, CellType, Direction, Position, Slot } from "./types";

/**
 * Criss-cross (freeform) grids are words floating on an empty field, so well
 * over half their cells are "black" fillers meant to read as blank paper,
 * not ink. Saved puzzles don't store their style, so renderers infer it from
 * that black-cell dominance (real crosswords stay under ~35% black).
 */
export function looksFreeform(cells: { type: string }[][]): boolean {
  let black = 0;
  let total = 0;
  for (const row of cells) {
    for (const cell of row) {
      total += 1;
      if (cell.type === "black") black += 1;
    }
  }
  return total > 0 && black / total > 0.55;
}

export function createEmptyGrid(size: number): CellState[][] {
  return Array.from({ length: size }, () =>
    Array.from({ length: size }, () => ({
      type: "white" as CellType,
      letter: "",
      number: null,
    }))
  );
}

export function getSymmetricPos(
  row: number,
  col: number,
  size: number
): Position {
  return { row: size - 1 - row, col: size - 1 - col };
}

export function computeNumbers(cells: CellState[][]): CellState[][] {
  const size = cells.length;
  let num = 1;
  const updated = cells.map((row) => row.map((cell) => ({ ...cell, number: null as number | null })));

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (updated[r][c].type === "black") continue;

      const startsAcross =
        (c === 0 || updated[r][c - 1].type === "black") &&
        c + 1 < size &&
        updated[r][c + 1]?.type === "white";

      const startsDown =
        (r === 0 || updated[r - 1][c].type === "black") &&
        r + 1 < size &&
        updated[r + 1]?.[c]?.type === "white";

      if (startsAcross || startsDown) {
        updated[r][c].number = num++;
      }
    }
  }
  return updated;
}

export function extractSlots(cells: CellState[][], minLength = 3): Slot[] {
  const size = cells.length;
  const slots: Slot[] = [];
  let slotId = 0;

  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (cells[r][c].type === "white") {
        const start = c;
        const slotCells: Position[] = [];
        while (c < size && cells[r][c].type === "white") {
          slotCells.push({ row: r, col: c });
          c++;
        }
        if (slotCells.length >= minLength) {
          const number = cells[r][start].number;
          if (number !== null) {
            slots.push({
              id: slotId++,
              number,
              row: r,
              col: start,
              direction: "across",
              length: slotCells.length,
              cells: slotCells,
            });
          }
        }
      } else {
        c++;
      }
    }
  }

  for (let c = 0; c < size; c++) {
    let r = 0;
    while (r < size) {
      if (cells[r][c].type === "white") {
        const start = r;
        const slotCells: Position[] = [];
        while (r < size && cells[r][c].type === "white") {
          slotCells.push({ row: r, col: c });
          r++;
        }
        if (slotCells.length >= minLength) {
          const number = cells[start][c].number;
          if (number !== null) {
            slots.push({
              id: slotId++,
              number,
              row: start,
              col: c,
              direction: "down",
              length: slotCells.length,
              cells: slotCells,
            });
          }
        }
      } else {
        r++;
      }
    }
  }

  return slots;
}

export function getSlotAtCell(
  slots: Slot[],
  row: number,
  col: number,
  direction: Direction
): Slot | null {
  return (
    slots.find(
      (s) =>
        s.direction === direction &&
        s.cells.some((c) => c.row === row && c.col === col)
    ) ?? null
  );
}

export function getSlotWord(slot: Slot, cells: CellState[][]): string {
  return slot.cells.map((c) => cells[c.row][c.col].letter || "_").join("");
}

// The pattern generator breaks up any run longer than 7 (MAX_WORD_LENGTH in
// patternGenerator.ts) because grids of long interlocking slots can't be
// filled from the word list. But hand-built grids legitimately carry long
// theme entries, and slots already filled in are constraints, not work. So
// refuse only when the slots still needing fill are DOMINATED by very long
// words: at least 12 slots of 12+ letters making up at least 70% of the
// unfilled slots (the word list is deep at 10-11 letters, so themed grids
// with several long entries deserve a real attempt — the solver's stall
// backstop catches the stragglers). An all-white 13x13 is 26 of 26; a themed
// grid with a few long answers is nowhere close. Mirrors the check in the
// backend's csp.py.
export function unfillableReason(slots: Slot[], cells: CellState[][]): string | null {
  const unfilled = slots.filter((s) =>
    s.cells.some((c) => !cells[c.row][c.col].letter)
  );
  if (unfilled.length === 0) return null;

  // A grid with no black squares at all isn't a crossword — it's one giant
  // open rectangle, so every row/column becomes a full-length slot with no
  // real word to fill. The long-word-dominance check below only catches this
  // at 13x13+ (2N-1 slots of length N all clear the 12-letter threshold at
  // N>=12); smaller sizes need this explicit, size-agnostic check instead.
  const hasBlocks = cells.some((row) => row.some((c) => c.type === "black"));
  if (!hasBlocks) {
    return "This grid has no black squares yet. Add some blocks (or generate a pattern) before auto-filling.";
  }

  const longCount = unfilled.filter((s) => s.length >= 12).length;
  if (longCount >= 12 && longCount >= unfilled.length * 0.7) {
    return "This grid is mostly long interlocking words, and auto-fill can't complete grids like this";
  }
  return null;
}
