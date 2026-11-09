import type { Store } from "../db/store.js";
import { type RepoRef, repoSlug } from "../domain.js";
import { ForbiddenError } from "../errors.js";
import type { SyncService } from "../ingest/sync.js";
import { computeWindowMetrics, type Period, type WindowMetrics } from "./metrics.js";
import { previousPeriod } from "./period.js";

export interface ReportOptions {
  includeBots: boolean;
  limit: number;
}

export interface MetricChange {
  metric: string;
  current: number | null;
  previous: number | null;
  delta: number | null;
  /** Relative change; null when the previous value is zero or missing. */
  deltaRatio: number | null;
}

export interface InsightsReport {
  repository: { owner: string; name: string; defaultBranch: string | null; url: string };
  period: { from: string; to: string };
  previousPeriod: { from: string; to: string };
  filters: ReportOptions;
  data: { syncedAt: string; coverageFrom: string; complete: boolean };
  current: WindowMetrics;
  previous: Pick<WindowMetrics, "flow" | "concentration" | "totals">;
  changes: MetricChange[];
}

/** Headline metrics compared period over period. Paths into `WindowMetrics`. */
const COMPARED_METRICS = [
  "flow.prsOpened",
  "flow.prsMerged",
  "flow.mergedWithoutReviewRate",
  "flow.medianHoursToFirstReview",
  "flow.medianHoursToMerge",
  "flow.p90HoursToMerge",
  "flow.medianLinesChangedPerPr",
  "totals.reviews",
  "totals.reviewComments",
  "concentration.activeAuthors",
  "concentration.activeReviewers",
  "concentration.topReviewerShareOfReviews",
  "concentration.reviewBusFactor",
] as const;

export class InsightsService {
  constructor(
    private readonly store: Store,
    private readonly sync: SyncService,
    private readonly allowedRepos: readonly string[],
  ) {}

  async getReport(ref: RepoRef, period: Period, options: ReportOptions): Promise<InsightsReport> {
    if (this.allowedRepos.length > 0 && !this.allowedRepos.includes(repoSlug(ref))) {
      throw new ForbiddenError("This repository is not on the server's allowlist");
    }

    const previous = previousPeriod(period);
    const synced = await this.sync.ensureCoverage(ref, previous.from);
    const repo = synced.repository;
    const prs = this.store.pullRequestsUpdatedSince(repo.id, previous.from.toISOString());

    const metricOptions = { defaultBranch: repo.defaultBranch, ...options };
    const current = computeWindowMetrics(prs, period, metricOptions);
    const prior = computeWindowMetrics(prs, previous, metricOptions);

    return {
      repository: {
        owner: repo.owner,
        name: repo.name,
        defaultBranch: repo.defaultBranch,
        url: `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
      },
      period: { from: period.from.toISOString(), to: period.to.toISOString() },
      previousPeriod: { from: previous.from.toISOString(), to: previous.to.toISOString() },
      filters: options,
      data: { syncedAt: synced.syncedAt, coverageFrom: synced.coverageFrom, complete: synced.complete },
      current,
      previous: { flow: prior.flow, concentration: prior.concentration, totals: prior.totals },
      changes: COMPARED_METRICS.map((path) => change(path, current, prior)),
    };
  }
}

function change(path: string, current: WindowMetrics, previous: WindowMetrics): MetricChange {
  const cur = readPath(current, path);
  const prev = readPath(previous, path);
  const delta = cur !== null && prev !== null ? round(cur - prev) : null;
  return {
    metric: path,
    current: cur,
    previous: prev,
    delta,
    deltaRatio: delta !== null && prev ? round(delta / prev) : null,
  };
}

function readPath(obj: unknown, path: string): number | null {
  let value: unknown = obj;
  for (const key of path.split(".")) value = (value as Record<string, unknown>)?.[key];
  return typeof value === "number" ? value : null;
}

const round = (n: number): number => Math.round(n * 1000) / 1000;
