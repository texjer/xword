export type CellType = "white" | "black";

export type Direction = "across" | "down";

export interface CellState {
  type: CellType;
  letter: string;
  number: number | null;
}

export interface Position {
  row: number;
  col: number;
}

export interface Slot {
  id: number;
  number: number;
  row: number;
  col: number;
  direction: Direction;
  length: number;
  cells: Position[];
}

export interface Clue {
  number: number;
  direction: Direction;
  text: string;
  answer: string;
}

export interface PuzzleData {
  size: number;
  cells: CellState[][];
  clues: {
    across: Record<number, string>;
    down: Record<number, string>;
  };
}
