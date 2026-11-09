import type { DatabaseSync, StatementSync } from "node:sqlite";
import { type PullRequest, type RepoRef, type Review, type ReviewState, repoSlug } from "../domain.js";
import { transaction } from "./database.js";

export interface RepositoryRecord {
  id: number;
  owner: string;
  name: string;
  defaultBranch: string | null;
  coverageFrom: string | null;
  syncedAt: string | null;
}

interface RepoRow {
  id: number;
  owner: string;
  name: string;
  default_branch: string | null;
  coverage_from: string | null;
  synced_at: string | null;
}

interface PrRow {
  number: number;
  author: string | null;
  author_is_bot: number;
  state: PullRequest["state"];
  is_draft: number;
  base_ref: string;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  closed_at: string | null;
  merged_by: string | null;
  additions: number;
  deletions: number;
  changed_files: number;
  reviews_total: number;
}

interface ReviewRow {
  id: string;
  pr_number: number;
  author: string | null;
  author_is_bot: number;
  state: ReviewState;
  submitted_at: string;
  comment_count: number;
}

/** All SQL lives here. Statements are prepared once and every value is bound, never interpolated. */
export class Store {
  private readonly stmts: Record<string, StatementSync>;

  constructor(private readonly db: DatabaseSync) {
    this.stmts = {
      getRepo: db.prepare("SELECT * FROM repositories WHERE slug = ?"),
      insertRepo: db.prepare(
        "INSERT INTO repositories (slug, owner, name) VALUES (?, ?, ?) ON CONFLICT (slug) DO NOTHING",
      ),
      markSynced: db.prepare(
        "UPDATE repositories SET owner = ?, name = ?, default_branch = ?, coverage_from = ?, synced_at = ? WHERE id = ?",
      ),
      upsertPr: db.prepare(`
        INSERT INTO pull_requests (repo_id, number, author, author_is_bot, state, is_draft, base_ref, created_at,
          updated_at, merged_at, closed_at, merged_by, additions, deletions, changed_files, reviews_total)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (repo_id, number) DO UPDATE SET
          author = excluded.author, author_is_bot = excluded.author_is_bot, state = excluded.state,
          is_draft = excluded.is_draft, base_ref = excluded.base_ref, updated_at = excluded.updated_at,
          merged_at = excluded.merged_at, closed_at = excluded.closed_at, merged_by = excluded.merged_by,
          additions = excluded.additions, deletions = excluded.deletions, changed_files = excluded.changed_files,
          reviews_total = excluded.reviews_total`),
      deleteReviews: db.prepare("DELETE FROM reviews WHERE repo_id = ? AND pr_number = ?"),
      insertReview: db.prepare(`
        INSERT INTO reviews (id, repo_id, pr_number, author, author_is_bot, state, submitted_at, comment_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO NOTHING`),
      prsSince: db.prepare(
        "SELECT * FROM pull_requests WHERE repo_id = ? AND updated_at >= ? ORDER BY number",
      ),
      reviewsSince: db.prepare(`
        SELECT r.* FROM reviews r
        JOIN pull_requests p ON p.repo_id = r.repo_id AND p.number = r.pr_number
        WHERE r.repo_id = ? AND p.updated_at >= ?
        ORDER BY r.submitted_at`),
      getNarrative: db.prepare("SELECT payload FROM narratives WHERE cache_key = ?"),
      putNarrative: db.prepare(
        "INSERT INTO narratives (cache_key, created_at, payload) VALUES (?, ?, ?) ON CONFLICT (cache_key) DO UPDATE SET created_at = excluded.created_at, payload = excluded.payload",
      ),
    };
  }

  private stmt(name: string): StatementSync {
    const s = this.stmts[name];
    if (!s) throw new Error(`Unknown statement ${name}`);
    return s;
  }

  getRepository(ref: RepoRef): RepositoryRecord | undefined {
    const row = this.stmt("getRepo").get(repoSlug(ref)) as RepoRow | undefined;
    return row && toRepository(row);
  }

  ensureRepository(ref: RepoRef): RepositoryRecord {
    this.stmt("insertRepo").run(repoSlug(ref), ref.owner, ref.name);
    return this.getRepository(ref) as RepositoryRecord;
  }

  /**
   * Persists one page of pull requests atomically. Reviews are replaced per PR because GitHub
   * returns the full list each time and reviews can be dismissed or deleted upstream.
   */
  savePullRequests(repoId: number, prs: readonly PullRequest[]): void {
    transaction(this.db, () => {
      for (const pr of prs) {
        this.stmt("upsertPr").run(
          repoId,
          pr.number,
          pr.author,
          Number(pr.authorIsBot),
          pr.state,
          Number(pr.isDraft),
          pr.baseRef,
          pr.createdAt,
          pr.updatedAt,
          pr.mergedAt,
          pr.closedAt,
          pr.mergedBy,
          pr.additions,
          pr.deletions,
          pr.changedFiles,
          pr.reviewsTotal,
        );
        this.stmt("deleteReviews").run(repoId, pr.number);
        for (const r of pr.reviews) {
          this.stmt("insertReview").run(
            r.id,
            repoId,
            pr.number,
            r.author,
            Number(r.authorIsBot),
            r.state,
            r.submittedAt,
            r.commentCount,
          );
        }
      }
    });
  }

  markSynced(
    repoId: number,
    canonical: RepoRef,
    defaultBranch: string | null,
    coverageFrom: string,
    syncedAt: string,
  ): void {
    this.stmt("markSynced").run(canonical.owner, canonical.name, defaultBranch, coverageFrom, syncedAt, repoId);
  }

  /** Every stored PR with activity at or after `since`, with its reviews attached. */
  pullRequestsUpdatedSince(repoId: number, since: string): PullRequest[] {
    const prs = (this.stmt("prsSince").all(repoId, since) as unknown as PrRow[]).map(toPullRequest);
    const byNumber = new Map(prs.map((p) => [p.number, p]));
    for (const row of this.stmt("reviewsSince").all(repoId, since) as unknown as ReviewRow[]) {
      byNumber.get(row.pr_number)?.reviews.push(toReview(row));
    }
    return prs;
  }

  getNarrative(cacheKey: string): string | undefined {
    const row = this.stmt("getNarrative").get(cacheKey) as { payload: string } | undefined;
    return row?.payload;
  }

  putNarrative(cacheKey: string, payload: string): void {
    this.stmt("putNarrative").run(cacheKey, new Date().toISOString(), payload);
  }
}

const toRepository = (r: RepoRow): RepositoryRecord => ({
  id: r.id,
  owner: r.owner,
  name: r.name,
  defaultBranch: r.default_branch,
  coverageFrom: r.coverage_from,
  syncedAt: r.synced_at,
});

const toPullRequest = (r: PrRow): PullRequest => ({
  number: r.number,
  author: r.author,
  authorIsBot: r.author_is_bot === 1,
  state: r.state,
  isDraft: r.is_draft === 1,
  baseRef: r.base_ref,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  mergedAt: r.merged_at,
  closedAt: r.closed_at,
  mergedBy: r.merged_by,
  additions: r.additions,
  deletions: r.deletions,
  changedFiles: r.changed_files,
  reviewsTotal: r.reviews_total,
  reviews: [],
});

const toReview = (r: ReviewRow): Review => ({
  id: r.id,
  author: r.author,
  authorIsBot: r.author_is_bot === 1,
  state: r.state,
  submittedAt: r.submitted_at,
  commentCount: r.comment_count,
});
