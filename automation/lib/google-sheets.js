// ── Google Sheets access for a GitHub Actions workflow, no npm dependencies ──
//
// Hand-rolled service-account JWT auth instead of googleapis/google-auth-
// library — keeps this repo's automation dependency-free, matching every
// other promote script in this project. The flow is the standard Google
// OAuth2 service-account bearer flow (RFC 7523): sign a short-lived JWT
// with the service account's private key, trade it for an access token,
// then plain fetch() calls against the Sheets API v4.
//
// GOOGLE_SERVICE_ACCOUNT_KEY (an Actions secret, never client-exposed) is
// the full JSON key downloaded when the service account was created —
// needs client_email and private_key. The corresponding Sheet must be
// shared with that client_email (Editor access) or every call here 403s.

const crypto = require("crypto");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function getAccessToken() {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const now = Math.floor(Date.now() / 1000);

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: key.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })
  );
  const signingInput = `${header}.${claims}`;
  const signature = base64url(crypto.sign("RSA-SHA256", Buffer.from(signingInput), key.private_key));
  const jwt = `${signingInput}.${signature}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

// 1-based spreadsheet column index -> letter (1 -> A, 27 -> AA, ...).
function columnLetter(n) {
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Reads every response row, keyed by the header row's exact column titles
// (which is why the Form's question titles have to match what the promote
// scripts expect). Each row also gets `_row`, its 1-based sheet row number
// (header is row 1, so the first response is row 2) — callers need this to
// address specific rows later when marking them processed. Returns the
// access token too so callers can reuse it for ensureProcessedColumn/
// markProcessed without a second auth round-trip.
async function readRows(sheetId, sheetName) {
  const token = await getAccessToken();
  const res = await fetch(`${SHEETS_API}/${sheetId}/values/${encodeURIComponent(sheetName)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Sheets read failed: ${await res.text()}`);
  const { values } = await res.json();
  if (!values || values.length === 0) return { headers: [], rows: [], token };

  const headers = values[0];
  const rows = values.slice(1).map((row, i) => {
    const obj = { _row: i + 2 };
    headers.forEach((h, idx) => {
      obj[h] = row[idx] || "";
    });
    return obj;
  });
  return { headers, rows, token };
}

// Adds a "Processed" header column if the sheet doesn't already have one
// (first run against a fresh form) — no manual sheet-editing needed as
// setup. Returns its 1-based column index either way.
async function ensureProcessedColumn(sheetId, sheetName, headers, token) {
  const existing = headers.indexOf("Processed");
  if (existing !== -1) return existing + 1;

  const colIndex = headers.length + 1;
  const colLetter = columnLetter(colIndex);
  const res = await fetch(
    `${SHEETS_API}/${sheetId}/values/${encodeURIComponent(sheetName)}!${colLetter}1?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [["Processed"]] }),
    }
  );
  if (!res.ok) throw new Error(`Failed to add Processed column: ${await res.text()}`);
  return colIndex;
}

// Marks every given 1-based row number as processed in one batch call —
// covers both accepted and rejected rows, same "never retry a handled
// submission" reasoning the old git-based promote scripts had by deleting
// pending files after processing.
async function markProcessed(sheetId, sheetName, rowNumbers, colIndex, token) {
  if (rowNumbers.length === 0) return;
  const colLetter = columnLetter(colIndex);
  const data = rowNumbers.map((r) => ({
    range: `${sheetName}!${colLetter}${r}`,
    values: [["TRUE"]],
  }));
  const res = await fetch(`${SHEETS_API}/${sheetId}/values:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ valueInputOption: "RAW", data }),
  });
  if (!res.ok) throw new Error(`Failed to mark rows processed: ${await res.text()}`);
}

module.exports = { readRows, ensureProcessedColumn, markProcessed };
