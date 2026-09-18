import { describe, expect, it } from "vitest";

import {
  cellsToGrid,
  computeNumbers,
  countBlackCells,
  extractSlots,
  generateAmericanPattern,
  generateBritishPattern,
  generateFreeformPattern,
  generatePattern,
  getSymmetryMismatches,
  gridFromPublic,
  gridSlots,
  hasRotationalBlockSymmetry,
  unfillableReason,
} from "../src/index.js";

/**
 * Pattern generation is random, so these assert invariants rather than a fixed
 * output: symmetry, a sane black-square budget, and — the one that actually
 * matters — that every entry is a length the word list can fill. Several runs
 * each, because a generator that is right nine times in ten is wrong.
 *
 * Sizes are 11-17 on purpose. `generateAmericanPattern` gives up outside
 * roughly 10-18 and returns an all-white grid instead of throwing; that is a
 * pre-existing limit of `frontend/src/lib/patternGenerator.ts`, not of this
 * package, and the test below pins the CLI's guard against it rather than
 * asserting the bug itself.
 */
const RELIABLE_SIZES = [11, 13, 15, 17];

describe("generateAmericanPattern", () => {
  for (const size of RELIABLE_SIZES) {
    it(`produces a symmetric, fillable-looking ${size}×${size}`, () => {
      for (let run = 0; run < 5; run++) {
        const info = generateAmericanPattern(size);
        expect(info.grid).toHaveLength(size);
        expect(info.grid.every((row) => row.length === size)).toBe(true);

        // 180° rotational symmetry is the defining property of the style.
        expect(hasRotationalBlockSymmetry(info.grid)).toBe(true);
        expect(getSymmetryMismatches(info.grid).size).toBe(0);

        const grid = cellsToGrid(info.grid, "en");
        const black = countBlackCells(grid);
        expect(black).toBeGreaterThan(0);
        expect(black / (size * size)).toBeLessThan(0.35);

        const numbered = computeNumbers(info.grid);
        const slots = extractSlots(numbered, 3);
        expect(slots.length).toBeGreaterThan(0);
        // The web app's own "can this be filled?" check must pass.
        expect(unfillableReason(slots, numbered)).toBeNull();
        // The generator breaks any run longer than 7 so the word list is deep
        // enough at every length; a longer entry means that loop gave up.
        expect(Math.max(...slots.map((s) => s.length))).toBeLessThanOrEqual(7);
        // Every white cell is checked — it belongs to both an across and a down
        // entry — which is what makes it an American grid.
        const covered = new Set<string>();
        for (const slot of slots) {
          for (const cell of slot.cells) covered.add(`${cell.row},${cell.col}`);
        }
        const whiteCells = size * size - black;
        expect(covered.size).toBe(whiteCells);
      }
    });
  }

  it("reports stats that match the grid it returned", () => {
    const info = generateAmericanPattern(15);
    expect(info.style).toBe("american");
    expect(info.name).toMatch(/^\S+ \S+$/);
    expect(info.wordCount).toBe(gridSlots(cellsToGrid(info.grid, "en"), "en").length);
    expect(info.blackPercent).toBe(
      Math.round((countBlackCells(cellsToGrid(info.grid, "en")) / (15 * 15)) * 100)
    );
  });
});

describe("open-grid fallback", () => {
  it("is detectable, which is what the CLI guards on", () => {
    // 9×9 is outside the American generator's reachable range today, so it
    // returns a blank grid. The CLI must not hand that to `fill`: a grid with
    // no black squares is one open rectangle, and the web app's own check says
    // so. If the generator is ever fixed this test still passes — it asserts
    // the implication, not the failure.
    const info = generateAmericanPattern(9);
    const grid = cellsToGrid(info.grid, "en");
    if (countBlackCells(grid) === 0) {
      const numbered = computeNumbers(info.grid);
      expect(unfillableReason(extractSlots(numbered, 3), numbered)).toContain(
        "no black squares"
      );
    } else {
      expect(hasRotationalBlockSymmetry(info.grid)).toBe(true);
    }
  });
});

describe("the other two styles", () => {
  it("british patterns are symmetric and use the post lattice", () => {
    const info = generateBritishPattern(15);
    expect(info.style).toBe("british");
    expect(hasRotationalBlockSymmetry(info.grid)).toBe(true);
    // (even, even) cells stay white: they are the guaranteed crossings.
    for (let r = 0; r < 15; r += 2) {
      for (let c = 0; c < 15; c += 2) {
        expect(info.grid[r][c].type).toBe("white");
      }
    }
  });

  it("freeform patterns are looser but still a valid grid", () => {
    // Freeform's asymmetric variant fails its own constraints about half the
    // time at 15×15 and returns an open grid, so this retries the way the CLI
    // does. Ten attempts makes a false failure a one-in-a-thousand event.
    let grid = cellsToGrid(generateFreeformPattern(15).grid, "en");
    for (let attempt = 0; attempt < 9 && countBlackCells(grid) === 0; attempt++) {
      grid = cellsToGrid(generateFreeformPattern(15).grid, "en");
    }
    expect(countBlackCells(grid)).toBeGreaterThan(0);
    expect(() => gridFromPublic(grid, "en")).not.toThrow();
  });
});

describe("generatePattern (the plain grid form)", () => {
  it("returns cells the codec accepts", () => {
    const cells = generatePattern(11);
    const grid = cellsToGrid(cells, "en");
    expect(grid).toHaveLength(11);
    // A generated pattern must survive the same validation a hand-written grid
    // does, or `xword pattern | xword fill -` would fail at the server.
    expect(() => gridFromPublic(grid, "en")).not.toThrow();
  });
});
