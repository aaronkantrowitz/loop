import type { PullRequest, Review } from "../domain.js";

/**
 * Pure metric computation over stored pull requests. No I/O, so every number is unit-testable
 * against hand-built fixtures.
 *
 * Conventions (documented in the README):
 * - A window is half-open: [from, to).
 * - "Merged" means merged into the default branch inside the window.
 * - Self-reviews never count. Bot accounts are excluded unless `includeBots` is set.
 * - Flow timings are measured over PRs merged in the window.
 */

export interface Period {
  from: Date;
  to: Date;
}

export interface MetricOptions {
  defaultBranch: string | null;
  includeBots: boolean;
  limit: number;
}

export interface ContributorStat {
  login: string;
  prsOpened: number;
  prsMerged: number;
  linesAdded: number;
  linesDeleted: number;
  medianHoursToMerge: number | null;
}

export interface ReviewerStat {
  login: string;
  reviews: number;
  approvals: number;
  changesRequested: number;
  reviewComments: number;
  prsReviewed: number;
  authorsReviewed: number;
}

export interface ReviewPair {
  reviewer: string;
  author: string;
  reviews: number;
}

export interface FlowStats {
  prsOpened: number;
  prsMerged: number;
  prsMergedWithoutReview: number;
  mergedWithoutReviewRate: number | null;
  medianHoursToFirstReview: number | null;
  p90HoursToFirstReview: number | null;
  medianHoursToMerge: number | null;
  p90HoursToMerge: number | null;
  medianLinesChangedPerPr: number | null;
  largePrShare: number | null;
}

export interface Concentration {
  activeAuthors: number;
  activeReviewers: number;
  topAuthorShareOfMerges: number | null;
  topReviewerShareOfReviews: number | null;
  /** Fewest reviewers who together submitted at least half of all reviews. */
  reviewBusFactor: number;
}

export interface WindowMetrics {
  flow: FlowStats;
  concentration: Concentration;
  totals: { reviews: number; approvals: number; reviewComments: number; linesAdded: number; linesDeleted: number };
  contributors: ContributorStat[];
  reviewers: ReviewerStat[];
  reviewPairs: ReviewPair[];
  dataQuality: { prsConsidered: number; prsWithTruncatedReviews: number; botEventsExcluded: number };
}

/** PRs with more changed lines than this count as "large" in `largePrShare`. */
export const LARGE_PR_LINES = 500;
const GHOST = "ghost";
const HOUR_MS = 3_600_000;

export function computeWindowMetrics(prs: readonly PullRequest[], period: Period, options: MetricOptions): WindowMetrics {
  const fromIso = period.from.toISOString();
  const toIso = period.to.toISOString();
  const inWindow = (ts: string | null): ts is string => ts !== null && ts >= fromIso && ts < toIso;

  const contributors = new Map<string, ContributorStat & { mergeHours: number[] }>();
  const reviewers = new Map<string, ReviewerStat & { prs: Set<number>; authors: Set<string> }>();
  const pairs = new Map<string, ReviewPair>();
  const firstReviewHours: number[] = [];
  const mergeHours: number[] = [];
  const mergedSizes: number[] = [];
  let prsOpened = 0;
  let prsMerged = 0;
  let mergedWithoutReview = 0;
  let botEventsExcluded = 0;
  let prsWithTruncatedReviews = 0;
  let prsConsidered = 0;

  const contributor = (login: string) => {
    let c = contributors.get(login);
    if (!c) {
      c = { login, prsOpened: 0, prsMerged: 0, linesAdded: 0, linesDeleted: 0, medianHoursToMerge: null, mergeHours: [] };
      contributors.set(login, c);
    }
    return c;
  };

  for (const pr of prs) {
    const author = pr.author ?? GHOST;
    const prIsBot = pr.authorIsBot && !options.includeBots;
    const opened = inWindow(pr.createdAt);
    const merged =
      inWindow(pr.mergedAt) && (options.defaultBranch === null || pr.baseRef === options.defaultBranch);
    const qualifyingReviews = pr.reviews.filter((r) => isQualifyingReview(r, pr, options.includeBots));

    // Reviews are credited to the reviewer even when the PR author is a bot: reviewing a
    // dependency bump is still review work.
    let touched = false;
    for (const review of pr.reviews) {
      if (!inWindow(review.submittedAt)) continue;
      if (!isQualifyingReview(review, pr, options.includeBots)) {
        if (review.authorIsBot && !options.includeBots) botEventsExcluded++;
        continue;
      }
      touched = true;
      const login = review.author ?? GHOST;
      let r = reviewers.get(login);
      if (!r) {
        r = { login, reviews: 0, approvals: 0, changesRequested: 0, reviewComments: 0, prsReviewed: 0, authorsReviewed: 0, prs: new Set(), authors: new Set() };
        reviewers.set(login, r);
      }
      r.reviews++;
      if (review.state === "APPROVED") r.approvals++;
      if (review.state === "CHANGES_REQUESTED") r.changesRequested++;
      r.reviewComments += review.commentCount;
      r.prs.add(pr.number);
      r.authors.add(author);

      const pairKey = `${login}\u0000${author}`;
      const pair = pairs.get(pairKey) ?? { reviewer: login, author, reviews: 0 };
      pair.reviews++;
      pairs.set(pairKey, pair);
    }

    if (prIsBot) {
      if (opened || merged) botEventsExcluded++;
    } else {
      if (opened) {
        prsOpened++;
        contributor(author).prsOpened++;
        touched = true;
      }
      if (merged) {
        touched = true;
        prsMerged++;
        const c = contributor(author);
        c.prsMerged++;
        c.linesAdded += pr.additions;
        c.linesDeleted += pr.deletions;
        mergedSizes.push(pr.additions + pr.deletions);

        const mergedAtMs = Date.parse(pr.mergedAt as string);
        const createdMs = Date.parse(pr.createdAt);
        const hoursToMerge = (mergedAtMs - createdMs) / HOUR_MS;
        mergeHours.push(hoursToMerge);
        c.mergeHours.push(hoursToMerge);

        const firstReview = earliest(qualifyingReviews);
        if (firstReview && Date.parse(firstReview.submittedAt) <= mergedAtMs) {
          firstReviewHours.push(Math.max(0, (Date.parse(firstReview.submittedAt) - createdMs) / HOUR_MS));
        } else {
          mergedWithoutReview++;
        }
      }
    }

    if (touched) {
      prsConsidered++;
      if (pr.reviewsTotal > pr.reviews.length) prsWithTruncatedReviews++;
    }
  }

  const contributorList = [...contributors.values()]
    .map(({ mergeHours: hours, ...c }) => ({ ...c, medianHoursToMerge: roundHours(percentile(hours, 50)) }))
    .sort(
      (a, b) =>
        b.prsMerged - a.prsMerged ||
        b.linesAdded + b.linesDeleted - (a.linesAdded + a.linesDeleted) ||
        b.prsOpened - a.prsOpened ||
        a.login.localeCompare(b.login),
    );

  const reviewerList = [...reviewers.values()]
    .map(({ prs: prSet, authors, ...r }) => ({ ...r, prsReviewed: prSet.size, authorsReviewed: authors.size }))
    .sort((a, b) => b.reviews - a.reviews || b.reviewComments - a.reviewComments || a.login.localeCompare(b.login));

  const totalReviews = sum(reviewerList.map((r) => r.reviews));
  const mergingAuthors = contributorList.filter((c) => c.prsMerged > 0);

  return {
    flow: {
      prsOpened,
      prsMerged,
      prsMergedWithoutReview: mergedWithoutReview,
      mergedWithoutReviewRate: ratio(mergedWithoutReview, prsMerged),
      medianHoursToFirstReview: roundHours(percentile(firstReviewHours, 50)),
      p90HoursToFirstReview: roundHours(percentile(firstReviewHours, 90)),
      medianHoursToMerge: roundHours(percentile(mergeHours, 50)),
      p90HoursToMerge: roundHours(percentile(mergeHours, 90)),
      medianLinesChangedPerPr: percentile(mergedSizes, 50),
      largePrShare: ratio(mergedSizes.filter((s) => s > LARGE_PR_LINES).length, mergedSizes.length),
    },
    concentration: {
      activeAuthors: contributorList.length,
      activeReviewers: reviewerList.length,
      topAuthorShareOfMerges: ratio(mergingAuthors[0]?.prsMerged ?? 0, prsMerged),
      topReviewerShareOfReviews: ratio(reviewerList[0]?.reviews ?? 0, totalReviews),
      reviewBusFactor: busFactor(reviewerList.map((r) => r.reviews)),
    },
    totals: {
      reviews: totalReviews,
      approvals: sum(reviewerList.map((r) => r.approvals)),
      reviewComments: sum(reviewerList.map((r) => r.reviewComments)),
      linesAdded: sum(contributorList.map((c) => c.linesAdded)),
      linesDeleted: sum(contributorList.map((c) => c.linesDeleted)),
    },
    contributors: contributorList.slice(0, options.limit),
    reviewers: reviewerList.slice(0, options.limit),
    reviewPairs: [...pairs.values()]
      .sort((a, b) => b.reviews - a.reviews || a.reviewer.localeCompare(b.reviewer) || a.author.localeCompare(b.author))
      .slice(0, options.limit),
    dataQuality: { prsConsidered, prsWithTruncatedReviews, botEventsExcluded },
  };
}

function isQualifyingReview(review: Review, pr: PullRequest, includeBots: boolean): boolean {
  if (review.author !== null && review.author === pr.author) return false;
  if (review.authorIsBot && !includeBots) return false;
  return true;
}

function earliest(reviews: readonly Review[]): Review | undefined {
  let min: Review | undefined;
  for (const r of reviews) if (!min || r.submittedAt < min.submittedAt) min = r;
  return min;
}

/** Nearest-rank percentile. Returns null for an empty sample rather than inventing a zero. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] as number;
}

export function busFactor(counts: readonly number[]): number {
  const total = sum(counts);
  if (total === 0) return 0;
  const sorted = [...counts].sort((a, b) => b - a);
  let running = 0;
  for (let i = 0; i < sorted.length; i++) {
    running += sorted[i] as number;
    if (running * 2 >= total) return i + 1;
  }
  return sorted.length;
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
const ratio = (n: number, d: number): number | null => (d === 0 ? null : Math.round((n / d) * 1000) / 1000);
const roundHours = (h: number | null): number | null => (h === null ? null : Math.round(h * 10) / 10);
