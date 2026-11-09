import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { Store } from "../src/db/store.js";
import { SyncService } from "../src/ingest/sync.js";
import { FakeGitHub, pr } from "./fixtures.js";
import { silentLogger } from "./helpers.js";

const repo = { owner: "acme", name: "widgets" };

function setup(prs = defaultPrs(), opts: { maxPages?: number; now?: Date } = {}) {
  const store = new Store(openDatabase(":memory:"));
  const github = new FakeGitHub(prs, 2);
  let now = opts.now ?? new Date("2026-11-01T00:00:00Z");
  const sync = new SyncService(store, github, { ttlMs: 15 * 60_000, maxPages: opts.maxPages ?? 10, now: () => now }, silentLogger);
  return { store, github, sync, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

function defaultPrs() {
  return [1, 2, 3, 4, 5, 6].map((n) => pr({ number: n, updatedAt: new Date(Date.UTC(2026, 9, n * 5)).toISOString() }));
}

describe("SyncService", () => {
  it("pages back until PRs are older than the requested start, then serves from the store", async () => {
    const { sync, github, store } = setup();
    const result = await sync.ensureCoverage(repo, new Date("2026-10-18T00:00:00Z"));
    // Oct 30, 25 | Oct 20, 15 -> the second page crosses Oct 18, so the walk stops there.
    expect(github.calls).toBe(2);
    expect(result).toMatchObject({ complete: true, coverageFrom: "2026-10-18T00:00:00.000Z" });
    expect(result.repository).toMatchObject({ owner: "Acme", name: "Widgets", defaultBranch: "main" });

    await sync.ensureCoverage(repo, new Date("2026-10-20T00:00:00Z"));
    expect(github.calls).toBe(2);
    expect(store.pullRequestsUpdatedSince(result.repository.id, "2026-10-18T00:00:00.000Z").map((p) => p.number)).toEqual([4, 5, 6]);
  });

  it("refreshes incrementally once the data is stale", async () => {
    const { sync, github, advance } = setup();
    await sync.ensureCoverage(repo, new Date("2026-10-01T00:00:00Z"));
    const callsAfterBackfill = github.calls;
    advance(60 * 60_000);
    github.prs.push(pr({ number: 7, updatedAt: "2026-11-01T00:30:00.000Z" }));
    await sync.ensureCoverage(repo, new Date("2026-10-01T00:00:00Z"));
    expect(github.calls - callsAfterBackfill).toBe(1);
  });

  it("reports partial coverage when the page cap is hit", async () => {
    const { sync } = setup(defaultPrs(), { maxPages: 1 });
    const result = await sync.ensureCoverage(repo, new Date("2026-09-01T00:00:00Z"));
    expect(result.complete).toBe(false);
    expect(result.coverageFrom).toBe("2026-10-25T00:00:00.000Z");
  });

  it("collapses concurrent requests into one upstream sync", async () => {
    const { sync, github } = setup();
    await Promise.all([1, 2, 3].map(() => sync.ensureCoverage(repo, new Date("2026-10-18T00:00:00Z"))));
    expect(github.calls).toBe(2);
  });
});
