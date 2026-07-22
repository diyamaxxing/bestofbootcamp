// ── GA4 Data API access for a GitHub Actions workflow, no npm dependencies ──
//
// Same hand-rolled service-account JWT auth as automation/lib/google-sheets.js
// (standard OAuth2 service-account bearer flow, RFC 7523), kept as its own
// file rather than a shared refactor of google-sheets.js — one small
// self-contained lib per Google API surface, and this way the live
// comments/signups pipeline's code path is untouched.
//
// Reuses the same GOOGLE_SERVICE_ACCOUNT_KEY secret as google-sheets.js — a
// service-account JWT's scope is set per token request, so the same key can
// mint tokens for Sheets and for the Analytics Data API. The service account
// additionally needs Viewer access on the GA4 property (GA4 Admin > Property
// Access Management) and the "Google Analytics Data API" enabled in the
// owning GCP project — neither of those is something this code can do.

const crypto = require("crypto");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DATA_API = "https://analyticsdata.googleapis.com/v1beta";
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

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

// Runs a GA4 Data API report. `body` is the raw runReport request body
// (dimensions/metrics/dateRanges/dimensionFilter/limit) — passed through
// as-is so callers stay in control of exactly what they're querying.
async function runReport(propertyId, body) {
  const token = await getAccessToken();
  const res = await fetch(`${DATA_API}/properties/${propertyId}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GA4 runReport failed: ${await res.text()}`);
  return res.json();
}

module.exports = { runReport };
