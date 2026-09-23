#!/usr/bin/env node
/**
 * Generates login credentials for the student officers listed in a CSV.
 *
 *   node scripts/generate-officer-credentials.js [--in lib/Officers.csv]
 *                                                [--out credentials-out]
 *                                                [--dry-run]
 *
 * Produces two files in the output directory (which is gitignored — see
 * the note on secrets below):
 *
 *   officers-seed.json        For the server admin to import. Carries the
 *                             studentNumber/course/yearLevel the app needs
 *                             in order to enforce the same-cohort rule.
 *   officers-credentials.csv  One row per officer, for handing out.
 *
 * SECRETS: the generated passwords are plaintext and must never be
 * committed, pasted into chat, or emailed as a group. The output
 * directory is gitignored, this script never prints a password to stdout,
 * and the intent is that the server stores only a hash — delete the
 * distribution sheet once the passwords have been handed over.
 *
 * Re-running generates NEW passwords for everyone. To add officers later,
 * trim the input CSV to just the new people.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// --- CSV --------------------------------------------------------------

/**
 * Minimal RFC 4180 reader. Hand-rolled rather than pulled from npm
 * because officer names are stored as `"Surname, Given"` — a naive
 * split(",") shears every record in the file.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  // Strip a UTF-8 BOM; Excel writes one and it corrupts the first header.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim() !== ""));
  return body.map((cells) =>
    Object.fromEntries(header.map((h, i) => [h.trim(), (cells[i] ?? "").trim()]))
  );
}

function csvCell(value) {
  const s = value == null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// --- usernames --------------------------------------------------------

function deaccent(s) {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

function slug(s) {
  return deaccent(s).toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * First initial + surname, matching the `e.g. amabini` hint already on
 * the login screen. Names arrive as `Surname, Given Middle`.
 */
function splitName(fullName) {
  const [surnamePart, givenPart = ""] = fullName.split(",");
  return { surname: surnamePart.trim(), given: givenPart.trim() };
}

function baseUsername({ surname, given }) {
  const initial = slug(given).slice(0, 1);
  return `${initial}${slug(surname)}`;
}

/**
 * Resolves collisions deterministically: first by adding the next given
 * name's initial, then by a numeric suffix. This list happens to be
 * collision-free today, but officers turn over every year.
 */
function assignUsernames(officers) {
  const taken = new Set();
  return officers.map((o) => {
    const parts = o.given.split(/\s+/).filter(Boolean);
    const candidates = [baseUsername(o)];
    for (let i = 1; i < parts.length; i++) {
      candidates.push(slug(parts[0]).slice(0, 1) + slug(parts[i]).slice(0, 1) + slug(o.surname));
    }
    let chosen = candidates.find((c) => c && !taken.has(c));
    if (!chosen) {
      const base = candidates[0] || slug(o.surname) || "officer";
      let n = 2;
      while (taken.has(`${base}${n}`)) n++;
      chosen = `${base}${n}`;
    }
    taken.add(chosen);
    return { ...o, username: chosen };
  });
}

// --- passwords --------------------------------------------------------

// Confusable characters removed (0/O/o, 1/l/I) because these get read off
// a printed sheet and typed into a phone under time pressure.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

const PASSWORD_LENGTH = 8;

/** 8 characters from a 56-symbol alphabet is ~46 bits of entropy. */
function generatePassword() {
  return Array.from(
    { length: PASSWORD_LENGTH },
    // randomInt is uniform and CSPRNG-backed; Math.random is neither and
    // must never be used for a credential.
    () => ALPHABET[crypto.randomInt(0, ALPHABET.length)]
  ).join("");
}

// --- main -------------------------------------------------------------

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function main() {
  const inPath = path.resolve(arg("in", "lib/Officers.csv"));
  const outDir = path.resolve(arg("out", "credentials-out"));
  const dryRun = process.argv.includes("--dry-run");

  if (!fs.existsSync(inPath)) {
    console.error(`Input not found: ${inPath}`);
    process.exit(1);
  }

  const raw = parseCsv(fs.readFileSync(inPath, "utf8"));
  const officers = raw
    .filter((r) => (r.StudentNo || "").trim())
    .map((r) => {
      const { surname, given } = splitName(r["Student Name"] || "");
      return {
        studentNumber: r.StudentNo.trim(),
        name: `${given} ${surname}`.trim(),
        surname,
        given,
        course: (r.Course || "").trim(),
        yearLevel: (r["Year Level"] || "").trim(),
      };
    });

  // Fail loudly rather than issuing a credential the cohort rule can't
  // reason about: an officer with no course/year could scan anyone.
  const incomplete = officers.filter((o) => !o.course || !o.yearLevel);
  if (incomplete.length) {
    console.error("These officers are missing a course or year level:");
    for (const o of incomplete) console.error(`  ${o.studentNumber}  ${o.name}`);
    console.error("\nThe same-cohort restriction cannot be enforced for them. Fix the CSV.");
    process.exit(1);
  }

  const duplicateIds = officers
    .map((o) => o.studentNumber)
    .filter((sn, i, all) => all.indexOf(sn) !== i);
  if (duplicateIds.length) {
    console.error(`Duplicate student numbers in the input: ${[...new Set(duplicateIds)].join(", ")}`);
    process.exit(1);
  }

  const withUsernames = assignUsernames(officers);
  const records = withUsernames.map((o) => ({
    username: o.username,
    name: o.name,
    studentNumber: o.studentNumber,
    course: o.course,
    yearLevel: o.yearLevel,
    role: "officer",
    password: generatePassword(),
  }));

  console.log(`Read ${records.length} officers from ${path.relative(process.cwd(), inPath)}`);
  console.log(`Usernames: ${new Set(records.map((r) => r.username)).size} unique\n`);
  // Passwords are deliberately absent from this listing.
  for (const r of records) {
    console.log(`  ${r.username.padEnd(16)} ${r.studentNumber}  ${r.course.padEnd(6)} ${r.yearLevel.padEnd(9)} ${r.name}`);
  }

  if (dryRun) {
    console.log("\n--dry-run: no files written, no passwords generated for output.");
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });

  const seedPath = path.join(outDir, "officers-seed.json");
  fs.writeFileSync(
    seedPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note:
          "Import into the FACTS server. Store only a password hash. " +
          "The server must return username, name, role, studentNumber, course and " +
          "yearLevel from /api/auth/login and /api/auth/session so the app can " +
          "enforce the same-cohort restriction — and must enforce that rule " +
          "server-side as well, since the client check is advisory.",
        officers: records,
      },
      null,
      2
    ) + "\n",
    { mode: 0o600 }
  );

  const sheetPath = path.join(outDir, "officers-credentials.csv");
  const lines = ["Name,Student No,Course,Year Level,Username,Password"];
  for (const r of records) {
    lines.push(
      [r.name, r.studentNumber, r.course, r.yearLevel, r.username, r.password]
        .map(csvCell)
        .join(",")
    );
  }
  fs.writeFileSync(sheetPath, lines.join("\n") + "\n", { mode: 0o600 });

  // The in-app copy, written from the same records so the bundled
  // accounts and the server seed can never drift apart.
  const devAccountsPath = path.resolve("lib/dev-accounts.ts");
  fs.writeFileSync(devAccountsPath, renderDevAccounts(records));

  const rel = (p) => path.relative(process.cwd(), p);
  console.log(`\nWrote ${rel(seedPath)}`);
  console.log(`Wrote ${rel(sheetPath)}`);
  console.log(`Wrote ${rel(devAccountsPath)}  <- bundled into the app`);
  console.log(
    "\nThe files in " +
      path.basename(outDir) +
      "/ hold plaintext passwords and are gitignored.\n" +
      "lib/dev-accounts.ts is NOT — it has to be committed to be bundled.\n" +
      "Delete it and the OFFLINE_AUTH block in lib/auth.ts once the server is seeded."
  );
}

/** Emits lib/dev-accounts.ts. */
function renderDevAccounts(records) {
  const rows = records
    .map(
      (r) =>
        "  " +
        JSON.stringify({
          username: r.username,
          password: r.password,
          id: `local-${r.studentNumber}`,
          name: r.name,
          role: r.role,
          studentNumber: r.studentNumber,
          course: r.course,
          yearLevel: r.yearLevel,
        }) +
        ","
    )
    .join("\n");

  return `// GENERATED by scripts/generate-officer-credentials.js — do not edit by hand.
//
// TEMPORARY. These are real officer credentials in plaintext, compiled
// into the app bundle. A bundle is not a secret: anyone with the .ipa or
// .apk can read every password here. This exists only so the app can be
// used before the backend has the accounts.
//
// Sign-in falls back to this table ONLY when the server cannot be
// reached, so it retires itself the moment the real API answers.
//
// TO REMOVE: delete this file and the offline-auth block in lib/auth.ts,
// then rotate every password below.
//
// Generated ${new Date().toISOString()}

export interface DevAccount {
  username: string;
  password: string;
  id: string;
  name: string;
  role: string;
  studentNumber: string;
  course: string;
  yearLevel: string;
}

/**
 * Built-in sign-in is on in development, and off in a release build
 * unless EXPO_PUBLIC_OFFLINE_AUTH=1 is set at build time. That default
 * is what stops these credentials reaching the App Store by accident.
 */
export const OFFLINE_AUTH_ENABLED: boolean =
  __DEV__ || process.env.EXPO_PUBLIC_OFFLINE_AUTH === "1";

// The condition is repeated inline rather than read from OFFLINE_AUTH_ENABLED
// so the minifier can fold it and drop the table from a release build.
// Gating only its use, as before, still shipped every password.
export const DEV_ACCOUNTS: DevAccount[] =
  __DEV__ || process.env.EXPO_PUBLIC_OFFLINE_AUTH === "1"
    ? [
${rows}
      ]
    : [];

/** Case-insensitive on the username, exact on the password. */
export function findDevAccount(username: string, password: string): DevAccount | null {
  const u = (username || "").trim().toLowerCase();
  return (
    DEV_ACCOUNTS.find((a) => a.username.toLowerCase() === u && a.password === password) ?? null
  );
}
`;
}

main();
