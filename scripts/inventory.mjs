// Compares the puppies each store's website shows with that store's live
// inventory in Pinogy, and writes the result to data/inventory.json.
//
// For every site in sites.json with a `pinogyLocationId`:
//   - Pinogy: available puppies with images at that location (the same filters
//     the storefront uses when it fetches from Pinogy)
//   - Site:   {site url}{inventoryPath}, default /api/puppies
// Differences are reported as missing (in Pinogy, not on the site), stale (on
// the site, not in Pinogy) and price mismatches. A difference only counts as
// "out of sync" once it has lasted GRACE_MINUTES, so normal cache delays on
// the site don't raise alarms.
//
// Requires PINOGY_API_HOST, PINOGY_ACCESS_KEY, PINOGY_SECRET, PINOGY_PASSWORD
// (optional PINOGY_APP_ID, PINOGY_VERSION, PINOGY_OS). Without them it skips.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { alertsEnabled, openIssues, syncIssue } from "./github.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITES_FILE = process.env.SITES_FILE || path.join(ROOT, "sites.json");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const OUT_FILE = path.join(DATA_DIR, "inventory.json");

const INTERVAL_MINUTES = Number(process.env.INVENTORY_INTERVAL_MINUTES || 15);
const GRACE_MINUTES = Number(process.env.INVENTORY_GRACE_MINUTES || 30);
const FORCE = process.env.FORCE_INVENTORY === "true";
const TIMEOUT_MS = 30000;
const PAGE_LIMIT = 200;
const USER_AGENT = "Mozilla/5.0 (compatible; SiteUptimeMonitor/1.0)";
const ALERT_LABEL = "inventory";
const MINUTE = 60 * 1000;

const env = {
  host: process.env.PINOGY_API_HOST?.replace(/\/+$/, ""),
  accessKey: process.env.PINOGY_ACCESS_KEY,
  secret: process.env.PINOGY_SECRET,
  password: process.env.PINOGY_PASSWORD,
  appId: process.env.PINOGY_APP_ID || "3",
  version: process.env.PINOGY_VERSION || "1.0",
  os: process.env.PINOGY_OS || "linux",
};

// ---- helpers -------------------------------------------------------------

async function fetchJson(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).pathname}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Response from ${new URL(url).pathname} is not JSON`);
  }
}

async function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

function breedName(breed) {
  return typeof breed === "string" ? breed : breed?.name || "";
}

function normalizePrice(price) {
  if (price == null || price === "") return null;
  const n = Number(String(price).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

// Keep only what the dashboard needs. Raw Pinogy records may hold internal
// fields (costs, notes) that must never end up in this public repository.
function summarize(pet) {
  return {
    id: String(pet.id ?? pet.pet_id ?? pet.petId),
    name: pet.name || "",
    breed: breedName(pet.breed),
    price: normalizePrice(pet.price),
  };
}

// ---- Pinogy (mirrors the storefront's lib/pinogy client) ----------------

// One login per run, shared by every store. A failed login is shared too, so
// bad credentials cost one attempt per run rather than one per store (which
// could lock the account).
let tokenPromise = null;

function pinogyToken() {
  tokenPromise ??= login();
  return tokenPromise;
}

async function login() {
  const timestamp = new Date().toISOString();
  const signature = crypto.createHmac("sha256", env.secret).update(`${env.accessKey}${timestamp}`).digest("hex");
  const data = await fetchJson(`${env.host}/apps/any/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      accesskey: env.accessKey,
      timestamp,
      signature,
      app_id: env.appId,
      password: env.password,
      version: env.version,
      os: env.os,
    }),
  }).catch((err) => {
    throw new Error(`Pinogy login failed: ${err.message}`);
  });
  const token = data?.token || data?.data?.token || data?.data?.session?.token || data?.session?.token;
  if (!token) throw new Error("Pinogy login returned no token");
  return token;
}

async function pinogyPets(locationId) {
  const auth = await pinogyToken();
  const pets = [];
  for (let offset = 0; ; ) {
    const params = new URLSearchParams({
      is_available: "true",
      pet_type_slug: "puppies",
      has_images: "true",
      limit: String(PAGE_LIMIT),
      offset: String(offset),
      location_id: String(locationId),
    });
    const data = await fetchJson(`${env.host}/api/pets?${params}`, {
      headers: { authorization: `Bearer ${auth}`, accept: "application/json" },
    });
    const page = data?.objects || data?.data?.objects || data?.data || [];
    if (!Array.isArray(page) || page.length === 0) break;
    pets.push(...page);
    offset += page.length;
    const total = data?.count || data?.data?.count || 0;
    if ((total > 0 && pets.length >= total) || page.length < PAGE_LIMIT) break;
  }
  return pets.map(summarize);
}

// ---- Storefront ------------------------------------------------------------

function extractPets(json) {
  if (Array.isArray(json)) return json;
  for (const key of ["puppies", "pets", "objects", "items", "results", "data"]) {
    const value = json?.[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      const nested = extractPets(value);
      if (nested) return nested;
    }
  }
  return null;
}

async function sitePets(site) {
  const url = new URL(site.inventoryPath || "/api/puppies", site.url).toString();
  const json = await fetchJson(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" } });
  const pets = extractPets(json);
  if (!pets) throw new Error(`Couldn't find a list of puppies in ${new URL(url).pathname}`);
  return pets.map(summarize).filter((p) => p.id && p.id !== "undefined");
}

// ---- Comparison ------------------------------------------------------------

export function compare(pinogy, site) {
  const siteById = new Map(site.map((p) => [p.id, p]));
  const pinogyById = new Map(pinogy.map((p) => [p.id, p]));
  const missing = pinogy.filter((p) => !siteById.has(p.id));
  const stale = site.filter((p) => !pinogyById.has(p.id));
  const price = pinogy
    .filter((p) => siteById.has(p.id))
    .map((p) => ({ ...p, sitePrice: siteById.get(p.id).price }))
    .filter((p) => p.price != null && p.sitePrice != null && p.price !== p.sitePrice);
  return { missing, stale, price };
}

// Carry forward when each difference was first seen, so the grace period
// measures how long it has persisted rather than restarting every run.
function withSince(kind, items, previous, now) {
  const before = new Map((previous?.[kind] || []).map((p) => [p.id, p.since]));
  return items.map((p) => ({ ...p, since: before.get(p.id) || now }));
}

async function checkStore(site, previous, now) {
  const base = { name: site.name, url: site.url, group: site.group || "Sites", locationId: site.pinogyLocationId, checkedAt: now };
  let pinogy, onSite;
  try {
    [pinogy, onSite] = await Promise.all([pinogyPets(site.pinogyLocationId), sitePets(site)]);
  } catch (err) {
    return { ...base, status: "error", error: err.message };
  }
  const diff = compare(pinogy, onSite);
  const result = {
    ...base,
    pinogyCount: pinogy.length,
    siteCount: onSite.length,
    missing: withSince("missing", diff.missing, previous, now),
    stale: withSince("stale", diff.stale, previous, now),
    price: withSince("price", diff.price, previous, now),
  };
  const all = [...result.missing, ...result.stale, ...result.price];
  const graceEnds = Date.parse(now) - GRACE_MINUTES * MINUTE;
  result.status = !all.length ? "in_sync" : all.some((p) => Date.parse(p.since) <= graceEnds) ? "out_of_sync" : "pending";
  return result;
}

// ---- Alerts ----------------------------------------------------------------

function listLines(items, fmt) {
  const lines = items.slice(0, 25).map(fmt);
  if (items.length > 25) lines.push(`- …and ${items.length - 25} more`);
  return lines.join("\n");
}

function issueBody(s) {
  const label = (p) => `${p.name || "(no name)"} · ${p.breed || "unknown breed"} · #${p.id}`;
  const parts = [
    `**${s.url}** doesn't match Pinogy (location ${s.locationId}): ${s.siteCount} puppies on the site, ${s.pinogyCount} in Pinogy.`,
  ];
  if (s.missing.length) parts.push(`### Missing from the site (${s.missing.length})\n${listLines(s.missing, (p) => `- ${label(p)}`)}`);
  if (s.stale.length) parts.push(`### On the site but not available in Pinogy (${s.stale.length})\n${listLines(s.stale, (p) => `- ${label(p)}`)}`);
  if (s.price.length) parts.push(`### Price differs (${s.price.length})\n${listLines(s.price, (p) => `- ${label(p)}: Pinogy $${p.price}, site $${p.sitePrice}`)}`);
  parts.push(`This issue updates on every check and closes automatically once the site matches Pinogy.`);
  return parts.join("\n\n");
}

async function syncAlerts(stores) {
  if (!alertsEnabled) return;
  try {
    const open = await openIssues(ALERT_LABEL);
    for (const s of stores) {
      if (s.status === "error" || s.status === "pending") continue; // leave any open issue as is
      await syncIssue(open, {
        title: `🟠 ${s.name} inventory out of sync`,
        label: ALERT_LABEL,
        active: s.status === "out_of_sync",
        body: s.status === "out_of_sync" ? issueBody(s) : undefined,
        refreshBody: true,
        resolvedComment: `✅ **${s.name}** matches Pinogy again (${s.siteCount} puppies) as of ${s.checkedAt}.`,
      });
    }
  } catch (err) {
    console.error(`Alert sync failed: ${err.message}`);
  }
}

// ---- main ------------------------------------------------------------------

async function main() {
  const previous = await readJson(OUT_FILE, null);
  if (!FORCE && previous?.generatedAt && Date.now() - Date.parse(previous.generatedAt) < (INTERVAL_MINUTES - 1) * MINUTE) {
    console.log(`Inventory checked ${previous.generatedAt}; next check due after ${INTERVAL_MINUTES} minutes.`);
    return;
  }
  if (!env.host || !env.accessKey || !env.secret || !env.password) {
    console.log("Pinogy secrets not set (PINOGY_API_HOST, PINOGY_ACCESS_KEY, PINOGY_SECRET, PINOGY_PASSWORD); skipping inventory check.");
    return;
  }

  const sites = JSON.parse(await readFile(SITES_FILE, "utf8")).filter((s) => s.pinogyLocationId);
  const now = new Date().toISOString();
  const stores = [];
  // One store at a time to stay gentle on the Pinogy API.
  for (const site of sites) {
    const prev = previous?.stores?.find((s) => s.url === site.url);
    const result = await checkStore(site, prev, now);
    stores.push(result);
    const detail = result.status === "error"
      ? result.error
      : `site ${result.siteCount}, pinogy ${result.pinogyCount}, missing ${result.missing.length}, stale ${result.stale.length}, price ${result.price.length}`;
    console.log(`${result.status.toUpperCase().padEnd(11)} ${site.name.padEnd(22)} ${detail}`);
  }

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify({ generatedAt: now, graceMinutes: GRACE_MINUTES, stores }, null, 2));
  await syncAlerts(stores);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
