// Student number format: S20 followed by 8 digits (e.g. S2012345678)
export const ID_REGEX = /^S20\d{8}$/;

/** Length of a complete student number. */
const ID_LENGTH = 11;

// Characters OCR commonly inserts between glyphs when reading an
// embossed or laser-etched card, plus the punctuation that shows up when
// a label runs into the number ("ID NO.:S20...").
const SEPARATORS = /[\s\-._:,;|/\\·•]/g;

/**
 * Letters an OCR engine routinely emits where a digit was printed.
 *
 * Deliberately conservative — only the confusions that are near-universal
 * across engines. Adding speculative ones (A/4, T/7, C/6) buys a few
 * more reads at the cost of inventing student numbers out of ordinary
 * words, which is much worse: a wrong number logs the wrong person.
 */
const LETTER_TO_DIGIT: Record<string, string> = {
  O: "0",
  Q: "0",
  I: "1",
  L: "1",
  Z: "2",
  S: "5",
  G: "6",
  B: "8",
};

/** Glyphs that can stand in for the leading "S". */
const S_LOOKALIKES = new Set(["S", "5", "$"]);

function digitAt(char: string, { strict }: { strict: boolean }): string | null {
  if (char >= "0" && char <= "9") return char;
  if (strict) return null;
  return LETTER_TO_DIGIT[char] ?? null;
}

export interface ExtractionResult {
  /** Canonical S20XXXXXXXX, or "" when nothing matched. */
  value: string;
  /**
   * True when a confusable character had to be corrected to produce the
   * match. The number is plausible but less certain, so the UI asks the
   * officer to look twice before logging it.
   */
  repaired: boolean;
}

const NO_MATCH: ExtractionResult = { value: "", repaired: false };

export function normalize(str: string): string {
  return (str || "").toUpperCase().replace(/\s+/g, "").replace(/[^A-Z0-9]/g, "");
}

/**
 * Reads one 11-character window as a student number, repairing
 * confusable glyphs unless `strict`.
 */
function readWindow(window: string, strict: boolean): string | null {
  if (!S_LOOKALIKES.has(window[0])) return null;
  if (strict && window[0] !== "S") return null;
  if (digitAt(window[1], { strict }) !== "2") return null;
  if (digitAt(window[2], { strict }) !== "0") return null;

  let digits = "";
  for (let k = 3; k < ID_LENGTH; k++) {
    const d = digitAt(window[k], { strict });
    if (d === null) return null;
    digits += d;
  }
  return `S20${digits}`;
}

function scan(dense: string, strict: boolean): string | null {
  for (let i = 0; i + ID_LENGTH <= dense.length; i++) {
    // A digit immediately after the window means we're looking at part of
    // a longer run of numbers. Returning a truncation of it would be a
    // valid-looking number belonging to nobody, so skip rather than guess.
    const next = dense[i + ID_LENGTH];
    if (next && next >= "0" && next <= "9") continue;

    const value = readWindow(dense.slice(i, i + ID_LENGTH), strict);
    if (value) return value;
  }
  return null;
}

/**
 * Pulls a student number out of raw recognized text.
 *
 * Runs two passes. The first accepts only exact characters, so when the
 * text contains a cleanly-read number that one wins outright. Only if
 * nothing matches cleanly does the second pass allow glyph repair — so a
 * confident read is never displaced by a speculative one elsewhere on
 * the card.
 */
export function extractStudentNumber(text: string): ExtractionResult {
  if (!text) return NO_MATCH;
  const dense = text.toUpperCase().replace(SEPARATORS, "");
  if (dense.length < ID_LENGTH) return NO_MATCH;

  const exact = scan(dense, true);
  if (exact) return { value: exact, repaired: false };

  const repaired = scan(dense, false);
  return repaired ? { value: repaired, repaired: true } : NO_MATCH;
}

/** Convenience wrapper for callers that only want the number. */
export function extractCandidate(text: string): string {
  return extractStudentNumber(text).value;
}

export function isValidId(str: string): boolean {
  return ID_REGEX.test(str || "");
}
