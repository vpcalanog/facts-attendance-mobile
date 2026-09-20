import { AppError, isCancelled, toAppError, userMessage } from "@/lib/errors";
import { extractCandidate, extractStudentNumber, isValidId, normalize } from "@/lib/extract";
import { fmtRelative, fmtTimestamp, isToday } from "@/lib/format";

describe("student id extraction", () => {
  it("accepts the canonical format only", () => {
    expect(isValidId("S2012345678")).toBe(true);
    expect(isValidId("S201234567")).toBe(false); // one digit short
    expect(isValidId("S2112345678")).toBe(false); // wrong prefix
    expect(isValidId("")).toBe(false);
  });

  it("recovers a number from the spacing OCR tends to insert", () => {
    expect(extractCandidate("S 2 0 1 2 3 4 5 6 7 8")).toBe("S2012345678");
    expect(extractCandidate("ID: s20-12-34-56-78 VALID")).toBe("S2012345678");
    expect(extractCandidate("no number here")).toBe("");
  });

  it("normalizes typed input to the stored form", () => {
    expect(normalize(" s20 1234-5678 ")).toBe("S2012345678");
  });
});

describe("reading S20XXXXXXXX off a card", () => {
  const NUMBER = "S2024101547";

  // OCR misreads a single glyph constantly. Before glyph repair, any one
  // of these returned nothing at all and the officer retyped all eleven
  // characters by hand.
  it.each([
    ["O read for 0", "S2O24101547"],
    ["S read for 5 in the prefix", "52024101547"],
    ["I read for 1", "S2024I0I547"],
    ["lowercase l read for 1", "S2024l0l547"],
    ["Z read for 2", "S2OZ4101547"],
    ["Q read for 0", "S2Q24101547"],
  ])("recovers a number where OCR misread a glyph: %s", (_label, raw) => {
    expect(extractStudentNumber(raw)).toEqual({ value: NUMBER, repaired: true });
  });

  it("does not claim a repair when the read was clean", () => {
    expect(extractStudentNumber(NUMBER)).toEqual({ value: NUMBER, repaired: false });
  });

  it("prefers a clean number over a repairable one elsewhere on the card", () => {
    // Otherwise a smudged line could outrank the crisply-printed number.
    expect(extractStudentNumber(`S2O24101548 ${NUMBER}`)).toEqual({
      value: NUMBER,
      repaired: false,
    });
  });

  it("finds the number embedded in surrounding card text", () => {
    expect(extractStudentNumber("STUDENT NO. S2024101547\nBSIT 3rd Year").value).toBe(NUMBER);
    expect(extractStudentNumber("IDNO:S2024101547").value).toBe(NUMBER);
  });

  it("refuses to carve a student number out of a longer digit run", () => {
    // Truncating one would produce a valid-looking number belonging to
    // nobody, which is worse than failing to read the card.
    expect(extractStudentNumber("S20241015470000").value).toBe("");
  });

  it("finds nothing in ordinary card text", () => {
    expect(extractStudentNumber("UNIVERSITY IDENTIFICATION CARD").value).toBe("");
    expect(extractStudentNumber("").value).toBe("");
  });
});

describe("timestamp formatting", () => {
  // These strings come from three clocks (this device, another device,
  // the server), so a malformed one is a real possibility. It used to
  // render as "NaNm ago" mid-log.
  it("degrades gracefully on an unparseable timestamp", () => {
    expect(fmtRelative("not a date")).toBe("unknown time");
    expect(fmtTimestamp("not a date")).toBe("—");
    expect(isToday("not a date")).toBe(false);
  });

  it("treats a future timestamp from a skewed device clock as now", () => {
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    expect(fmtRelative(future)).toBe("just now");
  });

  it("describes recent times in minutes and hours", () => {
    expect(fmtRelative(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5m ago");
    expect(fmtRelative(new Date(Date.now() - 3 * 3600_000).toISOString())).toBe("3h ago");
  });
});

describe("error taxonomy", () => {
  it("marks transport problems retryable and refusals not", () => {
    expect(new AppError("x", "network").retryable).toBe(true);
    expect(new AppError("x", "timeout").retryable).toBe(true);
    expect(new AppError("x", "server").retryable).toBe(true);
    expect(new AppError("x", "auth").retryable).toBe(false);
    expect(new AppError("x", "validation").retryable).toBe(false);
  });

  it("recognises an aborted fetch as a cancellation", () => {
    const abort = new Error("Aborted");
    abort.name = "AbortError";
    expect(isCancelled(abort)).toBe(true);
    expect(toAppError(abort).kind).toBe("cancelled");
  });

  it("reassures rather than alarms when the network is the problem", () => {
    expect(userMessage(new AppError("x", "network"))).toMatch(/saved on this device/i);
    // A validation message from the server is the useful thing to show.
    expect(userMessage(new AppError("Student not on the roster.", "validation"))).toBe(
      "Student not on the roster."
    );
  });
});
