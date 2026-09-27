# Puppy Dreams Site Uptime

One dashboard for puppydreams.com and every subsidiary site. It checks each site every 5 minutes and shows status, response time, uptime history and SSL expiry on one page.

It runs entirely on GitHub, with no server to host:

- **GitHub Actions** runs `scripts/check.mjs` every 5 minutes and commits the results to `data/`.
- **GitHub Pages** serves `index.html`, the dashboard, which reloads every minute.
- **GitHub Issues** alerts you. When a site goes down, an issue titled `🔴 <site> is down` opens automatically and closes when the site recovers. Watch the repo (or turn on issue notifications) to get emails and mobile push.

## Adding a site

Add an entry to `sites.json` and push:

```json
{
  "name": "Carrollton",
  "url": "https://carrollton.puppydreams.com",
  "group": "Texas",
  "keyword": "Carrollton"
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Display name. Must be unique. |
| `url` | yes | Page to check. Redirects are followed. |
| `group` | no | Section heading on the dashboard (default `Sites`). Groups appear in file order. |
| `keyword` | no | Text that must appear on the page, e.g. `"Puppy Dreams"`. Catches blank or error pages that still return HTTP 200. |
| `expectStatus` | no | Status code (or list of codes) that counts as up. Defaults to any 2xx/3xx. |
| `timeoutMs` | no | Request timeout in milliseconds (default 15000). |
| `degradedMs` | no | Responses slower than this show as "slow" (default 5000). |
| `pinogyLocationId` | no | Pinogy location ID. Turns on the inventory check for this store. |
| `inventoryPath` | no | Where the site lists its puppies as JSON (default `/api/puppies`). |

A site is marked down only after a failed check and a failed retry 3 seconds later, so a single blip doesn't set off an alert.

## Inventory check (Pinogy)

Every 15 minutes, `scripts/inventory.mjs` compares the puppies each store's site shows with that store's inventory in Pinogy. It checks each site in `sites.json` that has a `pinogyLocationId`.

- **Pinogy side:** available puppies with images at that location, using the same login and filters as the storefront (`is_available`, `has_images`, `pet_type_slug=puppies`).
- **Site side:** `{store url}/api/puppies`. Set `inventoryPath` on a site to use a different path.

Each store shows one of these states:

| State | Meaning |
| --- | --- |
| In sync | Same puppies on both sides, at the same prices. |
| Syncing… | A difference exists but is less than 30 minutes old, so it could just be the site's cache catching up. |
| Out of sync | A difference has lasted 30 minutes or more. An issue titled `🟠 <store> inventory out of sync` opens, lists the puppies involved, updates as the list changes and closes when the site matches again. |
| Check failed | Pinogy or the site couldn't be read, e.g. a wrong password or a changed `/api/puppies`. |

Differences are grouped as **missing** (in Pinogy, not on the site), **stale** (on the site, no longer available in Pinogy) and **price differs**.

Only each puppy's ID, name, breed and price are saved. That's the same information the storefronts already show publicly. Raw Pinogy records are never written to this repository.

### Pinogy secrets

Add these under **Settings → Secrets and variables → Actions → New repository secret**, using the same values the storefront uses:

| Secret | |
| --- | --- |
| `PINOGY_API_HOST` | Pinogy API base URL |
| `PINOGY_ACCESS_KEY` | |
| `PINOGY_SECRET` | |
| `PINOGY_PASSWORD` | |

GitHub hides secret values, including in logs and from visitors to a public repository. Until the secrets are added, the inventory check skips itself and the rest of the dashboard works as normal. To run it straight away instead of waiting up to 15 minutes, use **Actions → Uptime check → Run workflow**.

## One-time setup

1. **Settings → Pages → Build and deployment → Source:** choose **GitHub Actions**.
2. **Actions tab → Uptime check → Run workflow** runs the first check straight away. After that it runs on its own.
3. Your dashboard is at `https://<owner>.github.io/site-uptime/`.

### Private repository note

With a private repository, GitHub Pages requires a paid plan (Pro/Team). Actions minutes also count against your quota: a check every 5 minutes uses roughly 8,600 minutes a month, and the Free plan includes 2,000. Either:

- **make the repository public** (Actions and Pages are then free and unlimited; the site list and uptime history become visible to anyone), or
- change the `cron` line in `.github/workflows/uptime.yml` to check less often. For example, `*/30 * * * *` uses about 1,450 minutes a month.

## Running a check locally

```sh
node scripts/check.mjs        # Node 20+, no dependencies
npx serve .                   # then open the printed URL to see the dashboard
```
