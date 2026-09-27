// Checks every site in sites.json, appends the result to its history and
// rewrites data/summary.json, which the dashboard reads.
//
// No dependencies: run with `node scripts/check.mjs` (Node 20+).
// In GitHub Actions it also opens an issue when a site goes down and closes
// it on recovery (see github.mjs).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import tls from "node:tls";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { alertsEnabled, openIssues, syncIssue } from "./github.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITES_FILE = process.env.SITES_FILE || path.join(ROOT, "sites.json");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const HISTORY_DIR = path.join(DATA_DIR, "history");

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_DEGRADED_MS = 5000;
const HISTORY_DAYS = 30;
const RECENT_POINTS = 60;
const DAY = 24 * 60 * 60 * 1000;
const USER_AGENT = "Mozilla/5.0 (compatible; SiteUptimeMonitor/1.0; +https://github.com/)";

export function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function statusMatches(code, expect) {
  if (expect == null) return code >= 200 && code < 400;
  const list = Array.isArray(expect) ? expect : [expect];
  return list.includes(code);
}

async function httpCheck(site) {
  const timeout = site.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const start = performance.now();
  try {
    const res = await fetch(site.url, {
      method: site.method || "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, accept: "text/html,*/*" },
    });
    // Include the body download in the timing, and keyword checks need it anyway.
    const body = await res.text();
    const ms = Math.round(performance.now() - start);
    if (!statusMatches(res.status, site.expectStatus)) {
      return { ok: false, code: res.status, ms, error: `HTTP ${res.status}` };
    }
    if (site.keyword && !body.includes(site.keyword)) {
      return { ok: false, code: res.status, ms, error: `Keyword "${site.keyword}" not found` };
    }
    return { ok: true, code: res.status, ms, error: null };
  } catch (err) {
    const ms = Math.round(performance.now() - start);
    const error = err.name === "AbortError"
      ? `Timed out after ${timeout / 1000}s`
      : (err.cause?.code || err.cause?.message || err.message);
    return { ok: false, code: 0, ms, error };
  } finally {
    clearTimeout(timer);
  }
}

function sslExpiry(url) {
  const { protocol, hostname, port } = new URL(url);
  if (protocol !== "https:") return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host: hostname, port: Number(port) || 443, servername: hostname, rejectUnauthorized: false, timeout: 10000 },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        resolve(cert?.valid_to ? new Date(cert.valid_to).toISOString() : null);
      },
    );
    socket.on("error", () => resolve(null));
    socket.on("timeout", () => { socket.destroy(); resolve(null); });
  });
}

async function checkSite(site) {
  let result = await httpCheck(site);
  // Retry once before calling a site down, to avoid alerts on a single blip.
  if (!result.ok) {
    await new Promise((r) => setTimeout(r, 3000));
    result = await httpCheck(site);
  }
  const sslExpires = await sslExpiry(site.url);
  return { ...result, sslExpires };
}

async function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

function uptime(history, since) {
  const window = history.filter(([t]) => t >= since);
  if (!window.length) return null;
  const up = window.filter(([, ok]) => ok).length;
  return Math.round((up / window.length) * 10000) / 100;
}

function average(values) {
  return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
}

// ---- GitHub issue alerts -------------------------------------------------

const ALERT_LABEL = "downtime";

async function syncAlerts(results) {
  if (!alertsEnabled) return;
  try {
    const open = await openIssues(ALERT_LABEL);
    for (const site of results) {
      await syncIssue(open, {
        title: `🔴 ${site.name} is down`,
        label: ALERT_LABEL,
        active: site.status === "down",
        body: `**${site.url}** failed its uptime check.\n\n- Error: ${site.error}\n- HTTP code: ${site.code || "none"}\n- Response time: ${site.ms} ms\n- Detected: ${site.lastChecked}\n\nThis issue closes automatically when the site is back up.`,
        resolvedComment: `✅ **${site.name}** is back up (HTTP ${site.code}, ${site.ms} ms) as of ${site.lastChecked}.`,
      });
    }
  } catch (err) {
    // Alerting must never stop the data from being saved.
    console.error(`Alert sync failed: ${err.message}`);
  }
}

// ---- main ----------------------------------------------------------------

async function main() {
  const sites = JSON.parse(await readFile(SITES_FILE, "utf8"));
  await mkdir(HISTORY_DIR, { recursive: true });
  const previous = await readJson(path.join(DATA_DIR, "summary.json"), { sites: [] });
  const now = Date.now();

  const results = await Promise.all(sites.map(async (site) => {
    const slug = slugify(site.name);
    const check = await checkSite(site);
    const historyFile = path.join(HISTORY_DIR, `${slug}.json`);

    // History rows are compact tuples: [timestamp, ok (1|0), ms, http code]
    const history = (await readJson(historyFile, []))
      .filter(([t]) => t >= now - HISTORY_DAYS * DAY);
    history.push([now, check.ok ? 1 : 0, check.ms, check.code]);
    await writeFile(historyFile, JSON.stringify(history));

    const degradedMs = site.degradedMs ?? DEFAULT_DEGRADED_MS;
    const status = !check.ok ? "down" : check.ms > degradedMs ? "slow" : "up";
    const prev = previous.sites.find((s) => s.slug === slug);
    const since = prev && (prev.status === "down") === (status === "down") ? prev.since : new Date(now).toISOString();
    const sslDaysLeft = check.sslExpires
      ? Math.floor((new Date(check.sslExpires).getTime() - now) / DAY)
      : null;

    return {
      name: site.name,
      url: site.url,
      group: site.group || "Sites",
      slug,
      status,
      code: check.code,
      ms: check.ms,
      error: check.error,
      lastChecked: new Date(now).toISOString(),
      since,
      uptime: {
        day: uptime(history, now - DAY),
        week: uptime(history, now - 7 * DAY),
        month: uptime(history, now - 30 * DAY),
      },
      avgMs: average(history.filter(([t, ok]) => ok && t >= now - DAY).map(([, , ms]) => ms)),
      sslExpires: check.sslExpires,
      sslDaysLeft,
      recent: history.slice(-RECENT_POINTS).map(([t, ok, ms]) => [t, ok, ms]),
    };
  }));

  await writeFile(
    path.join(DATA_DIR, "summary.json"),
    JSON.stringify({ generatedAt: new Date(now).toISOString(), sites: results }, null, 2),
  );

  for (const r of results) {
    console.log(`${r.status.toUpperCase().padEnd(4)} ${r.name.padEnd(30)} ${String(r.code).padEnd(4)} ${r.ms}ms${r.error ? `  (${r.error})` : ""}`);
  }

  await syncAlerts(results);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
