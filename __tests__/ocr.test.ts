/**
 * Recognition is a single server call. These cover the parts that live
 * on the client: flattening the response, pulling the number out of it,
 * and failing usefully when there's no signal.
 */
jest.mock("@/lib/api", () => ({ authFetch: jest.fn() }));
jest.mock("@/lib/sync", () => ({ isOnline: jest.fn(async () => true) }));

import { authFetch } from "@/lib/api";
import { candidateFromOcr, candidateFromText, recognizeStudentNumber } from "@/lib/ocr";
import { isOnline } from "@/lib/sync";

const mockFetch = authFetch as jest.Mock;
const mockOnline = isOnline as jest.Mock;

const INPUT = { base64: "AAAA" };
const NUMBER = "S2025101493";

beforeEach(() => {
  mockOnline.mockResolvedValue(true);
  mockFetch.mockResolvedValue({ text: "" });
});

describe("recognizeStudentNumber", () => {
  it("reads the number out of a plain-text response", async () => {
    mockFetch.mockResolvedValue({ text: `EARL JOSEPH C. DICTADO\n${NUMBER}\nBSIT` });

    await expect(recognizeStudentNumber(INPUT)).resolves.toMatchObject({
      studentNumber: NUMBER,
      repaired: false,
      failure: null,
    });
  });

  it("reads the number out of the per-word response shape", async () => {
    mockFetch.mockResolvedValue({
      lines: [{ Words: [{ WordText: "DICTADO" }, { WordText: NUMBER }] }],
    });

    await expect(recognizeStudentNumber(INPUT)).resolves.toMatchObject({
      studentNumber: NUMBER,
    });
  });

  /**
   * Recognition is the one action in this app that needs the network.
   * Failing fast with an instruction beats spending the whole upload
   * timeout to arrive at the same place.
   */
  it("fails immediately when offline instead of uploading", async () => {
    mockOnline.mockResolvedValue(false);

    const result = await recognizeStudentNumber(INPUT);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.studentNumber).toBe("");
    expect(result.failure).toMatch(/offline/i);
    expect(result.failure).toMatch(/manual tab/i);
  });

  it("reports a readable failure when the card yields no number", async () => {
    mockFetch.mockResolvedValue({ text: "FAITH COLLEGES TERTIARY SCHOOL" });

    const result = await recognizeStudentNumber(INPUT);

    expect(result.studentNumber).toBe("");
    expect(result.failure).toMatch(/manual tab/i);
  });

  it("flags a read that needed confusable characters corrected", async () => {
    // The officer confirms every number before logging, so a repaired
    // read is useful — but only if the UI can say it was a repair.
    mockFetch.mockResolvedValue({ text: "S2O251O1493" });

    await expect(recognizeStudentNumber(INPUT)).resolves.toMatchObject({
      studentNumber: NUMBER,
      repaired: true,
    });
  });

  it("surfaces the engine the server reports, for diagnostics", async () => {
    mockFetch.mockResolvedValue({ text: NUMBER, engine: "primary" });

    await expect(recognizeStudentNumber(INPUT)).resolves.toMatchObject({ engine: "primary" });
  });

  it("does not upload when the capture produced no image data", async () => {
    const result = await recognizeStudentNumber({ base64: "" });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.failure).toBeTruthy();
  });
});

describe("response flattening", () => {
  it("combines text and per-word lines before extracting", () => {
    expect(
      candidateFromOcr({
        text: "FAITH COLLEGES",
        lines: [{ Words: [{ WordText: NUMBER }] }],
      }).value
    ).toBe(NUMBER);
  });

  /**
   * The card carries other digits — "SY 2026-2027" runs down the green
   * sidebar — and it even starts with an S. It must never be mistaken
   * for a student number.
   */
  it("ignores the school-year text on the card sidebar", () => {
    expect(candidateFromOcr({ text: "TERTIARY SCHOOL SY 2026-2027" }).value).toBe("");
  });

  it("finds the number despite the sidebar being present", () => {
    expect(
      candidateFromOcr({ text: `TERTIARY SCHOOL\nSY 2026-2027\n${NUMBER}\nBSIT` }).value
    ).toBe(NUMBER);
  });

  it("handles an empty or malformed response without throwing", () => {
    expect(candidateFromOcr({}).value).toBe("");
    expect(candidateFromOcr({ lines: undefined, text: undefined }).value).toBe("");
    expect(candidateFromText("").value).toBe("");
  });
});
