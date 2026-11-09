import { describe, expect, it } from "vitest";
import { busFactor, computeWindowMetrics, percentile } from "../src/insights/metrics.js";
import { pr, review } from "./fixtures.js";

const october = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z") };
const opts = { defaultBranch: "main", includeBots: false, limit: 10 };

describe("computeWindowMetrics", () => {
  it("counts only PRs merged into the default branch inside the half-open window", () => {
    const m = computeWindowMetrics(
      [
        pr({ number: 1, mergedAt: "2026-10-05T00:00:00.000Z" }),
        pr({ number: 2, mergedAt: "2026-10-06T00:00:00.000Z", baseRef: "release-1.x" }),
        pr({ number: 3, mergedAt: "2026-11-01T00:00:00.000Z" }), // exactly `to`: excluded
        pr({ number: 4, mergedAt: "2026-10-01T00:00:00.000Z" }), // exactly `from`: included
        pr({ number: 5, state: "OPEN", mergedAt: null }),
      ],
      october,
      opts,
    );
    expect(m.flow.prsMerged).toBe(2);
    expect(m.contributors[0]).toMatchObject({ login: "alice", prsMerged: 2, linesAdded: 20, linesDeleted: 10 });
  });

  it("ignores self-reviews and bots, and flags PRs merged before any real review", () => {
    const m = computeWindowMetrics(
      [
        pr({ number: 1, reviews: [review({ author: "alice" })] }), // self-review only
        pr({ number: 2, reviews: [review({ author: "dependabot", authorIsBot: true })] }),
        pr({ number: 3, reviews: [review({ author: "bob", submittedAt: "2026-10-12T00:00:00.000Z" })] }), // after merge
        pr({ number: 4, reviews: [review({ author: "bob", submittedAt: "2026-10-10T06:00:00.000Z" })] }),
      ],
      october,
      opts,
    );
    expect(m.flow.prsMerged).toBe(4);
    expect(m.flow.prsMergedWithoutReview).toBe(3);
    expect(m.flow.mergedWithoutReviewRate).toBe(0.75);
    expect(m.flow.medianHoursToFirstReview).toBe(6);
    expect(m.reviewers.map((r) => r.login)).toEqual(["bob"]);
    expect(m.reviewers[0]).toMatchObject({ reviews: 2, prsReviewed: 2, authorsReviewed: 1 });
    expect(m.dataQuality.botEventsExcluded).toBe(1);
  });

  it("includes bots when asked", () => {
    const prs = [
      pr({ number: 1, author: "renovate", authorIsBot: true }),
      pr({ number: 2, reviews: [review({ author: "copilot", authorIsBot: true })] }),
    ];
    expect(computeWindowMetrics(prs, october, opts).flow.prsMerged).toBe(1);
    const withBots = computeWindowMetrics(prs, october, { ...opts, includeBots: true });
    expect(withBots.flow.prsMerged).toBe(2);
    expect(withBots.reviewers.map((r) => r.login)).toEqual(["copilot"]);
  });

  it("credits reviews by submission time, regardless of when the PR merged", () => {
    const m = computeWindowMetrics(
      [
        pr({
          number: 1,
          createdAt: "2026-09-20T00:00:00.000Z",
          mergedAt: "2026-09-25T00:00:00.000Z",
          reviews: [
            review({ author: "bob", submittedAt: "2026-09-21T00:00:00.000Z" }),
            review({ author: "carol", state: "COMMENTED", commentCount: 4, submittedAt: "2026-10-02T00:00:00.000Z" }),
          ],
        }),
      ],
      october,
      opts,
    );
    expect(m.flow.prsMerged).toBe(0);
    expect(m.reviewers).toEqual([
      {
        login: "carol",
        reviews: 1,
        approvals: 0,
        changesRequested: 0,
        reviewComments: 4,
        prsReviewed: 1,
        authorsReviewed: 1,
      },
    ]);
    expect(m.reviewPairs).toEqual([{ reviewer: "carol", author: "alice", reviews: 1 }]);
  });

  it("totals stay consistent with the full lists even when output is truncated by limit", () => {
    const prs = ["a", "b", "c", "d"].map((author, i) =>
      pr({ number: i + 1, author, reviews: [review({ author: `r${i}` }), review({ author: "lead" })] }),
    );
    const m = computeWindowMetrics(prs, october, { ...opts, limit: 2 });
    expect(m.contributors).toHaveLength(2);
    expect(m.totals.reviews).toBe(8);
    expect(m.concentration).toMatchObject({
      activeAuthors: 4,
      activeReviewers: 5,
      topReviewerShareOfReviews: 0.5,
      reviewBusFactor: 1,
    });
  });

  it("returns nulls rather than zeros for empty samples", () => {
    const m = computeWindowMetrics([], october, opts);
    expect(m.flow).toMatchObject({ prsMerged: 0, mergedWithoutReviewRate: null, medianHoursToMerge: null });
    expect(m.concentration.reviewBusFactor).toBe(0);
  });
});

describe("percentile and busFactor", () => {
  it("uses nearest rank", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([], 50)).toBeNull();
  });

  it("finds the fewest people covering half the work", () => {
    expect(busFactor([10, 1, 1, 1])).toBe(1);
    expect(busFactor([3, 3, 3, 3])).toBe(2);
    expect(busFactor([])).toBe(0);
  });
});
