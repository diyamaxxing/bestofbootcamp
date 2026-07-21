// ── Validate and promote pending signups (Google Form intake) ───────────────
//
// Runs on a schedule (see .github/workflows/promote-signups.yml) — reads new
// rows from the signup Google Form's linked Sheet, validates each, and
// commits accepted ones straight into this repo's own data/users.json using
// this workflow's auto-provided GITHUB_TOKEN (no cross-repo API calls
// needed anymore, the checkout already has this file).
//
// Replaces the old burnthestage/scripts/promote.js (git-pending-file based)
// now that there's no client-embedded PAT to isolate — see btsbootcamp's
// ARCHITECTURE_DECISIONS.md and issue #18 for the full "why".

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { readRows, ensureProcessedColumn, markProcessed } = require("../lib/google-sheets");

// From the signup Google Sheet's URL: docs.google.com/spreadsheets/d/{ID}/edit
const SHEET_ID = "1GoNCI68fpawvFE7_-ihk0WbelneV5JQniGYgoeRk8BM";
const SHEET_TAB_NAME = "Form Responses 1"; // Google Forms' default response-tab name

const USERS_PATH = path.join(__dirname, "..", "..", "data", "users.json");

const MEMBERS = ["RM", "Jin", "Suga", "J-Hope", "Jimin", "V", "Jungkook"];
// Must stay in sync with USERNAME_PATTERN in btsbootcamp's js/auth.js — if
// the form accepts a username this rejects, that signup silently vanishes
// (marked Processed, never promoted) instead of reaching users.json.
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;

// Structural validation only, same spirit as the pipeline this replaces —
// checks shape, not whether the content is "good."
function validate(row, existingUsernames) {
  const username = (row.username || "").trim();
  if (!username) return "missing username";
  if (!USERNAME_PATTERN.test(username)) return "invalid username format";
  if (existingUsernames.has(username.toLowerCase())) return `username "${username}" already taken`;
  if (row.favoriteMember && !MEMBERS.includes(row.favoriteMember)) return "invalid favoriteMember";
  if (row.armyType && !["new", "veteran"].includes(row.armyType)) return "invalid armyType";
  return null;
}

async function main() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set");

  const users = JSON.parse(fs.readFileSync(USERS_PATH, "utf-8"));
  const existingUsernames = new Set(users.map((u) => u.username.toLowerCase()));

  const { headers, rows, token } = await readRows(SHEET_ID, SHEET_TAB_NAME);
  if (rows.length === 0) {
    console.log("No responses yet.");
    return;
  }

  const processedCol = await ensureProcessedColumn(SHEET_ID, SHEET_TAB_NAME, headers, token);
  const pending = rows.filter((r) => !r.Processed);
  if (pending.length === 0) {
    console.log("No unprocessed rows.");
    return;
  }

  const accepted = [];
  const handledRows = [];

  for (const row of pending) {
    handledRows.push(row._row);
    const error = validate(row, existingUsernames);
    if (error) {
      console.log(`Rejected row ${row._row}: ${error}`);
      continue;
    }
    const username = row.username.trim();
    // Tracked here too, not just in the live array, so two pending rows
    // requesting the same username in one batch can't both get accepted.
    existingUsernames.add(username.toLowerCase());
    accepted.push({
      username,
      pin: row.pin ? String(row.pin).trim() : null,
      favoriteMember: row.favoriteMember || null,
      armyType: row.armyType || null,
      createdAt: new Date().toISOString().slice(0, 10),
    });
  }

  if (accepted.length > 0) {
    const updated = users.concat(accepted);
    fs.writeFileSync(USERS_PATH, JSON.stringify(updated, null, 2) + "\n");
    execSync(`git config user.name "github-actions[bot]"`);
    execSync(`git config user.email "github-actions[bot]@users.noreply.github.com"`);
    execSync(`git add "${USERS_PATH}"`);
    execSync(`git commit -m "Promote ${accepted.length} new user(s): ${accepted.map((u) => u.username).join(", ")}"`);
    execSync(`git push`);
    console.log(`Promoted ${accepted.length} user(s).`);
  } else {
    console.log("No valid submissions to promote.");
  }

  // Marks accepted AND rejected rows — a rejected row should never be
  // retried indefinitely, same reasoning as deleting rejected pending
  // files in the old pipeline.
  await markProcessed(SHEET_ID, SHEET_TAB_NAME, handledRows, processedCol, token);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
