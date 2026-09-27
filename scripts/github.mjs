// Minimal GitHub issues client for alerts. Active only when GITHUB_TOKEN and
// GITHUB_REPOSITORY are set (as in GitHub Actions); otherwise every call is a no-op.

const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_REPO = process.env.GITHUB_REPOSITORY;
const GH_API = process.env.GITHUB_API_URL || "https://api.github.com";

export const alertsEnabled = Boolean(GH_TOKEN && GH_REPO);

async function gh(method, endpoint, body) {
  const res = await fetch(`${GH_API}/repos/${GH_REPO}${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${endpoint}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

export function openIssues(label) {
  return gh("GET", `/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`);
}

/**
 * Keeps one issue per alert in step with reality: opens it when `active` and closes it
 * with `resolvedComment` when not. With `refreshBody`, the body is also rewritten while
 * the alert stays active (e.g. an updated list of problems).
 */
export async function syncIssue(open, { title, label, active, body, resolvedComment, refreshBody = false }) {
  const issue = open.find((i) => i.title === title);
  if (active && !issue) {
    await gh("POST", "/issues", { title, labels: [label], body });
    console.log(`Opened issue: ${title}`);
  } else if (active && issue && refreshBody && issue.body !== body) {
    await gh("PATCH", `/issues/${issue.number}`, { body });
  } else if (!active && issue) {
    await gh("POST", `/issues/${issue.number}/comments`, { body: resolvedComment });
    await gh("PATCH", `/issues/${issue.number}`, { state: "closed" });
    console.log(`Closed issue: ${title}`);
  }
}
