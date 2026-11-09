# Submission notes

## 1. Running it locally

Prerequisites: Node.js 22.13 or newer (24 LTS recommended), npm, and a GitHub fine-grained token with **Public repositories (read-only)** access. An Anthropic API key is optional and only needed for the narrative endpoint.

```bash
npm install
cp .env.example .env    # GITHUB_TOKEN=... and optionally ANTHROPIC_API_KEY=...
npm run dev             # UI and API on http://localhost:3000
npm test                # 45 tests, no network needed
```

Docker: `GITHUB_TOKEN=... ANTHROPIC_API_KEY=... docker compose up --build`. Data lives in a named volume, so restarts keep the cache.

## 2. Architecture tour

The request path is `routes → InsightsService → SyncService → Store (SQLite)`, with `GitHubClient` behind sync and `NarrativeService` on top of the insights report. Sync is incremental. GitHub's GraphQL API returns PRs ordered by `updatedAt` descending, and any PR that was opened, merged or reviewed inside a window has `updatedAt` at or after the window start. So walking pages until `updatedAt < from` gives a complete set for that window. After that, a refresh only walks back to the last sync time, which is usually one request. Each repository row records `coverage_from` and `synced_at`, so the service knows what it can answer locally. If a sync hits its page cap, it records only the range it actually covered and the response says `complete: false` instead of quietly undercounting. Concurrent requests for the same repository queue behind one sync. One GraphQL query per 50 PRs pulls PRs, their reviews and review comment counts together, which avoids the N+1 calls the REST API would need.

Metric computation (`src/insights/metrics.ts`) is a pure function over stored PRs, one linear pass per window. That made it easy to unit test against hand-built fixtures and to run the same code over the previous window for comparisons. For the narrative I treated the LLM as an untrusted component. It only sees numbers and logins, never PR titles or bodies that could carry prompt injection. It has to cite facts by id through schema-enforced structured output, and the server attaches the real values, checks numbers in the prose and adjusts confidence with visible reasons. I chose that over trusting a single confidence number from the model, because a confident hallucination is the failure that would actually cost a team. Other decisions: Fastify with zod schemas for validation, problem+json errors that never leak internals, strict regexes on `owner`/`repo` (and a fixed GraphQL endpoint, so no SSRF path), private repositories refused even if the token could read them, helmet with a strict CSP for the UI, per-IP rate limits with a tighter one on the paid LLM route, ETags, and periods anchored to the hour so ETags and the narrative cache actually hit.

### Trade-offs I'd revisit

- **SQLite via `node:sqlite`.** No native build step and no extra container, and it is plenty for one instance. Its calls are synchronous; queries here are small indexed reads, but a multi-instance deployment should move to Postgres (the `Store` class is the only place with SQL).
- **Sync inside the request.** Simple and always consistent, but the first request for a large repo waits on GitHub. A background job queue with a "sync in progress" response would be better at scale.
- **Reviews capped at 100 per PR.** Rare in practice, and counted in `dataQuality.prsWithTruncatedReviews` so it isn't silent. Nested pagination would remove it.
- **Number grounding is heuristic.** It allows rounding and a few unit conversions. It catches invented figures well, but it can't tell whether a correct number was used in the wrong sentence.

## 3. What I'd do next with another day

- Background sync with a job table, plus a webhook or scheduled refresh for watched repos.
- An eval set for the narrative: a few dozen frozen reports with known features (a reviewer leaving, a spike in PR size), scored on groundedness, whether the hypothesis names the planted cause, and confidence calibration. Then tune prompt and effort against it.
- Issues and commit signals (time to close issues, first-time contributors, CI failure rates) to give the hypothesis more to work with.
- Per-reviewer response time, so "review is slow" can point at a queue instead of a person.
- OpenTelemetry tracing on the GitHub and Anthropic calls, and metrics on cache hit rate and token spend.
- Run the Docker image and the GitHub integration in CI against a small public repo (see the caveat below).

## 4. How I used AI

I built this with Claude Code as a pair. I set the scope and the main design decisions (GraphQL over REST, incremental sync by `updatedAt`, facts with ids plus server-side verification for the LLM, SQLite), and Claude Code drafted most of the code and tests from that. I reviewed every file, ran the tests, type checker and linter, and drove the UI in a headless browser to check it on desktop and phone widths. Review caught things I changed: an O(n²) membership check in the metrics loop, a period default that changed every millisecond (which defeated the caches), a 403 being treated as a rate limit when it could be a permission error, and an incremental sync edge case that could over-claim coverage.

**Caveat:** the sandbox I worked in blocked the GitHub API and had no Anthropic key or Docker daemon. The GitHub client is tested against recorded-shape fixtures and the LLM path against a fake model, the production build was started and smoke tested, but the live GitHub call, a real Claude call and `docker compose up` should be run once before the demo.
