import { z } from "zod";
import type { PullRequest, RepoRef } from "../domain.js";
import { NotFoundError, UnavailableError, UpstreamError } from "../errors.js";

/** Fixed endpoint: user input only ever reaches GitHub as GraphQL variables, so there is no SSRF surface. */
const GRAPHQL_URL = "https://api.github.com/graphql";
const PAGE_SIZE = 50;
const REVIEWS_PER_PR = 100;

const PULL_REQUESTS_QUERY = /* GraphQL */ `
  query PullRequests($owner: String!, $name: String!, $cursor: String, $pageSize: Int!, $reviewsPerPr: Int!) {
    rateLimit { cost remaining resetAt }
    repository(owner: $owner, name: $name) {
      owner { login }
      name
      isPrivate
      defaultBranchRef { name }
      pullRequests(first: $pageSize, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number state isDraft baseRefName
          createdAt updatedAt mergedAt closedAt
          additions deletions changedFiles
          author { login __typename }
          mergedBy { login }
          reviews(first: $reviewsPerPr) {
            totalCount
            nodes {
              id state submittedAt
              author { login __typename }
              comments { totalCount }
            }
          }
        }
      }
    }
  }
`;

const Actor = z.object({ login: z.string(), __typename: z.string().optional() }).nullable();

const ResponseSchema = z.object({
  data: z
    .object({
      rateLimit: z.object({ cost: z.number(), remaining: z.number(), resetAt: z.string() }).nullable(),
      repository: z
        .object({
          owner: z.object({ login: z.string() }),
          name: z.string(),
          isPrivate: z.boolean(),
          defaultBranchRef: z.object({ name: z.string() }).nullable(),
          pullRequests: z.object({
            pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
            nodes: z.array(
              z.object({
                number: z.number(),
                state: z.enum(["OPEN", "CLOSED", "MERGED"]),
                isDraft: z.boolean(),
                baseRefName: z.string(),
                createdAt: z.string(),
                updatedAt: z.string(),
                mergedAt: z.string().nullable(),
                closedAt: z.string().nullable(),
                additions: z.number(),
                deletions: z.number(),
                changedFiles: z.number(),
                author: Actor,
                mergedBy: Actor,
                reviews: z.object({
                  totalCount: z.number(),
                  nodes: z.array(
                    z.object({
                      id: z.string(),
                      state: z.string(),
                      submittedAt: z.string().nullable(),
                      author: Actor,
                      comments: z.object({ totalCount: z.number() }),
                    }),
                  ),
                }),
              }),
            ),
          }),
        })
        .nullable(),
    })
    .nullable()
    .optional(),
  errors: z.array(z.object({ type: z.string().optional(), message: z.string() })).optional(),
});

export interface PullRequestPage {
  repository: RepoRef & { defaultBranch: string | null };
  pullRequests: PullRequest[];
  nextCursor: string | null;
  rateLimitRemaining: number | null;
}

export interface GitHubSource {
  fetchPullRequestPage(repo: RepoRef, cursor: string | null): Promise<PullRequestPage>;
}

export interface GitHubClientOptions {
  token: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
}

export class GitHubClient implements GitHubSource {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(private readonly options: GitHubClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
  }

  async fetchPullRequestPage(repo: RepoRef, cursor: string | null): Promise<PullRequestPage> {
    const body = await this.post({
      query: PULL_REQUESTS_QUERY,
      variables: { owner: repo.owner, name: repo.name, cursor, pageSize: PAGE_SIZE, reviewsPerPr: REVIEWS_PER_PR },
    });

    const parsed = ResponseSchema.safeParse(body);
    if (!parsed.success) throw new UpstreamError("GitHub returned an unexpected response shape");
    const { data, errors } = parsed.data;

    if (errors?.some((e) => e.type === "NOT_FOUND") || (data && data.repository === null)) {
      throw new NotFoundError(`Repository ${repo.owner}/${repo.name} was not found or is not accessible`);
    }
    if (errors?.some((e) => e.type === "RATE_LIMITED")) {
      throw new UnavailableError("upstream_rate_limited", "GitHub rate limit reached, try again later", 60);
    }
    if (errors?.length || !data?.repository) throw new UpstreamError("GitHub GraphQL query failed");

    const r = data.repository;
    // Only public data is in scope. Refuse private repos even if the token could read them,
    // so a broadly scoped token can't leak private activity through this public service.
    if (r.isPrivate)
      throw new NotFoundError(`Repository ${repo.owner}/${repo.name} was not found or is not accessible`);

    return {
      repository: { owner: r.owner.login, name: r.name, defaultBranch: r.defaultBranchRef?.name ?? null },
      nextCursor: r.pullRequests.pageInfo.hasNextPage ? r.pullRequests.pageInfo.endCursor : null,
      rateLimitRemaining: data.rateLimit?.remaining ?? null,
      pullRequests: r.pullRequests.nodes.map((n) => ({
        number: n.number,
        author: n.author?.login ?? null,
        authorIsBot: n.author?.__typename === "Bot",
        state: n.state,
        isDraft: n.isDraft,
        baseRef: n.baseRefName,
        createdAt: iso(n.createdAt),
        updatedAt: iso(n.updatedAt),
        mergedAt: n.mergedAt && iso(n.mergedAt),
        closedAt: n.closedAt && iso(n.closedAt),
        mergedBy: n.mergedBy?.login ?? null,
        additions: n.additions,
        deletions: n.deletions,
        changedFiles: n.changedFiles,
        reviewsTotal: n.reviews.totalCount,
        reviews: n.reviews.nodes.flatMap((rv) =>
          // PENDING reviews have no submittedAt and are invisible to everyone but their author.
          rv.submittedAt && isReviewState(rv.state)
            ? [
                {
                  id: rv.id,
                  author: rv.author?.login ?? null,
                  authorIsBot: rv.author?.__typename === "Bot",
                  state: rv.state,
                  submittedAt: iso(rv.submittedAt),
                  commentCount: rv.comments.totalCount,
                },
              ]
            : [],
        ),
      })),
    };
  }

  private async post(payload: unknown, attempt = 0): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(GRAPHQL_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.token}`,
          "content-type": "application/json",
          accept: "application/vnd.github+json",
          "user-agent": "repo-pulse",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      if (attempt < this.maxRetries) return this.retry(payload, attempt);
      throw new UpstreamError("Could not reach GitHub");
    }

    if (res.ok) return res.json();

    // Drain the body so the connection can be reused; its content is not needed.
    await res.body?.cancel();
    if (res.status === 401) throw new UnavailableError("upstream_auth", "GitHub rejected the configured token");
    const rateLimited =
      res.status === 429 ||
      (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after")));
    if (rateLimited) {
      const retryAfter = Number(res.headers.get("retry-after")) || secondsUntil(res.headers.get("x-ratelimit-reset"));
      throw new UnavailableError("upstream_rate_limited", "GitHub rate limit reached, try again later", retryAfter);
    }
    if (res.status >= 500 && attempt < this.maxRetries) return this.retry(payload, attempt);
    throw new UpstreamError(`GitHub responded with HTTP ${res.status}`);
  }

  private async retry(payload: unknown, attempt: number): Promise<unknown> {
    const backoffMs = 250 * 2 ** attempt + Math.random() * 100;
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    return this.post(payload, attempt + 1);
  }
}

const REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]);
const isReviewState = (s: string): s is PullRequest["reviews"][number]["state"] => REVIEW_STATES.has(s);

const iso = (s: string): string => new Date(s).toISOString();

function secondsUntil(epochSeconds: string | null): number {
  const target = Number(epochSeconds);
  if (!target) return 60;
  return Math.max(1, Math.ceil(target - Date.now() / 1000));
}
