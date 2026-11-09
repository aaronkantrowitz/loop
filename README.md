# Repo Pulse

A small service that reads pull request and code review activity from a public GitHub repository and answers two questions:

1. **Who ships, who reviews, and where does work wait?** (`GET /insights`)
2. **What is unusual about that, and why?** (`GET /insights/narrative`), an LLM write-up where every claim cites a metric id and the server checks it before returning.

It ships with a one-page UI at `http://localhost:3000`.

## 60-second quickstart

You need Node.js 22.13+ (24 recommended) and a GitHub token. A [fine-grained token](https://github.com/settings/personal-access-tokens/new) with **Public repositories (read-only)** and no other permissions is enough. GitHub's GraphQL API needs a token even for public data.

```bash
npm install
cp .env.example .env          # set GITHUB_TOKEN, and ANTHROPIC_API_KEY for narratives
npm run dev                   # http://localhost:3000
```

Or with Docker:

```bash
GITHUB_TOKEN=... ANTHROPIC_API_KEY=... docker compose up --build
```

Then:

```bash
curl -s "localhost:3000/api/v1/repos/fastify/fastify/insights?from=2026-10-01&to=2026-10-31" | jq .current.flow
curl -s "localhost:3000/api/v1/repos/fastify/fastify/insights/narrative?from=2026-10-01&to=2026-10-31" | jq .narrative
```

The first request for a repository syncs from GitHub (a few seconds for most repos). Later requests read from SQLite and only fetch what changed.

## API

All errors are `application/problem+json` ([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)) with a stable `code` field.

### `GET /api/v1/repos/{owner}/{repo}/insights`

| Query | Default | Notes |
| --- | --- | --- |
| `from` | 30 days before `to` | `YYYY-MM-DD` or ISO-8601 timestamp with a timezone |
| `to` | start of the current hour | A plain date is inclusive of that day. Clamped to the current hour. |
| `limit` | `10` | Rows per ranked list, 1 to 100 |
| `includeBots` | `false` | Count bot accounts (dependabot, renovate) as authors and reviewers |

The period may span up to 180 days (`MAX_PERIOD_DAYS`). The response contains:

- `current`: metrics for the period (`flow`, `concentration`, `totals`, `contributors`, `reviewers`, `reviewPairs`, `dataQuality`)
- `previous`: the same headline metrics for the period of equal length right before it
- `changes`: period-over-period deltas for the headline metrics
- `data`: when the repository was last synced and whether the sync covered the whole period

Responses carry an `ETag`, so `If-None-Match` gets a `304` when nothing changed.

### `GET /api/v1/repos/{owner}/{repo}/insights/narrative`

Same `from`, `to` and `includeBots` parameters. Returns:

```jsonc
{
  "narrative": {
    "headline": "...",
    "summary": "3 to 5 sentences",
    "observations": [{ "title": "...", "detail": "...", "evidence": [{ "factId": "current.flow.medianHoursToFirstReview", "value": 23.3, "interpretation": "..." }] }],
    "hypothesis": {
      "statement": "...", "reasoning": "...",
      "modelConfidence": 0.7, "confidence": 0.35,
      "confidenceAdjustments": [{ "reason": "Some cited evidence did not match a known fact", "confidenceAfter": 0.35 }],
      "evidence": [...], "alternativeExplanations": [...], "howToConfirm": "..."
    },
    "caveats": [...],
    "verification": { "citedFacts": 4, "unknownFactIds": [], "unverifiedNumbers": [], "grounded": true }
  },
  "generation": { "model": "claude-opus-5-5", "promptVersion": "...", "generatedAt": "...", "cached": false }
}
```

Returns `503 llm_not_configured` when `ANTHROPIC_API_KEY` is not set. It has a stricter rate limit (6 per minute per IP by default).

### Operational

- `GET /healthz`: liveness
- `GET /readyz`: checks the database and reports whether narratives are enabled

## What the metrics mean and why

I picked **review flow** over a plain leaderboard. Commit counts mostly measure how people split their commits. What tends to hurt a team is work that waits and review that rests on one or two people, so the metrics are built around that.

| Metric | Definition | Why it matters |
| --- | --- | --- |
| `flow.prsMerged` | PRs merged **into the default branch** in the period | Delivered work. Backport branches are left out so they don't double count. |
| `flow.medianHoursToFirstReview`, `p90...` | Creation to first review by someone other than the author, over PRs merged in the period | The wait authors actually feel. p90 shows the tail the median hides. |
| `flow.medianHoursToMerge`, `p90...` | Creation to merge, over PRs merged in the period | End-to-end cycle time |
| `flow.mergedWithoutReviewRate` | Share of merged PRs with no non-author review before merge | Review coverage. A review after merge doesn't count. |
| `flow.medianLinesChangedPerPr`, `largePrShare` | Size of merged PRs; "large" is over 500 changed lines | Big PRs are a common cause of slow reviews |
| `concentration.reviewBusFactor` | Fewest reviewers who together did at least half of all reviews | 1 or 2 means review depends on very few people |
| `concentration.topReviewerShareOfReviews`, `topAuthorShareOfMerges` | Share held by the top person | Same idea, for one person |
| `contributors[]` | Per author: PRs opened, PRs merged, lines added and deleted on merged PRs, median hours to merge | The classic "top contributors" view |
| `reviewers[]` | Per reviewer: reviews, approvals, changes requested, inline review comments, distinct PRs and authors reviewed | "Top reviewers", with breadth (how many authors) next to volume |
| `reviewPairs[]` | Reviewer to author counts | Shows silos and who depends on whom |

Rules that apply everywhere: windows are half-open `[from, to)` in UTC, self-reviews never count, pending (draft) reviews are ignored, bots are excluded unless `includeBots=true`, deleted accounts show up as `ghost`, and empty samples return `null` instead of a misleading `0`. Reviews are credited by when they were submitted, so reviewing an older PR still counts in the period it happened.

## How the narrative stays honest

The model never sees raw PR titles or bodies, only numbers and GitHub logins (which GitHub limits to letters, digits and hyphens). Each number is a **fact** with a stable id such as `current.reviewers[alice].reviews`. The model returns structured output (JSON schema enforced by the API) and has to cite fact ids. Then the server:

1. **Resolves every citation itself.** Unknown ids are dropped and listed in `verification.unknownFactIds`. The `value` next to each citation comes from our data, never from the model.
2. **Checks every number in the prose** against the facts, allowing rounding, ratio to percent and hours to days. Anything else goes in `verification.unverifiedNumbers`.
3. **Calibrates confidence.** The model's own score is kept as `modelConfidence`. The returned `confidence` is scaled down for invalid citations and unverified numbers, and capped for small samples (under 20 merged PRs) and partial syncs. Every adjustment is listed with its reason.
4. **Caches** by a hash of model, prompt version and facts, so a repeated question costs nothing.

## Configuration

See [`.env.example`](.env.example). Only `GITHUB_TOKEN` is required. Secrets are read from the environment, never logged, and `.env` is git-ignored.

## Development

```bash
npm test          # vitest: metrics, sync, verification, GitHub mapping, HTTP
npm run typecheck
npm run lint      # biome
npm run build && npm start
```

See [NOTES.md](NOTES.md) for the architecture tour, trade-offs and what I'd do next.
