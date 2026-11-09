import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db/database.js";
import { NotFoundError } from "../src/errors.js";
import type { GitHubSource } from "../src/github/client.js";
import type { ModelNarrative } from "../src/narrative/schema.js";
import type { NarrativeModel } from "../src/narrative/service.js";
import { FakeGitHub, pr, review } from "./fixtures.js";
import { testConfig } from "./helpers.js";

const NOW = new Date("2026-11-09T12:00:00Z");

const prs = [
  pr({
    number: 1,
    author: "alice",
    createdAt: "2026-10-20T00:00:00.000Z",
    mergedAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
    additions: 100,
    deletions: 20,
    reviews: [review({ author: "bob", submittedAt: "2026-10-20T04:00:00.000Z", commentCount: 3 })],
  }),
  pr({
    number: 2,
    author: "alice",
    createdAt: "2026-10-25T00:00:00.000Z",
    mergedAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
    reviews: [review({ author: "bob", submittedAt: "2026-10-26T00:00:00.000Z" })],
  }),
  pr({
    number: 3,
    author: "carol",
    createdAt: "2026-11-01T00:00:00.000Z",
    mergedAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
    reviews: [],
  }),
  pr({
    number: 4,
    author: "bob",
    state: "OPEN",
    createdAt: "2026-11-03T00:00:00.000Z",
    mergedAt: null,
    closedAt: null,
    updatedAt: "2026-11-04T00:00:00.000Z",
    reviews: [review({ author: "alice", state: "CHANGES_REQUESTED", submittedAt: "2026-11-04T00:00:00.000Z" })],
  }),
  pr({
    number: 5,
    author: "dave",
    createdAt: "2026-09-30T00:00:00.000Z",
    mergedAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  }),
];

const narrativeOutput: ModelNarrative = {
  headline: "Three PRs merged, one without review",
  summary: "3 PRs merged and 1 merged without review.",
  observations: [
    {
      title: "Review coverage",
      detail: "One merge skipped review.",
      evidence: [{ factId: "current.flow.prsMergedWithoutReview", interpretation: "gap" }],
    },
  ],
  hypothesis: null,
  caveats: ["Small sample"],
};

class FakeModel implements NarrativeModel {
  readonly id = "fake";
  calls = 0;
  async generate() {
    this.calls++;
    return { output: narrativeOutput, servedBy: "fake-model" };
  }
}

let app: FastifyInstance;

async function start(
  opts: { github?: GitHubSource; model?: NarrativeModel | null; env?: Record<string, string> } = {},
) {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  app = await buildApp({
    config: testConfig(opts.env),
    db: openDatabase(":memory:"),
    github: opts.github ?? new FakeGitHub(prs, 2),
    narrativeModel: opts.model === undefined ? new FakeModel() : opts.model,
  });
  return app;
}

afterEach(async () => {
  await app?.close();
  vi.useRealTimers();
});

describe("GET /api/v1/repos/:owner/:repo/insights", () => {
  it("returns metrics for the period with a comparison to the previous one", async () => {
    await start();
    const res = await app.inject("/api/v1/repos/acme/widgets/insights?from=2026-10-15&to=2026-11-08");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.repository).toEqual({
      owner: "Acme",
      name: "Widgets",
      defaultBranch: "main",
      url: "https://github.com/Acme/Widgets",
    });
    expect(body.period).toEqual({ from: "2026-10-15T00:00:00.000Z", to: "2026-11-09T00:00:00.000Z" });
    expect(body.current.flow).toMatchObject({
      prsOpened: 4,
      prsMerged: 3,
      prsMergedWithoutReview: 1,
      medianHoursToFirstReview: 4,
    });
    expect(body.current.contributors[0]).toMatchObject({
      login: "alice",
      prsMerged: 2,
      linesAdded: 110,
      linesDeleted: 25,
    });
    expect(body.current.reviewers.map((r: { login: string }) => r.login)).toEqual(["bob", "alice"]);
    expect(body.previous.flow.prsMerged).toBe(1);
    expect(body.changes.find((c: { metric: string }) => c.metric === "flow.prsMerged")).toEqual({
      metric: "flow.prsMerged",
      current: 3,
      previous: 1,
      delta: 2,
      deltaRatio: 2,
    });
    expect(res.headers.etag).toBeDefined();
  });

  it("answers a conditional request with 304", async () => {
    await start();
    const first = await app.inject("/api/v1/repos/acme/widgets/insights?from=2026-10-15&to=2026-11-08");
    const second = await app.inject({
      url: "/api/v1/repos/acme/widgets/insights?from=2026-10-15&to=2026-11-08",
      headers: { "if-none-match": first.headers.etag as string },
    });
    expect(second.statusCode).toBe(304);
  });

  it.each([
    ["/api/v1/repos/acme/..%2F..%2Fetc/insights", "invalid_request"],
    ["/api/v1/repos/-bad-/widgets/insights", "invalid_request"],
    ["/api/v1/repos/acme/widgets/insights?limit=0", "invalid_request"],
    ["/api/v1/repos/acme/widgets/insights?from=yesterday", "bad_request"],
    ["/api/v1/repos/acme/widgets/insights?from=2026-11-05&to=2026-11-01", "bad_request"],
  ])("rejects %s with 400 problem+json", async (url, code) => {
    await start();
    const res = await app.inject(url);
    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.json()).toMatchObject({ status: 400, code });
  });

  it("maps a missing upstream repository to 404", async () => {
    await start({
      github: {
        fetchPullRequestPage: async () => {
          throw new NotFoundError("Repository acme/nope was not found or is not accessible");
        },
      },
    });
    const res = await app.inject("/api/v1/repos/acme/nope/insights");
    expect(res.statusCode).toBe(404);
    expect(res.json().detail).toContain("not found");
  });

  it("enforces the repository allowlist", async () => {
    await start({ env: { ALLOWED_REPOS: "acme/other" } });
    expect((await app.inject("/api/v1/repos/acme/widgets/insights")).statusCode).toBe(403);
  });

  it("hides internal error details", async () => {
    await start({
      github: {
        fetchPullRequestPage: async () => {
          throw new Error("secret internals");
        },
      },
    });
    const res = await app.inject("/api/v1/repos/acme/widgets/insights");
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("secret internals");
  });
});

describe("GET /api/v1/repos/:owner/:repo/insights/narrative", () => {
  it("returns a verified narrative and serves repeats from cache", async () => {
    const model = new FakeModel();
    await start({ model });
    const url = "/api/v1/repos/acme/widgets/insights/narrative?from=2026-10-15&to=2026-11-08";
    const res = await app.inject(url);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.narrative.observations[0].evidence).toEqual([
      { factId: "current.flow.prsMergedWithoutReview", value: 1, interpretation: "gap" },
    ]);
    expect(body.narrative.verification).toMatchObject({ grounded: true, unknownFactIds: [] });
    expect(body.generation).toMatchObject({ model: "fake-model", cached: false });

    const again = await app.inject(url);
    expect(again.json().generation.cached).toBe(true);
    expect(model.calls).toBe(1);
  });

  it("returns 503 without touching GitHub when no LLM is configured", async () => {
    const github = new FakeGitHub(prs);
    await start({ model: null, github });
    const res = await app.inject("/api/v1/repos/acme/widgets/insights/narrative");
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("llm_not_configured");
    expect(github.calls).toBe(0);
  });
});

describe("operational endpoints", () => {
  it("serves health, readiness and the UI", async () => {
    await start();
    expect((await app.inject("/healthz")).json()).toEqual({ status: "ok" });
    expect((await app.inject("/readyz")).json()).toEqual({ status: "ready", narratives: "enabled" });
    const ui = await app.inject("/");
    expect(ui.statusCode).toBe(200);
    expect(ui.headers["content-security-policy"]).toContain("default-src 'self'");
  });

  it("returns problem+json for unknown routes", async () => {
    await start();
    const res = await app.inject("/api/v1/nope");
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("not_found");
  });
});
