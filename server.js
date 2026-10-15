// net-switch: a tiny proxy that lets a parent pause/resume one Firewalla
// "block internet" rule through the Firewalla MSP API.
// No dependencies; Node 20+ (global fetch).

import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const env = (k, d) => process.env[k] ?? d;
const MSP_DOMAIN = env("MSP_DOMAIN");          // e.g. yourname.firewalla.net
const MSP_TOKEN = env("MSP_TOKEN");            // personal access token
const RULE_ID = env("RULE_ID");                // the "block internet" rule
const DEVICE_LABEL = env("DEVICE_LABEL", "");  // shown in the UI, e.g. "Ana's phone"
const BEDTIME = env("BEDTIME", "21:00");       // local HH:MM for the "until bedtime" button
const TZ = env("TZ", "America/Sao_Paulo");
const PORT = Number(env("PORT", "8080"));
const USER_HEADER = env("USER_HEADER", "x-token-user-email").toLowerCase(); // set by Caddy, for logs only
const MAX_PAUSE_MIN = 1440;                    // Firewalla limit (24h)

for (const [k, v] of Object.entries({ MSP_DOMAIN, MSP_TOKEN, RULE_ID })) {
  if (!v) { console.error(`Missing required env var ${k}`); process.exit(1); }
}

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");
const MSP = env("MSP_BASE_URL", `https://${MSP_DOMAIN}/v2`); // override only for testing
const authHeaders = { Authorization: `Token ${MSP_TOKEN}` };

async function msp(path, init = {}) {
  const res = await fetch(`${MSP}${path}`, {
    ...init,
    headers: { ...authHeaders, ...(init.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`MSP ${res.status}: ${text.slice(0, 200)}`), { status: res.status });
  return text ? JSON.parse(text) : null;
}

async function getRule() {
  // Filter server-side by id when supported; always confirm the match here.
  const data = await msp(`/rules?query=${encodeURIComponent(`id:${RULE_ID}`)}`);
  let rule = data?.results?.find(r => r.id === RULE_ID);
  if (!rule) {
    const all = await msp(`/rules`);
    rule = all?.results?.find(r => r.id === RULE_ID);
  }
  if (!rule) throw Object.assign(new Error("Rule not found — check RULE_ID"), { status: 404 });
  return rule;
}

// Internet is ON when the block rule is paused, OFF when it is active.
function toState(rule) {
  const nowS = Date.now() / 1000;
  const resumeTs = typeof rule.resumeTs === "number" ? rule.resumeTs : null;
  const paused = rule.status === "paused" || (resumeTs !== null && resumeTs > nowS && rule.status !== "active");
  return {
    internet: paused ? "on" : "off",
    until: paused && resumeTs ? new Date(resumeTs * 1000).toISOString() : null,
    device: DEVICE_LABEL,
    bedtime: BEDTIME,
  };
}

// Minutes from now until the next HH:MM in TZ (at least 1, at most 1440).
function minutesUntil(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  const now = Number(parts.hour) * 60 + Number(parts.minute);
  let diff = h * 60 + m - now;
  if (diff <= 0) diff += 1440;
  return Math.min(Math.max(diff, 1), MAX_PAUSE_MIN);
}

async function allow(minutes) {
  await msp(`/rules/${RULE_ID}/pause`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ duration: minutes }),
  });
}

async function block() {
  await msp(`/rules/${RULE_ID}/resume`, { method: "POST" });
}

// ---------- HTTP ----------

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".webmanifest": "application/manifest+json" };
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  res.writeHead(status, { ...SECURITY_HEADERS, "Cache-Control": "no-store",
    ...(isJson ? { "Content-Type": "application/json" } : {}), ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 1024) throw new Error("too large"); }
  return raw ? JSON.parse(raw) : {};
}

// Same-origin check for state-changing requests (defence in depth behind the OIDC gate).
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return req.headers["sec-fetch-site"] === "same-origin";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  try { return new URL(origin).host === host; } catch { return false; }
}

const who = req => req.headers[USER_HEADER] || "unknown";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/healthz") return send(res, 200, "ok", { "Content-Type": "text/plain" });

    if (url.pathname === "/api/status" && req.method === "GET") {
      return send(res, 200, toState(await getRule()));
    }

    if (url.pathname === "/api/internet" && req.method === "POST") {
      if (!sameOrigin(req)) return send(res, 403, { error: "bad origin" });
      const body = await readJson(req);
      if (body.state === "off") {
        await block();
        console.log(`${new Date().toISOString()} ${who(req)} turned internet OFF`);
      } else if (body.state === "on") {
        let minutes;
        if (body.until === "bedtime") minutes = minutesUntil(BEDTIME);
        else minutes = Math.round(Number(body.minutes));
        if (!Number.isFinite(minutes) || minutes < 1) return send(res, 400, { error: "bad duration" });
        minutes = Math.min(minutes, MAX_PAUSE_MIN);
        // Re-pausing an already paused rule may not extend it, so resume first.
        const current = await getRule();
        if (toState(current).internet === "on") await block();
        await allow(minutes);
        console.log(`${new Date().toISOString()} ${who(req)} turned internet ON for ${minutes} min`);
      } else {
        return send(res, 400, { error: "state must be on or off" });
      }
      return send(res, 200, toState(await getRule()));
    }

    if (req.method === "GET") {
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      if (path.includes("..")) return send(res, 400, "bad path", { "Content-Type": "text/plain" });
      const ext = path.slice(path.lastIndexOf("."));
      try {
        const file = await readFile(join(PUBLIC_DIR, path));
        return send(res, 200, file, { "Content-Type": MIME[ext] || "application/octet-stream",
          "Cache-Control": path === "/index.html" ? "no-cache" : "public, max-age=3600" });
      } catch { /* fall through */ }
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err.message);
    send(res, err.status === 404 ? 404 : 502, { error: err.message });
  }
});

server.listen(PORT, () => console.log(`net-switch listening on :${PORT} (rule ${RULE_ID})`));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
