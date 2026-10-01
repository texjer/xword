import { CellState } from "./types";

export type PatternStyle = "american" | "british" | "freeform";

export interface PatternInfo {
  grid: CellState[][];
  style: PatternStyle;
  difficulty: number;
  wordCount: number;
  blackPercent: number;
  name: string;
  /** Every attempt failed and `grid` is a blank (all-white) stand-in. Callers
   *  must not use it as a pattern. */
  failed?: boolean;
}

const MIN_WORD_LENGTH = 3;
const MAX_WORD_LENGTH = 7;

// Longest entry the American/freeform generators allow. 7 keeps 15×15 grids
// fillable from the word list; bigger grids get a little more reach, or the
// 3–7 rule can't be met at all and every attempt fails (it did at 21×21+).
function maxWordLength(size: number): number {
  return size <= 15 ? MAX_WORD_LENGTH : MAX_WORD_LENGTH + LARGE_GRID_EXTRA;
}
const LARGE_GRID_EXTRA = 1;

// Attempts that must fail with clean cuts before breakLongRuns may black out stubs.
const STUB_CUTS_AFTER = 10;
const MAX_STUB_BLACKS = 6;

// --- Pattern naming ---

const ADJECTIVES = [
  "Swift", "Twisted", "Hidden", "Cryptic", "Spiral", "Winding", "Linked",
  "Tangled", "Clever", "Quick", "Crossed", "Stacked", "Nested", "Braided",
  "Knotted", "Woven", "Laced", "Threaded", "Looped", "Bold", "Sleek",
  "Angled", "Zigzag", "Jagged", "Smooth", "Crisp", "Dense", "Open",
  "Tight", "Broad", "Sharp", "Clean", "Dark", "Bright", "Grand",
];

const NOUNS = [
  "Setter", "Grid", "Puzzle", "Cipher", "Matrix", "Lattice", "Mosaic",
  "Weave", "Pattern", "Frame", "Theme", "Cross", "Square", "Block",
  "Entry", "Stack", "Corner", "Arch", "Bridge", "Tower", "Gate",
  "Path", "Maze", "Web", "Knot", "Loop", "Spiral", "Diamond",
  "Arrow", "Crown", "Shield", "Star", "Ring", "Crest", "Nexus",
];

const usedNames = new Set<string>();

function generateName(): string {
  for (let i = 0; i < 100; i++) {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    const name = `${adj} ${noun}`;
    if (!usedNames.has(name)) {
      usedNames.add(name);
      return name;
    }
  }
  const id = Math.floor(Math.random() * 9000) + 1000;
  return `Pattern #${id}`;
}

// --- Shared utilities ---

function createGrid(size: number): CellState[][] {
  return Array.from({ length: size }, () =>
    Array.from({ length: size }, () => ({ type: "white" as const, letter: "", number: null }))
  );
}

function isConnected(grid: CellState[][], size: number): boolean {
  const visited = Array.from({ length: size }, () => new Array(size).fill(false));
  let startR = -1, startC = -1;

  for (let r = 0; r < size && startR === -1; r++) {
    for (let c = 0; c < size; c++) {
      if (grid[r][c].type === "white") {
        startR = r;
        startC = c;
        break;
      }
    }
  }
  if (startR === -1) return false;

  const stack: [number, number][] = [[startR, startC]];
  visited[startR][startC] = true;
  let count = 1;

  while (stack.length > 0) {
    const [r, c] = stack.pop()!;
    for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < size && nc >= 0 && nc < size && !visited[nr][nc] && grid[nr][nc].type === "white") {
        visited[nr][nc] = true;
        count++;
        stack.push([nr, nc]);
      }
    }
  }

  let totalWhite = 0;
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++)
      if (grid[r][c].type === "white") totalWhite++;

  return count === totalWhite;
}

function checkMinWordLength(grid: CellState[][], size: number, min = MIN_WORD_LENGTH): boolean {
  for (let r = 0; r < size; r++) {
    let run = 0;
    for (let c = 0; c <= size; c++) {
      if (c < size && grid[r][c].type === "white") {
        run++;
      } else {
        if (run > 0 && run < min) return false;
        run = 0;
      }
    }
  }
  for (let c = 0; c < size; c++) {
    let run = 0;
    for (let r = 0; r <= size; r++) {
      if (r < size && grid[r][c].type === "white") {
        run++;
      } else {
        if (run > 0 && run < min) return false;
        run = 0;
      }
    }
  }
  return true;
}

function findLongestRun(grid: CellState[][], size: number, max = MAX_WORD_LENGTH): { length: number; cells: [number, number][] } | null {
  let best: { length: number; cells: [number, number][] } | null = null;

  for (let r = 0; r < size; r++) {
    let runCells: [number, number][] = [];
    for (let c = 0; c <= size; c++) {
      if (c < size && grid[r][c].type === "white") {
        runCells.push([r, c]);
      } else {
        if (runCells.length > max && (!best || runCells.length > best.length)) {
          best = { length: runCells.length, cells: [...runCells] };
        }
        runCells = [];
      }
    }
  }

  for (let c = 0; c < size; c++) {
    let runCells: [number, number][] = [];
    for (let r = 0; r <= size; r++) {
      if (r < size && grid[r][c].type === "white") {
        runCells.push([r, c]);
      } else {
        if (runCells.length > max && (!best || runCells.length > best.length)) {
          best = { length: runCells.length, cells: [...runCells] };
        }
        runCells = [];
      }
    }
  }

  return best;
}

// Every run longer than `max`, longest first.
function findLongRuns(grid: CellState[][], size: number, max: number): [number, number][][] {
  const runs: [number, number][][] = [];
  for (const across of [true, false]) {
    for (let a = 0; a < size; a++) {
      let run: [number, number][] = [];
      for (let b = 0; b <= size; b++) {
        const [r, c] = across ? [a, b] : [b, a];
        if (b < size && grid[r][c].type === "white") {
          run.push([r, c]);
        } else {
          if (run.length > max) runs.push(run);
          run = [];
        }
      }
    }
  }
  return runs.sort((x, y) => y.length - x.length);
}

// Cuts every run longer than `max` with a black square, keeping all entries
// ≥3 and the grid connected. A run with no legal cut is skipped rather than
// ending the pass (the old loop quit on the first stuck run, which on 21×21
// and up meant nearly every attempt failed); cutting a neighbouring run often
// frees it on the next sweep. Returns whether every long run was cut.
function breakLongRuns(
  grid: CellState[][],
  size: number,
  max: number,
  symmetric: boolean,
  allowStubs = true
): boolean {
  const set = symmetric ? setBlackSymmetric : (g: CellState[][], r: number, c: number) => setBlackSingle(g, r, c);
  const clear = symmetric ? clearCellSymmetric : (g: CellState[][], r: number, c: number) => clearCellSingle(g, r, c);
  for (let sweep = 0; sweep < size * size; sweep++) {
    const runs = findLongRuns(grid, size, max);
    if (runs.length === 0) return true;
    let cut = false;
    for (const run of runs) {
      const positions = run.filter((_, i) => i >= MIN_WORD_LENGTH && i <= run.length - MIN_WORD_LENGTH - 1);
      shuffle(positions);
      for (const [r, c] of positions) {
        set(grid, r, c, size);
        if (checkMinWordLength(grid, size) && isConnected(grid, size)) {
          cut = true;
          break;
        }
        clear(grid, r, c, size);
      }
      if (cut) break;
    }
    // No clean cut anywhere: accept one that strands 1–2 letter stubs, and
    // black those out too (costs extra blacks, so callers allow it only after
    // their clean attempts have had a go). Random fills (freeform) box runs in so tightly
    // that this is usually the only way through.
    if (!cut && allowStubs) {
      for (const run of runs) {
        const positions = run.filter((_, i) => i >= MIN_WORD_LENGTH && i <= run.length - MIN_WORD_LENGTH - 1);
        shuffle(positions);
        for (const [r, c] of positions) {
          const saved = grid.map((row) => row.slice());
          const before = countBlacks(grid, size);
          set(grid, r, c, size);
          fillShortRuns(grid, size, set);
          // A cascade that blacks out more than a couple of stubs leaves a blob.
          if (countBlacks(grid, size) - before <= MAX_STUB_BLACKS && checkMinWordLength(grid, size) && isConnected(grid, size)) {
            cut = true;
            break;
          }
          for (let i = 0; i < size; i++) grid[i] = saved[i];
        }
        if (cut) break;
      }
    }
    if (!cut) return false;
  }
  return findLongRuns(grid, size, max).length === 0;
}

// Blacks out every run shorter than MIN_WORD_LENGTH until none remain.
function fillShortRuns(
  grid: CellState[][],
  size: number,
  set: (g: CellState[][], r: number, c: number, size: number) => void
) {
  for (let changed = true; changed; ) {
    changed = false;
    for (const across of [true, false]) {
      for (let a = 0; a < size; a++) {
        let run: [number, number][] = [];
        for (let b = 0; b <= size; b++) {
          const [r, c] = across ? [a, b] : [b, a];
          if (b < size && grid[r][c].type === "white") {
            run.push([r, c]);
          } else {
            if (run.length > 0 && run.length < MIN_WORD_LENGTH) {
              for (const [rr, cc] of run) set(grid, rr, cc, size);
              changed = true;
            }
            run = [];
          }
        }
      }
    }
  }
}

function countBlacks(grid: CellState[][], size: number): number {
  let count = 0;
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++)
      if (grid[r][c].type === "black") count++;
  return count;
}

function countWords(grid: CellState[][], size: number): number {
  let count = 0;
  for (let r = 0; r < size; r++) {
    let run = 0;
    for (let c = 0; c <= size; c++) {
      if (c < size && grid[r][c].type === "white") { run++; }
      else { if (run >= MIN_WORD_LENGTH) count++; run = 0; }
    }
  }
  for (let c = 0; c < size; c++) {
    let run = 0;
    for (let r = 0; r <= size; r++) {
      if (r < size && grid[r][c].type === "white") { run++; }
      else { if (run >= MIN_WORD_LENGTH) count++; run = 0; }
    }
  }
  return count;
}

function countLongWords(grid: CellState[][], size: number, threshold = 6): number {
  let count = 0;
  for (let r = 0; r < size; r++) {
    let run = 0;
    for (let c = 0; c <= size; c++) {
      if (c < size && grid[r][c].type === "white") { run++; }
      else { if (run >= threshold) count++; run = 0; }
    }
  }
  for (let c = 0; c < size; c++) {
    let run = 0;
    for (let r = 0; r <= size; r++) {
      if (r < size && grid[r][c].type === "white") { run++; }
      else { if (run >= threshold) count++; run = 0; }
    }
  }
  return count;
}

function checkedCellRatio(grid: CellState[][], size: number): number {
  const cellSlotCount = new Map<string, number>();
  for (let r = 0; r < size; r++) {
    let run: [number, number][] = [];
    for (let c = 0; c <= size; c++) {
      if (c < size && grid[r][c].type === "white") {
        run.push([r, c]);
      } else {
        if (run.length >= MIN_WORD_LENGTH) {
          for (const [rr, cc] of run) {
            const key = `${rr},${cc}`;
            cellSlotCount.set(key, (cellSlotCount.get(key) || 0) + 1);
          }
        }
        run = [];
      }
    }
  }
  for (let c = 0; c < size; c++) {
    let run: [number, number][] = [];
    for (let r = 0; r <= size; r++) {
      if (r < size && grid[r][c].type === "white") {
        run.push([r, c]);
      } else {
        if (run.length >= MIN_WORD_LENGTH) {
          for (const [rr, cc] of run) {
            const key = `${rr},${cc}`;
            cellSlotCount.set(key, (cellSlotCount.get(key) || 0) + 1);
          }
        }
        run = [];
      }
    }
  }

  let checked = 0, total = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (grid[r][c].type === "white") {
        total++;
        if ((cellSlotCount.get(`${r},${c}`) || 0) >= 2) checked++;
      }
    }
  }
  return total > 0 ? checked / total : 0;
}

function estimateDifficulty(grid: CellState[][], size: number): number {
  const blacks = countBlacks(grid, size);
  const total = size * size;
  const blackPct = blacks / total;
  const longWords = countLongWords(grid, size, 7);
  const checked = checkedCellRatio(grid, size);
  const words = countWords(grid, size);
  const avgWordLen = (total - blacks) / Math.max(words, 1) * 2;

  let score = 0;
  score += checked * 2;
  score += Math.min(longWords / 10, 1);
  score += Math.max(0, avgWordLen - 4) * 0.3;
  score -= blackPct;

  if (score < 0.8) return 1;
  if (score < 1.2) return 2;
  if (score < 1.6) return 3;
  if (score < 2.0) return 4;
  return 5;
}

function makePatternInfo(grid: CellState[][], size: number, style: PatternStyle): PatternInfo {
  const blacks = countBlacks(grid, size);
  return {
    grid,
    style,
    difficulty: estimateDifficulty(grid, size),
    wordCount: countWords(grid, size),
    blackPercent: Math.round((blacks / (size * size)) * 100),
    name: generateName(),
  };
}

// --- Symmetry helpers ---

function setBlackSymmetric(grid: CellState[][], r: number, c: number, size: number) {
  grid[r][c] = { type: "black", letter: "", number: null };
  const sr = size - 1 - r, sc = size - 1 - c;
  grid[sr][sc] = { type: "black", letter: "", number: null };
}

function clearCellSymmetric(grid: CellState[][], r: number, c: number, size: number) {
  grid[r][c] = { type: "white", letter: "", number: null };
  const sr = size - 1 - r, sc = size - 1 - c;
  grid[sr][sc] = { type: "white", letter: "", number: null };
}

function setBlackSingle(grid: CellState[][], r: number, c: number) {
  grid[r][c] = { type: "black", letter: "", number: null };
}

function clearCellSingle(grid: CellState[][], r: number, c: number) {
  grid[r][c] = { type: "white", letter: "", number: null };
}

// --- American (NYT) style ---
// 180° rotational symmetry, every cell checked, ~20-25% black

export function generateAmericanPattern(size: number): PatternInfo {
  const targetBlacks = size <= 5 ? randomInt(0, 4) : size <= 11 ? randomInt(20, 26) : size <= 15 ? randomInt(44, 50) : randomInt(72, 82);
  const maxLongWords = size <= 11 ? 999 : size <= 15 ? 20 : Math.round(20 * (size * size) / 225);
  const maxLen = maxWordLength(size);

  for (let attempt = 0; attempt < 200; attempt++) {
    const grid = createGrid(size);

    if (!breakLongRuns(grid, size, maxLen, true, attempt >= STUB_CUTS_AFTER)) continue;

    const mid = Math.floor(size / 2);
    const candidates: [number, number][] = [];
    for (let r = 0; r <= mid; r++) {
      for (let c = 0; c < size; c++) {
        if (r === mid && c > mid) continue;
        candidates.push([r, c]);
      }
    }
    shuffle(candidates);

    for (const [r, c] of candidates) {
      if (countBlacks(grid, size) >= targetBlacks) break;
      if (grid[r][c].type === "black") continue;
      const sr = size - 1 - r, sc = size - 1 - c;
      if (grid[sr][sc].type === "black") continue;

      setBlackSymmetric(grid, r, c, size);
      if (!checkMinWordLength(grid, size) || !isConnected(grid, size) || findLongestRun(grid, size, maxLen)) {
        clearCellSymmetric(grid, r, c, size);
      }
    }

    const blacks = countBlacks(grid, size);
    if (blacks >= targetBlacks - 6 && isConnected(grid, size) && checkMinWordLength(grid, size) && !findLongestRun(grid, size, maxLen) && countLongWords(grid, size) <= maxLongWords) {
      return makePatternInfo(grid, size, "american");
    }
  }

  return { ...makePatternInfo(createGrid(size), size, "american"), failed: true };
}

// --- British (Guardian) style ---
// Authentic blocked-grid lattice. Real Guardian/cryptic grids have three
// defining properties the old density-based generator missed entirely:
//   1. 180° rotational symmetry (never broken).
//   2. No black square at an (even, even) cell — those stay white as the
//      guaranteed *checked* crossing points.
//   3. About half the white cells are *unchecked* (belong to one word only),
//      giving the characteristic "checkerboard" spacing.
// Unchecked cells show up as length-1 runs in one direction, so the American
// min-word-length check (which rejects any run < 3) can't be used here: British
// runs are valid at length 1 (an unchecked letter) or ≥ MIN_WORD_LENGTH, but
// never exactly 2 (no two-letter lights).

function britRunsOk(grid: CellState[][], size: number): boolean {
  const bad = (run: number) => run === 2 || (run > 2 && run < MIN_WORD_LENGTH);
  for (let r = 0; r < size; r++) {
    let run = 0;
    for (let c = 0; c <= size; c++) {
      if (c < size && grid[r][c].type === "white") run++;
      else { if (bad(run)) return false; run = 0; }
    }
  }
  for (let c = 0; c < size; c++) {
    let run = 0;
    for (let r = 0; r <= size; r++) {
      if (r < size && grid[r][c].type === "white") run++;
      else { if (bad(run)) return false; run = 0; }
    }
  }
  return true;
}

function britNoIsolated(grid: CellState[][], size: number): boolean {
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (grid[r][c].type !== "white") continue;
      const ac = (c > 0 && grid[r][c - 1].type === "white") || (c < size - 1 && grid[r][c + 1].type === "white");
      const dn = (r > 0 && grid[r - 1][c].type === "white") || (r < size - 1 && grid[r + 1][c].type === "white");
      if (!ac && !dn) return false;
    }
  }
  return true;
}

function maxAdjacentBlack(grid: CellState[][], size: number): number {
  let m = 0;
  for (let r = 0; r < size; r++) {
    let run = 0;
    for (let c = 0; c <= size; c++) {
      if (c < size && grid[r][c].type === "black") { run++; m = Math.max(m, run); }
      else run = 0;
    }
  }
  for (let c = 0; c < size; c++) {
    let run = 0;
    for (let r = 0; r <= size; r++) {
      if (r < size && grid[r][c].type === "black") { run++; m = Math.max(m, run); }
      else run = 0;
    }
  }
  return m;
}

function longestWhiteRun(grid: CellState[][], size: number): number {
  let m = 0;
  for (let r = 0; r < size; r++) {
    let run = 0;
    for (let c = 0; c <= size; c++) {
      if (c < size && grid[r][c].type === "white") { run++; m = Math.max(m, run); }
      else run = 0;
    }
  }
  for (let c = 0; c < size; c++) {
    let run = 0;
    for (let r = 0; r <= size; r++) {
      if (r < size && grid[r][c].type === "white") { run++; m = Math.max(m, run); }
      else run = 0;
    }
  }
  return m;
}

function lineLenAcross(grid: CellState[][], r: number, size: number): number {
  let m = 0, run = 0;
  for (let c = 0; c <= size; c++) {
    if (c < size && grid[r][c].type === "white") { run++; m = Math.max(m, run); }
    else run = 0;
  }
  return m;
}

function lineLenDown(grid: CellState[][], c: number, size: number): number {
  let m = 0, run = 0;
  for (let r = 0; r <= size; r++) {
    if (r < size && grid[r][c].type === "white") { run++; m = Math.max(m, run); }
    else run = 0;
  }
  return m;
}

function britValid(grid: CellState[][], size: number, maxWord: number): boolean {
  return (
    britRunsOk(grid, size) &&
    britNoIsolated(grid, size) &&
    isConnected(grid, size) &&
    maxAdjacentBlack(grid, size) <= 3 &&
    longestWhiteRun(grid, size) <= maxWord
  );
}

// Blacken (r,c) + its symmetric partner if it keeps the grid valid.
function britTryBlack(grid: CellState[][], r: number, c: number, size: number): boolean {
  if (grid[r][c].type === "black") return false;
  setBlackSymmetric(grid, r, c, size);
  if (britRunsOk(grid, size) && maxAdjacentBlack(grid, size) <= 3 && isConnected(grid, size)) {
    return true;
  }
  clearCellSymmetric(grid, r, c, size);
  return false;
}

export function generateBritishPattern(
  size: number,
  density: "standard" | "sparse" = "standard"
): PatternInfo {
  // Guardian lattices need room; below 9×9 the gallery drops the empty style.
  if (size < 9) return { ...makePatternInfo(createGrid(size), size, "british"), failed: true };

  // Longest allowed light scales with the grid; "sparse" grids (CJK / Russian,
  // which fill dense interlock poorly) get shorter words and higher black%.
  const maxWord = density === "sparse"
    ? 7
    : size >= 17 ? 11 : size >= 13 ? 9 : 7;
  const blackMin = 0.18;
  const blackMax = density === "sparse" ? 0.48 : 0.4;
  // Keep post-dissolving light: the near-maximal lattice holds ~60% of letters
  // unchecked (matching real Guardian grids) and — because each light crosses
  // only a few others — is what the autofill solver fills fastest and most
  // reliably. Heavy dissolving lowers the unched ratio and makes grids hard.
  const dissolveLo = 0.0;
  const dissolveHi = density === "sparse" ? 0.08 : 0.12;

  for (let attempt = 0; attempt < 400; attempt++) {
    const grid = createGrid(size);

    // 1. Lay the maximal post lattice: a block at every (odd, odd) cell.
    //    (odd, odd) maps to (odd, odd) under 180° rotation, so odd-sized grids
    //    are symmetric by construction.
    for (let r = 1; r < size; r += 2)
      for (let c = 1; c < size; c += 2)
        grid[r][c] = { type: "black", letter: "", number: null };

    // 2. Break the full-width even-row across words with (even, odd) blocks.
    for (let r = 0; r < size; r += 2) {
      let guard = 0;
      while (lineLenAcross(grid, r, size) > maxWord && guard < size) {
        guard++;
        const cols: number[] = [];
        for (let c = 1; c < size; c += 2) if (grid[r][c].type === "white") cols.push(c);
        shuffle(cols);
        if (!cols.some((c) => britTryBlack(grid, r, c, size))) break;
      }
    }

    // 3. Break the full-height even-column down words with (odd, even) blocks.
    for (let c = 0; c < size; c += 2) {
      let guard = 0;
      while (lineLenDown(grid, c, size) > maxWord && guard < size) {
        guard++;
        const rows: number[] = [];
        for (let r = 1; r < size; r += 2) if (grid[r][c].type === "white") rows.push(r);
        shuffle(rows);
        if (!rows.some((r) => britTryBlack(grid, r, c, size))) break;
      }
    }

    // 4. Dissolve a random share of posts for variety and lower density,
    //    keeping every British rule intact.
    const posts: [number, number][] = [];
    for (let r = 1; r < size; r += 2)
      for (let c = 1; c < size; c += 2)
        if (grid[r][c].type === "black") posts.push([r, c]);
    shuffle(posts);
    const dissolveCount = Math.floor(posts.length * (dissolveLo + Math.random() * (dissolveHi - dissolveLo)));
    for (let i = 0; i < dissolveCount; i++) {
      const [r, c] = posts[i];
      if (grid[r][c].type !== "black") continue;
      clearCellSymmetric(grid, r, c, size);
      if (!britValid(grid, size, maxWord)) setBlackSymmetric(grid, r, c, size);
    }

    if (!britValid(grid, size, maxWord)) continue;
    const blackPct = countBlacks(grid, size) / (size * size);
    if (blackPct < blackMin || blackPct > blackMax) continue;
    if (countWords(grid, size) < 20) continue;
    return makePatternInfo(grid, size, "british");
  }

  return { ...makePatternInfo(createGrid(size), size, "british"), failed: true };
}

// --- Freeform style ---
// Two variants: symmetric (180° rotation) and asymmetric (no symmetry).
// Fewer constraints, easier to fill. Can have creative shapes.

export function generateFreeformPattern(size: number): PatternInfo {
  const useSymmetry = Math.random() < 0.5;

  if (useSymmetry) {
    return generateFreeformSymmetric(size);
  } else {
    return generateFreeformAsymmetric(size);
  }
}

function generateFreeformSymmetric(size: number): PatternInfo {
  const maxLen = maxWordLength(size);
  const targetBlackPct = randomInt(25, 40) / 100;
  const targetBlacks = Math.round(size * size * targetBlackPct);

  for (let attempt = 0; attempt < 200; attempt++) {
    const grid = createGrid(size);

    const mid = Math.floor(size / 2);
    const candidates: [number, number][] = [];
    for (let r = 0; r <= mid; r++) {
      for (let c = 0; c < size; c++) {
        if (r === mid && c > mid) continue;
        candidates.push([r, c]);
      }
    }
    shuffle(candidates);

    for (const [r, c] of candidates) {
      if (countBlacks(grid, size) >= targetBlacks) break;
      setBlackSymmetric(grid, r, c, size);
      if (!checkMinWordLength(grid, size) || !isConnected(grid, size)) {
        clearCellSymmetric(grid, r, c, size);
      }
    }

    breakLongRuns(grid, size, maxLen, true, attempt >= STUB_CUTS_AFTER);

    const blacks = countBlacks(grid, size);
    if (
      blacks >= targetBlacks - 8 &&
      isConnected(grid, size) &&
      checkMinWordLength(grid, size) &&
      !findLongestRun(grid, size, maxLen)
    ) {
      return makePatternInfo(grid, size, "freeform");
    }
  }

  return { ...makePatternInfo(createGrid(size), size, "freeform"), failed: true };
}

function generateFreeformAsymmetric(size: number): PatternInfo {
  const maxLen = maxWordLength(size);
  const targetBlackPct = randomInt(28, 45) / 100;
  const targetBlacks = Math.round(size * size * targetBlackPct);

  for (let attempt = 0; attempt < 200; attempt++) {
    const grid = createGrid(size);

    // Use a random walk / cluster approach for more interesting shapes
    // Seed a few random black clusters
    const seeds = randomInt(3, 6);
    for (let s = 0; s < seeds; s++) {
      const sr = randomInt(0, size - 1);
      const sc = randomInt(0, size - 1);
      // Grow a cluster from this seed
      const clusterSize = randomInt(3, Math.floor(size * 1.5));
      let cr = sr, cc = sc;
      for (let i = 0; i < clusterSize; i++) {
        if (cr >= 0 && cr < size && cc >= 0 && cc < size) {
          setBlackSingle(grid, cr, cc);
        }
        // Random walk
        const dir = randomInt(0, 3);
        if (dir === 0) cr--;
        else if (dir === 1) cr++;
        else if (dir === 2) cc--;
        else cc++;
      }
    }

    // Remove blacks that break connectivity or min word length
    for (let pass = 0; pass < 3; pass++) {
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          if (grid[r][c].type === "black") {
            clearCellSingle(grid, r, c);
            if (!checkMinWordLength(grid, size) || !isConnected(grid, size)) {
              // Removing this black broke something — keep it if keeping it is also valid
              setBlackSingle(grid, r, c);
              if (!isConnected(grid, size) || !checkMinWordLength(grid, size)) {
                clearCellSingle(grid, r, c);
              }
            }
          }
        }
      }
    }

    // Add more blacks if under target
    if (countBlacks(grid, size) < targetBlacks) {
      const allCells: [number, number][] = [];
      for (let r = 0; r < size; r++)
        for (let c = 0; c < size; c++)
          if (grid[r][c].type === "white") allCells.push([r, c]);
      shuffle(allCells);

      for (const [r, c] of allCells) {
        if (countBlacks(grid, size) >= targetBlacks) break;
        setBlackSingle(grid, r, c);
        if (!checkMinWordLength(grid, size) || !isConnected(grid, size)) {
          clearCellSingle(grid, r, c);
        }
      }
    }

    breakLongRuns(grid, size, maxLen, false, attempt >= STUB_CUTS_AFTER);

    const blacks = countBlacks(grid, size);
    if (
      blacks >= Math.floor(targetBlacks * 0.7) &&
      isConnected(grid, size) &&
      checkMinWordLength(grid, size) &&
      !findLongestRun(grid, size, maxLen)
    ) {
      return makePatternInfo(grid, size, "freeform");
    }
  }

  return { ...makePatternInfo(createGrid(size), size, "freeform"), failed: true };
}

// Keep backward compat
export function generatePattern(size: number): CellState[][] {
  return generateAmericanPattern(size).grid;
}

// --- Utilities ---

function shuffle<T>(arr: T[]) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
