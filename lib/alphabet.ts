export type PuzzleLanguage =
  | "en"
  | "es"
  | "fr"
  | "de"
  | "it"
  | "pt"
  | "pt-BR"
  | "pl"
  | "nl"
  | "zh"
  | "ja"
  | "ko"
  | "hi"
  | "ar"
  | "tr"
  | "he"
  | "id"
  | "cs"
  | "uk"
  | "ro"
  | "ru"
  | "sv"
  | "no"
  | "da"
  | "hr";

export interface AlphabetConfig {
  code: PuzzleLanguage;
  name: string;
  nativeName: string;
  alphabet: string;
  fold: Record<string, string>;
  databaseAvailable: boolean;
  // A database can be ready before the grid/input UX for its writing system is.
  // False keeps that language out of constructor selectors without discarding data.
  constructorAvailable?: boolean;
  characterRanges?: ReadonlyArray<readonly [number, number]>;
  normalizationForm?: "NFC" | "NFKC";
  stripMarks?: boolean;
  // Right-to-left scripts (Arabic, Hebrew). The data model stays logical/LTR
  // (col 0 is the first letter, numbering in reading order); the grid is
  // visually mirrored with `direction: rtl` and horizontal arrow keys swap.
  rtl?: boolean;
  // Scripts where one printed "letter" (a grid cell) spans several codepoints:
  // a Devanagari akshara is a base consonant plus its combining matra/virama.
  // These languages segment words into grapheme clusters instead of codepoints.
  graphemeClusters?: boolean;
  // Large glyph inventories (CJK, Devanagari) can't fill a dense interlocking
  // grid — two words almost never share a glyph at a crossing. These build only
  // as criss-cross (words join where they happen to share a glyph, rest floats).
  crissCrossOnly?: boolean;
  // Whether this alphabet survives a classic `.puz` export. The writer is
  // single-byte (ISO-8859-1), so Latin scripts (incl. accents/umlauts, which
  // sit in Latin-1) round-trip, but Cyrillic and other non-Latin scripts get
  // corrupted — those disable the `.puz` download.
  puzExportable: boolean;
  // Greyed-out hint words for the "Add theme words" box, in this alphabet.
  // Optional: languages without a curated hint just show an empty placeholder.
  placeholderWords?: string[];
}

const LATIN = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export const ALPHABET_CONFIGS: Record<PuzzleLanguage, AlphabetConfig> = {
  en: {
    code: "en", name: "English", nativeName: "English", alphabet: LATIN, fold: {},
    databaseAvailable: true, puzExportable: true,
    placeholderWords: ["VHS", "RECORD", "TAPE", "FLOPPY", "LASERDISC"],
  },
  es: {
    code: "es", name: "Spanish", nativeName: "Español", alphabet: `${LATIN}Ñ`,
    databaseAvailable: true, puzExportable: true,
    fold: { Á: "A", É: "E", Í: "I", Ó: "O", Ú: "U", Ü: "U" },
    placeholderWords: ["LUNA", "MARTE", "TIERRA", "COMETA", "ORBITA"],
  },
  fr: { code: "fr", name: "French", nativeName: "Français", alphabet: LATIN, fold: { Œ: "OE", œ: "OE", Æ: "AE", æ: "AE" }, databaseAvailable: true, puzExportable: true },
  de: { code: "de", name: "German", nativeName: "Deutsch", alphabet: `${LATIN}ÄÖÜ`, fold: { ẞ: "SS", ß: "SS" }, databaseAvailable: true, puzExportable: true },
  it: { code: "it", name: "Italian", nativeName: "Italiano", alphabet: LATIN, fold: {}, databaseAvailable: true, puzExportable: true },
  pt: { code: "pt", name: "Portuguese", nativeName: "Português", alphabet: LATIN, fold: {}, databaseAvailable: true, puzExportable: true },
  // Brazilian Portuguese shares the one Portuguese puzzle database and clue corpus
  // (the backend normalizes "pt-BR" → "pt"); it's a distinct picker entry so Brazil,
  // the primary market, has its own flag. Mirror every "pt" field/behaviour.
  "pt-BR": { code: "pt-BR", name: "Portuguese (Brazil)", nativeName: "Português (Brasil)", alphabet: LATIN, fold: {}, databaseAvailable: true, puzExportable: true },
  pl: { code: "pl", name: "Polish", nativeName: "Polski", alphabet: `${LATIN}ĄĆĘŁŃÓŚŹŻ`, fold: {}, databaseAvailable: true, puzExportable: false },
  nl: { code: "nl", name: "Dutch", nativeName: "Nederlands", alphabet: LATIN, fold: {}, databaseAvailable: true, puzExportable: true },
  zh: {
    code: "zh", name: "Chinese", nativeName: "中文", alphabet: "", fold: {},
    characterRanges: [[0x3400, 0x4dbf], [0x4e00, 0x9fff]], normalizationForm: "NFKC",
    // Thousands of distinct hanzi make dense interlock unviable (0% dense fill),
    // so Chinese builds as criss-cross only.
    databaseAvailable: true, crissCrossOnly: true, puzExportable: false,
  },
  ja: {
    code: "ja", name: "Japanese", nativeName: "日本語", alphabet: "ーヽヾ", fold: {},
    characterRanges: [[0x30a1, 0x30fa]], normalizationForm: "NFKC",
    // Thin high-score katakana lexicon + sparse crossings (~24% dense fill),
    // so Japanese builds as criss-cross only.
    databaseAvailable: true, crissCrossOnly: true, puzExportable: false,
  },
  ko: {
    code: "ko", name: "Korean", nativeName: "한국어", alphabet: "", fold: {},
    characterRanges: [[0xac00, 0xd7a3]], normalizationForm: "NFKC",
    // ~2,500 distinct syllable blocks make dense crossings unsatisfiable (0%
    // dense fill), so Korean builds as criss-cross only.
    databaseAvailable: true, crissCrossOnly: true, puzExportable: false,
  },
  hi: {
    code: "hi", name: "Hindi", nativeName: "हिन्दी", alphabet: "", fold: {},
    characterRanges: [[0x0900, 0x097f]], normalizationForm: "NFKC", graphemeClusters: true,
    databaseAvailable: true, constructorAvailable: false, puzExportable: false,
  },
  ar: {
    code: "ar", name: "Arabic", nativeName: "العربية",
    alphabet: "ءابتثجحخدذرزسشصضطظعغفقكلمنهويؤئأة", stripMarks: true, rtl: true,
    fold: { أ: "ا", إ: "ا", آ: "ا", ٱ: "ا", ى: "ي", ی: "ي", ک: "ك", ـ: "" },
    normalizationForm: "NFKC", databaseAvailable: true, puzExportable: false,
  },
  tr: {
    code: "tr", name: "Turkish", nativeName: "Türkçe", alphabet: `${LATIN}ÇĞİÖŞÜ`,
    fold: { i: "İ", ı: "I" }, databaseAvailable: true, puzExportable: false,
  },
  // 22 letters, and the five final forms are deliberately NOT among them.
  // ‏ך ם ן ף ץ‎ occur only word-finally, but a crossword cell belongs to two
  // entries at once — the cell holding the last letter of an Across is in the
  // middle of a Down — so a final form can never match a crossing word. That
  // is 26% of the Hebrew answer pool, including every masculine plural in
  // ‏־ים‎ and ‏ארץ‎, ‏כסף‎, ‏שלום‎, ‏זמן‎. Israeli ‏תשבץ‎ practice folds them for the
  // same reason, so ‏ילדים‎ is gridded ‏ילדימ‎, and `fold` does it as the solver
  // types. The seed harness folds identically (`_GRID_FOLD` in
  // scripts/seed_lib.py); the two must stay in step or published Hebrew
  // puzzles stop matching what the constructor accepts.
  he: {
    code: "he", name: "Hebrew", nativeName: "עברית", alphabet: "אבגדהוזחטיכלמנסעפצקרשת",
    fold: { ך: "כ", ם: "מ", ן: "נ", ף: "פ", ץ: "צ" },
    stripMarks: true, normalizationForm: "NFKC", rtl: true,
    databaseAvailable: true, puzExportable: false,
  },
  id: { code: "id", name: "Indonesian", nativeName: "Bahasa Indonesia", alphabet: LATIN, fold: {}, databaseAvailable: true, puzExportable: true },
  cs: { code: "cs", name: "Czech", nativeName: "Čeština", alphabet: `${LATIN}ÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ`, fold: {}, databaseAvailable: true, puzExportable: false },
  uk: { code: "uk", name: "Ukrainian", nativeName: "Українська", alphabet: "АБВГҐДЕЄЖЗИІЇЙКЛМНОПРСТУФХЦЧШЩЬЮЯ", fold: {}, databaseAvailable: true, puzExportable: false },
  ro: {
    code: "ro", name: "Romanian", nativeName: "Română", alphabet: `${LATIN}ĂÂÎȘȚ`,
    fold: { Ş: "Ș", ş: "Ș", Ţ: "Ț", ţ: "Ț" }, databaseAvailable: true, puzExportable: false,
  },
  ru: {
    code: "ru", name: "Russian", nativeName: "Русский", databaseAvailable: true, puzExportable: false,
    alphabet: "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ", fold: { Ё: "Е", ё: "Е" },
    placeholderWords: ["ЛУНА", "МАРС", "КОМЕТА", "ЗЕМЛЯ", "ОРБИТА"],
  },
  // Å, Ä and Ö are letters in their own right, sorted after Z rather than
  // filed beside A and O — so no `fold`, and an entry spelled with Ä must not
  // match one spelled with A. That distinction is load-bearing rather than
  // cosmetic: the seeded answer pool alone holds 238 pairs that differ only in
  // those three letters, including HÖRA/HORA, FÅR/FAR and ÄGG/AGG.
  //
  // `constructorAvailable` was off while `sv` had no puzzles behind it. It is
  // on as of the ten seeded showcase puzzles (see backend/showcase_seed).
  sv: { code: "sv", name: "Swedish", nativeName: "Svenska", alphabet: `${LATIN}ÅÄÖ`, fold: {}, databaseAvailable: true, puzExportable: true },
  no: { code: "no", name: "Norwegian", nativeName: "Norsk", alphabet: `${LATIN}ÆØÅ`, fold: {}, databaseAvailable: true, constructorAvailable: false, puzExportable: true },
  da: { code: "da", name: "Danish", nativeName: "Dansk", alphabet: `${LATIN}ÆØÅ`, fold: {}, databaseAvailable: true, constructorAvailable: false, puzExportable: true },
  // Gaj's Latin alphabet. Croatian counts DŽ, LJ and NJ as single letters, but
  // they're gridded as their component letters so one cell is always one
  // codepoint. Č/Ć/Đ/Š/Ž fall outside Latin-1, so `.puz` export is off.
  hr: { code: "hr", name: "Croatian", nativeName: "Hrvatski", alphabet: `${LATIN}ČĆĐŠŽ`, fold: {}, databaseAvailable: true, puzExportable: false },
};

export const AVAILABLE_PUZZLE_LANGUAGES = Object.values(ALPHABET_CONFIGS).filter(
  (config) => config.databaseAvailable && config.constructorAvailable !== false
);

export function isPuzzleLanguage(value: unknown): value is PuzzleLanguage {
  return typeof value === "string" && value in ALPHABET_CONFIGS;
}

function foldCharacter(char: string, config: AlphabetConfig): string {
  if (config.stripMarks && /\p{M}/u.test(char)) return "";
  if (config.fold[char]) return config.fold[char];
  if (config.code === "ja") {
    const codepoint = char.codePointAt(0) ?? 0;
    if (codepoint >= 0x3041 && codepoint <= 0x3096) {
      return String.fromCodePoint(codepoint + 0x60);
    }
  }
  const uppercase = char.toUpperCase();
  if (config.fold[uppercase]) return config.fold[uppercase];
  if (["fr", "it", "pt", "pt-BR", "nl", "id"].includes(config.code)) {
    return char.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }
  return char;
}

function isConfiguredCharacter(char: string, config: AlphabetConfig): boolean {
  if (config.alphabet.includes(char)) return true;
  const codepoint = char.codePointAt(0);
  return codepoint !== undefined && Boolean(
    config.characterRanges?.some(([start, end]) => codepoint >= start && codepoint <= end)
  );
}

export function normalizePuzzleText(value: string, language: PuzzleLanguage): string {
  const config = ALPHABET_CONFIGS[language];
  let normalized = "";
  for (const input of Array.from(value.normalize(config.normalizationForm ?? "NFC"))) {
    const folded = foldCharacter(input, config).toUpperCase();
    for (const char of Array.from(folded)) {
      if (isConfiguredCharacter(char, config)) normalized += char;
    }
  }
  return normalized;
}

export function normalizePuzzlePattern(value: string, language: PuzzleLanguage): string {
  return Array.from(value)
    .map((char) => (char === "_" ? "_" : normalizePuzzleText(char, language)))
    .join("");
}

export function normalizeLetter(value: string, language: PuzzleLanguage): string {
  const letters = normalizePuzzleText(value, language);
  return Array.from(letters).length === 1 ? letters : "";
}

export function isPuzzleLetter(value: string, language: PuzzleLanguage): boolean {
  return Array.from(value).length === 1 && normalizeLetter(value, language) !== "";
}

export function isRtlLanguage(language: PuzzleLanguage): boolean {
  return ALPHABET_CONFIGS[language].rtl === true;
}

export function isCrissCrossOnlyLanguage(language: PuzzleLanguage): boolean {
  return ALPHABET_CONFIGS[language].crissCrossOnly === true;
}

// The shortest white-cell run that counts as an answer slot. Alphabetic
// crosswords follow the NYT floor of 3; CJK criss-cross puzzles are built from
// words that are commonly two glyphs (한글/漢字/カナ), so their slots — and the
// clue rows the constructor fills in — must include length-2 runs, or a grid of
// two-square words extracts to zero slots and can't be clued.
export function minSlotLength(language: PuzzleLanguage): number {
  return isCrissCrossOnlyLanguage(language) ? 2 : 3;
}

// Languages that fill dense American/British lattices poorly. Russian is
// morphology-poor (few short words); CJK has a large character inventory, so two
// words almost never share a glyph at a crossing and heavy interlock is
// unsatisfiable. These default to a sparser grid with fewer crossings.
const SPARSE_FILL_LANGUAGES = new Set<PuzzleLanguage>(["ru", "zh", "ja", "ko"]);
export function prefersSparseFill(language: PuzzleLanguage): boolean {
  return SPARSE_FILL_LANGUAGES.has(language);
}

// Split text into the units that occupy one grid cell each. For most scripts a
// unit is a codepoint; for grapheme-cluster scripts (Devanagari) a unit is a
// whole akshara (base consonant + combining matra/virama), so करना → क·र·ना (3
// cells), not 4 codepoints. Uses Intl.Segmenter, available in all target
// browsers and Node ≥ 16.
export function getPuzzleUnits(value: string, language: PuzzleLanguage): string[] {
  if (ALPHABET_CONFIGS[language].graphemeClusters) {
    const segmenter = new Intl.Segmenter(language, { granularity: "grapheme" });
    return Array.from(segmenter.segment(value), (s) => s.segment);
  }
  return Array.from(value);
}
