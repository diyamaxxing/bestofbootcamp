// ── Refresh data/engagement.json from real GA4 on-site click events ─────────
//
// Runs on a schedule (see .github/workflows/fetch-engagement.yml) — queries
// the GA4 Data API for "video_click" custom events (fired by btsbootcamp's
// lib/analytics/logEvent.ts, from components/Card.tsx on every video-card
// click across home/browse/player) grouped by the video_id custom-event
// parameter, and writes the result here. Mirrors automation/trending/
// fetch-trending.js almost exactly — same GA4 property, same auth lib,
// same output shape — but reads on-site clicks instead of pageviews.
//
// Requires a one-time manual step this code can't do itself: video_id must
// be registered as a GA4 event-scoped custom dimension (GA4 Admin > Custom
// definitions) before customEvent:video_id is queryable via the Data API.
// Until that's done, this script runs successfully but returns zero rows —
// same "thin/missing data" shape btsbootcamp's scoring layer already
// expects (see lib/scoring/ and ARCHITECTURE_DECISIONS.md there), not a
// crash.
//
// Read-only against GA4, not part of the Google-Form write pipeline
// (comments/signups) and doesn't touch a Sheet at all.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { runReport } = require("../lib/google-analytics");

// Same GA4 property as automation/trending/fetch-trending.js (GA4 Admin >
// Property Settings > Property ID, not the G-XXXX Measurement ID).
const GA4_PROPERTY_ID = "546573007";

const WINDOW_DAYS = 7;
const ENGAGEMENT_PATH = path.join(__dirname, "..", "..", "data", "engagement.json");

// Matches VIDEO_ID_PATTERN in automation/comments/promote.js and
// automation/trending/fetch-trending.js.
const VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

async function main() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set");

  const report = await runReport(GA4_PROPERTY_ID, {
    dimensions: [{ name: "eventName" }, { name: "customEvent:video_id" }],
    metrics: [{ name: "eventCount" }],
    dateRanges: [{ startDate: `${WINDOW_DAYS}daysAgo`, endDate: "today" }],
    dimensionFilter: {
      filter: { fieldName: "eventName", stringFilter: { matchType: "EXACT", value: "video_click" } },
    },
    limit: 10000,
  });

  const videos = {};
  for (const row of report.rows || []) {
    const id = row.dimensionValues[1].value;
    if (!id || !VIDEO_ID_PATTERN.test(id)) continue;
    const clicks = parseInt(row.metricValues[0].value, 10) || 0;
    videos[id] = (videos[id] || 0) + clicks;
  }

  const output = {
    generated_at: new Date().toISOString(),
    window_days: WINDOW_DAYS,
    videos,
  };
  const serialized = JSON.stringify(output, null, 2) + "\n";

  const previous = fs.existsSync(ENGAGEMENT_PATH) ? fs.readFileSync(ENGAGEMENT_PATH, "utf-8") : null;
  // Compare video counts only, not generated_at, so an unchanged report
  // doesn't produce a commit every 6 hours.
  const previousVideos = previous ? JSON.stringify(JSON.parse(previous).videos) : null;
  if (previousVideos === JSON.stringify(videos)) {
    console.log("No change in engagement data.");
    return;
  }

  fs.writeFileSync(ENGAGEMENT_PATH, serialized);
  execSync(`git config user.name "github-actions[bot]"`);
  execSync(`git config user.email "github-actions[bot]@users.noreply.github.com"`);
  execSync(`git add "${ENGAGEMENT_PATH}"`);
  execSync(`git commit -m "Refresh engagement.json (${Object.keys(videos).length} videos)"`);
  execSync(`git push`);
  console.log(`Wrote engagement.json with ${Object.keys(videos).length} videos.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
