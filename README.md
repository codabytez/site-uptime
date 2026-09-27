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
  "name": "Puppy Dreams Carlton",
  "url": "https://carlton.puppydreams.com",
  "group": "Locations"
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

A site is marked down only after a failed check and a failed retry 3 seconds later, so a single blip doesn't set off an alert.

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
