// ── Validate and promote pending comments (Google Form intake) ──────────────
//
// Runs on a schedule (see .github/workflows/promote-comments.yml) — reads
// new rows from the comment Google Form's linked Sheet, validates each
// (including cross-checking the username against a real profile, now a
// plain local read of this same repo's data/users.json), and commits
// accepted ones into data/comments.json.
//
// Replaces the old campcomments/scripts/promote.js — see btsbootcamp's
// ARCHITECTURE_DECISIONS.md and issue #18 for the full "why".

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { readRows, ensureProcessedColumn, markProcessed } = require("../lib/google-sheets");

// From the comment Google Sheet's URL: docs.google.com/spreadsheets/d/{ID}/edit
const SHEET_ID = "1zgE_xHB4XiHhrDuF-oTBFyec3Iu9sYn6bsUFjZX8A1g";
const SHEET_TAB_NAME = "Form Responses 1";

const USERS_PATH = path.join(__dirname, "..", "..", "data", "users.json");
const COMMENTS_PATH = path.join(__dirname, "..", "..", "data", "comments.json");

// Must stay in sync with MAX_COMMENT_LENGTH in btsbootcamp's js/comments.js.
const MAX_COMMENT_LENGTH = 2000;
const VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function validate(row, knownUsernames) {
  const videoId = (row.video_id || "").trim();
  if (!videoId) return "missing video_id";
  if (!VIDEO_ID_PATTERN.test(videoId)) return "invalid video_id format";

  const username = (row.username || "").trim();
  if (!username) return "missing username";
  if (!knownUsernames.has(username.toLowerCase())) return `no profile for username "${username}"`;

  const comment = (row.comment || "").trim();
  if (!comment) return "missing comment";
  if (comment.length > MAX_COMMENT_LENGTH) return "comment too long";

  return null;
}

async function main() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set");

  const users = JSON.parse(fs.readFileSync(USERS_PATH, "utf-8"));
  const knownUsernames = new Set(users.map((u) => u.username.toLowerCase()));
  const comments = JSON.parse(fs.readFileSync(COMMENTS_PATH, "utf-8"));

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
  const now = new Date().toISOString();

  pending.forEach((row, i) => {
    handledRows.push(row._row);
    const error = validate(row, knownUsernames);
    if (error) {
      console.log(`Rejected row ${row._row}: ${error}`);
      return;
    }
    const videoId = row.video_id.trim();
    // comment_id assigned here, never trusted from the submission — same
    // reasoning as posted_at below.
    accepted.push({
      comment_id: `${videoId}-${Date.now()}-${i}`,
      parent_comment_id: null,
      video_id: videoId,
      username: row.username.trim(),
      comment: row.comment.trim(),
      posted_at: now,
    });
  });

  if (accepted.length > 0) {
    const updated = comments.concat(accepted);
    fs.writeFileSync(COMMENTS_PATH, JSON.stringify(updated, null, 2) + "\n");
    execSync(`git config user.name "github-actions[bot]"`);
    execSync(`git config user.email "github-actions[bot]@users.noreply.github.com"`);
    execSync(`git add "${COMMENTS_PATH}"`);
    execSync(
      `git commit -m "Promote ${accepted.length} new comment(s) on: ${[...new Set(accepted.map((c) => c.video_id))].join(", ")}"`
    );
    execSync(`git push`);
    console.log(`Promoted ${accepted.length} comment(s).`);
  } else {
    console.log("No valid submissions to promote.");
  }

  await markProcessed(SHEET_ID, SHEET_TAB_NAME, handledRows, processedCol, token);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
