// Student number format: S20 followed by 8 digits (e.g. S2012345678)
export const ID_REGEX = /^S20\d{8}$/;

// Tolerant matcher for raw OCR text: allows stray spaces/dashes between
// characters, which OCR commonly inserts when reading embossed or printed
// ID cards.
const FIND_REGEX = /S\s?2\s?0[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d/gi;

export function normalize(str: string): string {
  return (str || "").toUpperCase().replace(/\s+/g, "").replace(/[^A-Z0-9]/g, "");
}

export function extractCandidate(text: string): string {
  const cleaned = (text || "").toUpperCase();
  const matches = cleaned.match(FIND_REGEX);
  if (!matches || !matches.length) return "";
  return matches[0].replace(/[\s-]/g, "");
}

export function isValidId(str: string): boolean {
  return ID_REGEX.test(str || "");
}
