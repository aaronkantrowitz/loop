import type { PullRequest, Review } from "../src/domain.js";
import type { GitHubSource, PullRequestPage } from "../src/github/client.js";

let reviewSeq = 0;

export function review(overrides: Partial<Review> = {}): Review {
  reviewSeq++;
  return {
    id: `R_${reviewSeq}`,
    author: "reviewer",
    authorIsBot: false,
    state: "APPROVED",
    submittedAt: "2026-10-10T12:00:00.000Z",
    commentCount: 0,
    ...overrides,
  };
}

export function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  const reviews = overrides.reviews ?? [];
  return {
    number: 1,
    author: "alice",
    authorIsBot: false,
    state: "MERGED",
    isDraft: false,
    baseRef: "main",
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-11T00:00:00.000Z",
    mergedAt: "2026-10-11T00:00:00.000Z",
    closedAt: "2026-10-11T00:00:00.000Z",
    mergedBy: "alice",
    additions: 10,
    deletions: 5,
    changedFiles: 1,
    reviewsTotal: reviews.length,
    ...overrides,
    reviews,
  };
}

/** Serves PRs newest-updated first in fixed-size pages, like GitHub's UPDATED_AT DESC ordering. */
export class FakeGitHub implements GitHubSource {
  calls = 0;
  constructor(
    public prs: PullRequest[],
    private readonly pageSize = 2,
    private readonly repo = { owner: "Acme", name: "Widgets", defaultBranch: "main" as string | null },
  ) {}

  async fetchPullRequestPage(_repo: { owner: string; name: string }, cursor: string | null): Promise<PullRequestPage> {
    this.calls++;
    const sorted = [...this.prs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const start = cursor ? Number(cursor) : 0;
    const slice = sorted.slice(start, start + this.pageSize);
    const next = start + this.pageSize < sorted.length ? String(start + this.pageSize) : null;
    return { repository: this.repo, pullRequests: structuredClone(slice), nextCursor: next, rateLimitRemaining: 4999 };
  }
}
