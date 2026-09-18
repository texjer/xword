import { CellState } from "@/lib/types";

// .puz binary format encoder (Across Lite)
// Reference: https://code.google.com/archive/p/puz/wikis/FileFormat.wiki

function checksumRegion(data: Uint8Array, cksum: number): number {
  for (const byte of data) {
    const lowbit = cksum & 1;
    cksum = (cksum >>> 1) | (lowbit << 15);
    cksum = (cksum + byte) & 0xffff;
  }
  return cksum;
}

/** .puz strings are Latin-1. Substitute the typographic characters LLM-written
 * clues tend to contain (curly quotes, dashes, ellipsis) with ASCII stand-ins,
 * and anything else above 0xFF with '?' — a bare charCodeAt()&0xff would turn
 * a curly apostrophe into a control byte. Latin-1 accents (é, ñ) pass through. */
const LATIN1_SUBS: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "′": "'",
  "“": '"', "”": '"', "„": '"', "″": '"',
  "–": "-", "—": "--", "−": "-",
  "…": "...",
};

function toLatin1(str: string): string {
  return [...str]
    .map((ch) => LATIN1_SUBS[ch] ?? (ch.charCodeAt(0) > 0xff ? "?" : ch))
    .join("");
}

function textToBytes(str: string): Uint8Array {
  const s = toLatin1(str);
  const bytes = new Uint8Array(s.length + 1);
  for (let i = 0; i < s.length; i++) {
    bytes[i] = s.charCodeAt(i);
  }
  bytes[s.length] = 0;
  return bytes;
}

interface PuzInput {
  title: string;
  author: string;
  size: number;
  cells: CellState[][];
  clues: { across: Record<number, string>; down: Record<number, string> };
}

function buildClueList(
  size: number,
  cells: CellState[][],
  clues: { across: Record<number, string>; down: Record<number, string> }
): string[] {
  const list: string[] = [];

  let num = 1;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (cells[r][c].type === "black") continue;

      const startsAcross =
        (c === 0 || cells[r][c - 1].type === "black") &&
        c + 1 < size &&
        cells[r][c + 1]?.type === "white";

      const startsDown =
        (r === 0 || cells[r - 1][c].type === "black") &&
        r + 1 < size &&
        cells[r + 1]?.[c]?.type === "white";

      if (!startsAcross && !startsDown) continue;

      if (startsAcross) {
        list.push(clues.across[num] || "");
      }
      if (startsDown) {
        list.push(clues.down[num] || "");
      }
      num++;
    }
  }
  return list;
}

export function exportPuz(input: PuzInput): Uint8Array {
  const { title, author, size, cells, clues } = input;
  const width = size;
  const height = size;
  const boardSize = width * height;

  const solution = new Uint8Array(boardSize);
  const playerState = new Uint8Array(boardSize);

  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const idx = r * width + c;
      if (cells[r][c].type === "black") {
        solution[idx] = 0x2e; // '.'
        playerState[idx] = 0x2e;
      } else {
        // Player state is the SOLVER's progress — always export it blank
        // ('-') so the file opens as a puzzle to solve, not already filled.
        // The answers still ship in the solution section (that's the format;
        // apps gate them behind Reveal), which is also what construction
        // software imports.
        const letter = (cells[r][c].letter || "A").toUpperCase();
        solution[idx] = letter.charCodeAt(0);
        playerState[idx] = 0x2d;
      }
    }
  }

  const clueList = buildClueList(size, cells, clues);
  const numClues = clueList.length;

  const titleBytes = textToBytes(title || "Untitled");
  const authorBytes = textToBytes(author || "");
  const copyrightBytes = textToBytes("");
  const notesBytes = textToBytes("");

  const clueBytes = clueList.map((c) => textToBytes(c));

  const headerSize = 52;
  let totalSize = headerSize + boardSize * 2;
  totalSize += titleBytes.length;
  totalSize += authorBytes.length;
  totalSize += copyrightBytes.length;
  for (const cb of clueBytes) totalSize += cb.length;
  totalSize += notesBytes.length;

  const buf = new Uint8Array(totalSize);
  const view = new DataView(buf.buffer);

  // Checksums computed after filling in the rest
  // Magic string "ACROSS&DOWN\0"
  const magic = "ACROSS&DOWN\0";
  for (let i = 0; i < magic.length; i++) {
    buf[2 + i] = magic.charCodeAt(i);
  }

  // Header version "1.3\0"
  const version = "1.3\0";
  for (let i = 0; i < version.length; i++) {
    buf[0x18 + i] = version.charCodeAt(i);
  }

  buf[0x2c] = width;
  buf[0x2d] = height;
  view.setUint16(0x2e, numClues, true);
  view.setUint16(0x30, 1, true); // puzzle type: normal
  view.setUint16(0x32, 0, true); // solution state: unlocked

  let offset = headerSize;
  buf.set(solution, offset);
  offset += boardSize;
  buf.set(playerState, offset);
  offset += boardSize;
  buf.set(titleBytes, offset);
  offset += titleBytes.length;
  buf.set(authorBytes, offset);
  offset += authorBytes.length;
  buf.set(copyrightBytes, offset);
  offset += copyrightBytes.length;
  for (const cb of clueBytes) {
    buf.set(cb, offset);
    offset += cb.length;
  }
  buf.set(notesBytes, offset);

  // Compute checksums
  const cibCksum = checksumRegion(buf.subarray(0x2c, 0x34), 0);
  view.setUint16(0x0e, cibCksum, true);

  let cksum = cibCksum;
  cksum = checksumRegion(solution, cksum);
  cksum = checksumRegion(playerState, cksum);

  // String checksums: title, author, copyright, clues, notes (with null terminators for non-empty)
  if (title) cksum = checksumRegion(titleBytes, cksum);
  if (author) cksum = checksumRegion(authorBytes, cksum);
  cksum = checksumRegion(copyrightBytes.subarray(0, 0), cksum); // empty copyright
  for (const cb of clueBytes) {
    cksum = checksumRegion(cb.subarray(0, cb.length - 1), cksum);
  }

  view.setUint16(0x00, cksum, true);

  // Masked checksums
  const solCksum = checksumRegion(solution, 0);
  const gridCksum = checksumRegion(playerState, 0);

  let partialStrCksum = 0;
  if (title) partialStrCksum = checksumRegion(titleBytes, partialStrCksum);
  if (author) partialStrCksum = checksumRegion(authorBytes, partialStrCksum);
  for (const cb of clueBytes) {
    partialStrCksum = checksumRegion(cb.subarray(0, cb.length - 1), partialStrCksum);
  }

  const lowMask = new Uint8Array(4);
  const highMask = new Uint8Array(4);
  lowMask[0] = 0x49 ^ (cibCksum & 0xff);
  lowMask[1] = 0x43 ^ (solCksum & 0xff);
  lowMask[2] = 0x48 ^ (gridCksum & 0xff);
  lowMask[3] = 0x45 ^ (partialStrCksum & 0xff);
  highMask[0] = 0x41 ^ ((cibCksum >> 8) & 0xff);
  highMask[1] = 0x54 ^ ((solCksum >> 8) & 0xff);
  highMask[2] = 0x45 ^ ((gridCksum >> 8) & 0xff);
  highMask[3] = 0x44 ^ ((partialStrCksum >> 8) & 0xff);

  buf.set(lowMask, 0x10);
  buf.set(highMask, 0x14);

  return buf;
}

export function downloadPuz(input: PuzInput): void {
  const data = exportPuz(input);
  const name = input.title
    ? input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") + ".puz"
    : "crossword.puz";
  const blob = new Blob([data.buffer as ArrayBuffer], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
