import { authFetch } from "./api";
import { UPLOAD_TIMEOUT_MS } from "./config";
import { ExtractionResult, extractStudentNumber } from "./extract";
import { log } from "./logger";
import { isOnline } from "./sync";

/**
 * Turning a photo of a student ID into a student number.
 *
 * Recognition lives entirely on the server: the app uploads the image and
 * the server decides which engine reads it, falling back to a second one
 * internally when the first fails. The app deliberately knows nothing
 * about which engine ran — see server/ocr-fallback for that side.
 *
 * Two consequences of that split are worth being explicit about:
 *
 *  - There is no on-device recognition. With no signal the ID cannot be
 *    read at all, and manual entry is the only path. Everything else in
 *    the app works offline; this one action cannot.
 *  - A FAITH Colleges card carries no barcode, so there is nothing to
 *    decode locally either. (An earlier revision tried expo-camera's
 *    barcode reader as a local fallback; it was removed once the card
 *    turned out to be print-only, and it was QR-only on iOS regardless.)
 */

export interface OcrInput {
  /** Base64 JPEG payload of the captured photo. */
  base64: string;
}

export interface RecognitionResult {
  /** "" when nothing could be read. */
  studentNumber: string;
  /**
   * A confusable glyph had to be corrected to read this (O->0, I->1,
   * B->8 and friends). Still worth showing, but the officer should check
   * it against the card rather than trusting it outright.
   */
  repaired: boolean;
  /** Which engine the server used, when it reports one. Diagnostics only. */
  engine: string | null;
  /** User-facing reason nothing was read; null on success. */
  failure: string | null;
}

// --- response parsing -------------------------------------------------

interface OcrWord {
  WordText?: string;
}
interface OcrLine {
  Words?: OcrWord[];
}

export interface OcrResponse {
  lines?: OcrLine[];
  text?: string;
  /** Optional: which engine produced this, e.g. "primary" / "fallback". */
  engine?: string;
}

/**
 * Flattens an OCR response into one string and pulls the student number
 * out of it.
 *
 * Whole-text rather than word-by-word on purpose: extractStudentNumber
 * prefers a cleanly-read number over a repaired one, and it can only make
 * that comparison if it sees the whole card at once. A card carries other
 * digits — this one has "SY 2026-2027" down the side — so letting the
 * extractor weigh every candidate together matters.
 */
export function candidateFromOcr(data: OcrResponse): ExtractionResult {
  const lines: OcrLine[] = Array.isArray(data?.lines) ? data.lines : [];
  const joined = [
    typeof data?.text === "string" ? data.text : "",
    lines.map((l) => (l.Words || []).map((w) => w.WordText).join(" ")).join("\n"),
  ]
    .filter(Boolean)
    .join("\n");
  return extractStudentNumber(joined);
}

/** Plain recognized text goes through the same parser, so a server that
 *  returns `text` and one that returns `lines` behave identically. */
export function candidateFromText(text: string): ExtractionResult {
  return extractStudentNumber(text);
}

// --- recognition ------------------------------------------------------

const OFFLINE_MESSAGE =
  "You're offline, so the ID can't be read automatically. Type the number on the Manual tab.";

export async function recognizeStudentNumber(
  input: OcrInput,
  { signal }: { signal?: AbortSignal } = {}
): Promise<RecognitionResult> {
  const empty = { studentNumber: "", repaired: false, engine: null };

  if (!input.base64) {
    return { ...empty, failure: "Couldn't read the captured photo. Try again." };
  }

  // Checked up front so an offline scan fails in milliseconds with a
  // useful instruction, rather than after the full upload timeout.
  if (!(await isOnline())) {
    return { ...empty, failure: OFFLINE_MESSAGE };
  }

  const data = await authFetch<OcrResponse>("/api/ocr", {
    method: "POST",
    body: JSON.stringify({ imageBase64: `data:image/jpeg;base64,${input.base64}` }),
    // An image upload is far heavier than a JSON call and deserves a
    // longer budget — but still a finite one.
    timeoutMs: UPLOAD_TIMEOUT_MS,
    signal,
  });

  const engine = typeof data?.engine === "string" ? data.engine : null;
  const { value, repaired } = candidateFromOcr(data);

  if (!value) {
    log.info("ocr returned no student number", { engine });
    return {
      ...empty,
      engine,
      failure: "Couldn't find a student number on that photo. Retake it or use the Manual tab.",
    };
  }

  log.info("recognized student number", { engine, repaired });
  return { studentNumber: value, repaired, engine, failure: null };
}
