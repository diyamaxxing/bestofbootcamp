// ── Refresh data/trending.json from real GA4 pageview data ──────────────────
//
// Runs on a schedule (see .github/workflows/fetch-trending.yml) — queries the
// GA4 Data API for pageviews per video over a rolling window and writes the
// result here. Read-only against GA4: this is not part of the Google-Form
// write pipeline (comments/signups) and doesn't touch a Sheet at all.
//
// btsbootcamp's home page fetches this file the same way it already fetches
// data/comments.json/data/users.json from this repo (see btsbootcamp's
// lib/trending.ts), and falls back to its existing byScore ranking if this
// file is missing, stale, or has too little overlap with the current
// catalog — see btsbootcamp's CLAUDE.md / plan for the full "why".

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { runReport } = require("../lib/google-analytics");

// GA4 Admin > Property Settings > Property ID. NOT the G-XXXX Measurement ID
// already wired into btsbootcamp's layout — this is the numeric Data API
// property id.
const GA4_PROPERTY_ID = "546573007";

const WINDOW_DAYS = 7;
const TRENDING_PATH = path.join(__dirname, "..", "..", "data", "trending.json");

// Matches VIDEO_ID_PATTERN in automation/comments/promote.js.
const VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

// The static-export player route is /player/ (trailingSlash: true in
// btsbootcamp's next.config.ts), so a real pageview's pagePathPlusQueryString
// looks like "/player/?id=bomb-575".
function extractVideoId(pagePathPlusQueryString) {
  const match = pagePathPlusQueryString.match(/^\/player\/\?(?:.*&)?id=([^&]+)/);
  if (!match) return null;
  const id = decodeURIComponent(match[1]);
  return VIDEO_ID_PATTERN.test(id) ? id : null;
}

async function main() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set");
  if (GA4_PROPERTY_ID.startsWith("REPLACE_")) throw new Error("GA4_PROPERTY_ID not configured");

  const report = await runReport(GA4_PROPERTY_ID, {
    dimensions: [{ name: "pagePathPlusQueryString" }],
    metrics: [{ name: "screenPageViews" }],
    dateRanges: [{ startDate: `${WINDOW_DAYS}daysAgo`, endDate: "today" }],
    dimensionFilter: {
      filter: {
        fieldName: "pagePathPlusQueryString",
        stringFilter: { matchType: "BEGINS_WITH", value: "/player/?id=" },
      },
    },
    limit: 10000,
  });

  const videos = {};
  for (const row of report.rows || []) {
    const id = extractVideoId(row.dimensionValues[0].value);
    if (!id) continue;
    const views = parseInt(row.metricValues[0].value, 10) || 0;
    videos[id] = (videos[id] || 0) + views;
  }

  const output = {
    generated_at: new Date().toISOString(),
    window_days: WINDOW_DAYS,
    videos,
  };
  const serialized = JSON.stringify(output, null, 2) + "\n";

  const previous = fs.existsSync(TRENDING_PATH) ? fs.readFileSync(TRENDING_PATH, "utf-8") : null;
  // Compare video counts only, not generated_at, so an unchanged report
  // doesn't produce a commit every 6 hours.
  const previousVideos = previous ? JSON.stringify(JSON.parse(previous).videos) : null;
  if (previousVideos === JSON.stringify(videos)) {
    console.log("No change in trending data.");
    return;
  }

  fs.writeFileSync(TRENDING_PATH, serialized);
  execSync(`git config user.name "github-actions[bot]"`);
  execSync(`git config user.email "github-actions[bot]@users.noreply.github.com"`);
  execSync(`git add "${TRENDING_PATH}"`);
  execSync(`git commit -m "Refresh trending.json (${Object.keys(videos).length} videos)"`);
  execSync(`git push`);
  console.log(`Wrote trending.json with ${Object.keys(videos).length} videos.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
