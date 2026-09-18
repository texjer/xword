import { CellState, Position } from "./types";

export function getSymmetricPosition(
  row: number,
  col: number,
  size: number
): Position {
  return {
    row: size - 1 - row,
    col: size - 1 - col,
  };
}

export function isCenter(row: number, col: number, size: number): boolean {
  const center = Math.floor(size / 2);
  return row === center && col === center;
}

/** Whether the black-square pattern has standard 180° crossword symmetry. */
export function hasRotationalBlockSymmetry(cells: CellState[][]): boolean {
  const rowCount = cells.length;
  if (rowCount === 0) return true;

  const colCount = cells[0].length;
  if (cells.some((row) => row.length !== colCount)) return false;

  return cells.every((row, rowIndex) =>
    row.every(
      (cell, colIndex) =>
        cell.type === cells[rowCount - 1 - rowIndex][colCount - 1 - colIndex].type
    )
  );
}

/**
 * Every cell whose 180° partner is a different colour, as "row,col" keys.
 *
 * Both halves of a broken pair are returned, not just one: the fix is either
 * to blacken one or clear the other, and you can't choose without seeing the
 * two squares together. A ragged grid (rows of unequal length) has no partner
 * to compare against, so it reports nothing rather than guessing.
 */
export function getSymmetryMismatches(cells: CellState[][]): Set<string> {
  const mismatches = new Set<string>();
  const rowCount = cells.length;
  if (rowCount === 0) return mismatches;

  const colCount = cells[0].length;
  if (cells.some((row) => row.length !== colCount)) return mismatches;

  for (let row = 0; row < rowCount; row++) {
    for (let col = 0; col < colCount; col++) {
      const partner = cells[rowCount - 1 - row][colCount - 1 - col];
      if (cells[row][col].type !== partner.type) mismatches.add(`${row},${col}`);
    }
  }
  return mismatches;
}
