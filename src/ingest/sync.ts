import type { FastifyBaseLogger } from "fastify";
import type { RepositoryRecord, Store } from "../db/store.js";
import type { RepoRef } from "../domain.js";
import { repoSlug } from "../domain.js";
import type { GitHubSource } from "../github/client.js";

/** Overlap re-fetched on incremental syncs to tolerate clock skew and GitHub's eventual consistency. */
const INCREMENTAL_OVERLAP_MS = 5 * 60_000;

export interface SyncOptions {
  ttlMs: number;
  maxPages: number;
  now?: () => Date;
}

export interface SyncResult {
  repository: RepositoryRecord;
  /** Every PR updated at or after this instant is in the store. */
  coverageFrom: string;
  syncedAt: string;
  /** False when the page cap stopped the sync before reaching the requested start date. */
  complete: boolean;
  pagesFetched: number;
}

/**
 * Keeps the local store current for a repository.
 *
 * GitHub returns PRs ordered by `updatedAt` descending. Any PR merged, opened or reviewed inside a
 * window has `updatedAt` at or after the window start, so paging until `updatedAt < since` captures
 * every PR that can affect metrics for that window. After the first sync we only page back to the
 * previous sync time, which usually costs a single request.
 */
export class SyncService {
  private readonly inFlight = new Map<string, Promise<SyncResult>>();
  private readonly now: () => Date;

  constructor(
    private readonly store: Store,
    private readonly github: GitHubSource,
    private readonly options: SyncOptions,
    private readonly log: FastifyBaseLogger,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** Ensures data from `since` onward is stored and fresh. Concurrent calls per repo share one sync. */
  ensureCoverage(ref: RepoRef, since: Date): Promise<SyncResult> {
    const key = repoSlug(ref);
    const running = this.inFlight.get(key);
    // Calls queue behind any running sync for the same repo. Once it lands, the follow-up usually
    // finds the data fresh and returns without touching GitHub, so a burst costs one upstream sync.
    const next = (running ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.syncIfNeeded(ref, since))
      .finally(() => {
        if (this.inFlight.get(key) === next) this.inFlight.delete(key);
      });
    this.inFlight.set(key, next);
    return next;
  }

  private async syncIfNeeded(ref: RepoRef, since: Date): Promise<SyncResult> {
    const repo = this.store.ensureRepository(ref);
    const startedAt = this.now();
    const sinceIso = since.toISOString();

    const covered = repo.coverageFrom !== null && repo.coverageFrom <= sinceIso;
    const fresh =
      repo.syncedAt !== null && startedAt.getTime() - new Date(repo.syncedAt).getTime() < this.options.ttlMs;
    if (covered && fresh) {
      return {
        repository: repo,
        coverageFrom: repo.coverageFrom as string,
        syncedAt: repo.syncedAt as string,
        complete: true,
        pagesFetched: 0,
      };
    }

    // Covered but stale: only fetch what changed since the last sync. Otherwise backfill to `since`.
    const stopBefore =
      covered && repo.syncedAt
        ? new Date(new Date(repo.syncedAt).getTime() - INCREMENTAL_OVERLAP_MS).toISOString()
        : sinceIso;

    let cursor: string | null = null;
    let pages = 0;
    let oldestSeen: string | null = null;
    let reachedStop = false;
    let canonical: RepoRef & { defaultBranch: string | null } = { ...ref, defaultBranch: repo.defaultBranch };

    while (pages < this.options.maxPages) {
      const page = await this.github.fetchPullRequestPage(ref, cursor);
      pages++;
      canonical = page.repository;
      this.store.savePullRequests(repo.id, page.pullRequests);

      const last = page.pullRequests.at(-1);
      if (last) oldestSeen = last.updatedAt;
      if (!page.nextCursor || (last && last.updatedAt < stopBefore)) {
        reachedStop = true;
        break;
      }
      cursor = page.nextCursor;
    }

    // If the page cap cut us off we can only vouch for the range we actually walked through.
    const coverageFrom = reachedStop
      ? covered
        ? (repo.coverageFrom as string)
        : sinceIso
      : (oldestSeen ?? startedAt.toISOString());
    const syncedAt = startedAt.toISOString();
    this.store.markSynced(repo.id, canonical, canonical.defaultBranch, coverageFrom, syncedAt);

    this.log.info({ repo: repoSlug(ref), pages, coverageFrom, complete: reachedStop }, "repository synced from GitHub");
    return {
      repository: {
        ...repo,
        owner: canonical.owner,
        name: canonical.name,
        defaultBranch: canonical.defaultBranch,
        coverageFrom,
        syncedAt,
      },
      coverageFrom,
      syncedAt,
      complete: reachedStop,
      pagesFetched: pages,
    };
  }
}
