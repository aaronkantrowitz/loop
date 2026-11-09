/** Normalized records the rest of the app works with. GitHub-specific shapes stop at src/github. */

export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";

export interface Review {
  id: string;
  author: string | null;
  authorIsBot: boolean;
  state: ReviewState;
  submittedAt: string;
  commentCount: number;
}

export interface PullRequest {
  number: number;
  author: string | null;
  authorIsBot: boolean;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  baseRef: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  mergedBy: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** Total reviews GitHub reports; can exceed `reviews.length` on very long review threads. */
  reviewsTotal: number;
  reviews: Review[];
}

export interface RepoRef {
  owner: string;
  name: string;
}

export const repoSlug = (r: RepoRef): string => `${r.owner}/${r.name}`.toLowerCase();
