import { describe, expect, it } from "vitest";

import {
  GridValidationError,
  applyFillToPublicGrid,
  cellsToGrid,
  countBlackCells,
  emptyGrid,
  formatGridText,
  gridFromPublic,
  gridSize,
  gridUnits,
  numberGrid,
  gridAnswers,
  gridSlots,
  parseGridText,
  parseLockedCells,
  exportPuzFromGrid,
} from "../src/index.js";

const SMALL = ["..#..", ".....", "..A..", ".....", "..#.."];

describe("grid codec round-trips", () => {
  it("decodes and re-encodes an English grid unchanged", () => {
    expect(cellsToGrid(gridFromPublic(SMALL, "en"), "en")).toEqual(SMALL);
  });

  it("round-trips a Cyrillic grid", () => {
    const grid = ["ЛУНА.", ".#...", ".....", "...#.", "....."];
    expect(cellsToGrid(gridFromPublic(grid, "ru"), "ru")).toEqual(grid);
  });

  it("round-trips a Hebrew grid, which stays logical/LTR", () => {
    const grid = ["...#.", ".....", ".#ש..", ".....", ".#..."];
    expect(cellsToGrid(gridFromPublic(grid, "he"), "he")).toEqual(grid);
  });

  it("counts Devanagari cells as aksharas, not codepoints", () => {
    // का is two codepoints but one cell; a naive .length check would call this
    // row six cells wide and reject a perfectly good grid.
    const row = "का....";
    expect(gridUnits(row, "hi")).toHaveLength(5);
    expect(row.length).toBe(6);

    const grid = [row, ".....", ".....", ".....", "....."];
    expect(cellsToGrid(gridFromPublic(grid, "hi"), "hi")).toEqual(grid);
  });

  it("normalizes letters the way the server stores them", () => {
    // French folds accents; a grid that came back unaccented is not a bug.
    const decoded = gridFromPublic(["É..", "...", "..."], "fr");
    expect(decoded[0][0].letter).toBe("E");
  });

  it("uppercases a lowercase letter", () => {
    expect(cellsToGrid(gridFromPublic(["a..", "...", "..."], "en"), "en")).toEqual([
      "A..",
      "...",
      "...",
    ]);
  });
});

describe("grid validation", () => {
  it("rejects a ragged grid and names the row", () => {
    expect(() => gridFromPublic(["...", "....", "..."], "en")).toThrow(GridValidationError);
    try {
      gridFromPublic(["...", "....", "..."], "en");
    } catch (error) {
      expect((error as GridValidationError).message).toContain("row 1");
      expect((error as GridValidationError).extra.field).toBe("grid");
    }
  });

  it("rejects a grid outside the 3-23 band", () => {
    expect(() => gridFromPublic(["..", ".."], "en")).toThrow(GridValidationError);
    expect(() => gridFromPublic(Array(24).fill("."
      .repeat(24)), "en")).toThrow(GridValidationError);
  });

  it("rejects a glyph that is not a letter of the alphabet", () => {
    expect(() => gridFromPublic(["Ж..", "...", "..."], "en")).toThrow(GridValidationError);
  });

  it("validates locked cells strictly", () => {
    expect(parseLockedCells(["0,0", "0,1", "0,0"], 5)).toEqual(["0,0", "0,1"]);
    expect(() => parseLockedCells(["0,9"], 5)).toThrow(GridValidationError);
    expect(() => parseLockedCells(["nope"], 5)).toThrow(GridValidationError);
    expect(parseLockedCells(undefined, 5)).toEqual([]);
  });
});

describe("grid files", () => {
  it("parses and formats a grid file", () => {
    const text = formatGridText(SMALL);
    expect(parseGridText(text)).toEqual(SMALL);
  });

  it("drops blank lines, comments and trailing whitespace", () => {
    const text = "// a pattern\n..#..  \n.....\n..A..\n.....\n..#..\n\n";
    expect(parseGridText(text)).toEqual(SMALL);
  });

  it("rejects a ragged file with the offending row", () => {
    expect(() => parseGridText("...\n....\n...\n")).toThrow(/row 1/);
  });

  it("emptyGrid and gridSize agree", () => {
    const grid = emptyGrid(9);
    expect(gridSize(grid)).toBe(9);
    expect(grid.every((row) => row.length === 9)).toBe(true);
    expect(countBlackCells(grid)).toBe(0);
  });
});

describe("applying a solver fill map", () => {
  it("writes letters at row,col coordinates", () => {
    const filled = applyFillToPublicGrid(SMALL, { "0,0": "S", "0,1": "P" }, "en");
    expect(filled[0]).toBe("SP#..");
  });

  it("ignores writes onto a black square or off the grid", () => {
    const filled = applyFillToPublicGrid(SMALL, { "0,2": "X", "9,9": "Y" }, "en");
    expect(filled).toEqual(SMALL);
  });
});

describe("local derivations", () => {
  const grid = ["CAT", "ARE", "TEN"];

  it("numbers cells the way the printed puzzle does", () => {
    expect(numberGrid(grid, "en")).toEqual({ "0,0": 1, "0,1": 2, "0,2": 3, "1,0": 4, "2,0": 5 });
  });

  it("extracts across and down slots", () => {
    const slots = gridSlots(grid, "en");
    expect(slots.filter((s) => s.direction === "across")).toHaveLength(3);
    expect(slots.filter((s) => s.direction === "down")).toHaveLength(3);
  });

  it("reads the answer out of each slot", () => {
    expect(gridAnswers(grid, "en")).toEqual({
      "1A": "CAT",
      "4A": "ARE",
      "5A": "TEN",
      "1D": "CAT",
      "2D": "ARE",
      "3D": "TEN",
    });
  });
});

describe("local .puz export", () => {
  it("writes an Across Lite header", () => {
    const bytes = exportPuzFromGrid({
      title: "Tiny",
      author: "Tex",
      grid: ["CAT", "ARE", "TEN"],
      clues: { across: { 1: "Feline", 4: "Exist" }, down: { 1: "Feline" } },
      language: "en",
    });
    // Bytes 2-12 of a .puz are the literal string ACROSS&DOWN.
    expect(Buffer.from(bytes.subarray(2, 13)).toString("latin1")).toBe("ACROSS&DOWN");
    expect(bytes[0x2c]).toBe(3);
    expect(bytes[0x2d]).toBe(3);
  });

  it("refuses a language the format cannot encode", () => {
    expect(() =>
      exportPuzFromGrid({
        title: "Луна",
        grid: ["ЛУН", "УНА", "НАЛ"],
        clues: { across: {}, down: {} },
        language: "ru",
      })
    ).toThrow(/ISO-8859-1/);
  });
});
