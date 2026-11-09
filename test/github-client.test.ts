import { describe, expect, it } from "vitest";
import { NotFoundError, UnavailableError, UpstreamError } from "../src/errors.js";
import { GitHubClient } from "../src/github/client.js";

const repo = { owner: "acme", name: "widgets" };

const graphqlPage = (overrides: Record<string, unknown> = {}) => ({
  data: {
    rateLimit: { cost: 1, remaining: 4990, resetAt: "2026-11-09T13:00:00Z" },
    repository: {
      owner: { login: "Acme" },
      name: "Widgets",
      isPrivate: false,
      defaultBranchRef: { name: "main" },
      pullRequests: {
        pageInfo: { hasNextPage: true, endCursor: "Y3Vyc29y" },
        nodes: [
          {
            number: 42,
            state: "MERGED",
            isDraft: false,
            baseRefName: "main",
            createdAt: "2026-10-01T10:00:00Z",
            updatedAt: "2026-10-02T10:00:00Z",
            mergedAt: "2026-10-02T09:00:00Z",
            closedAt: "2026-10-02T09:00:00Z",
            additions: 12,
            deletions: 3,
            changedFiles: 2,
            author: { login: "dependabot", __typename: "Bot" },
            mergedBy: { login: "alice" },
            reviews: {
              totalCount: 3,
              nodes: [
                {
                  id: "R1",
                  state: "APPROVED",
                  submittedAt: "2026-10-01T12:00:00Z",
                  author: { login: "alice", __typename: "User" },
                  comments: { totalCount: 2 },
                },
                {
                  id: "R2",
                  state: "PENDING",
                  submittedAt: null,
                  author: { login: "bob", __typename: "User" },
                  comments: { totalCount: 0 },
                },
                {
                  id: "R3",
                  state: "COMMENTED",
                  submittedAt: "2026-10-01T13:00:00Z",
                  author: null,
                  comments: { totalCount: 1 },
                },
              ],
            },
          },
        ],
      },
      ...overrides,
    },
  },
});

function clientReturning(...responses: (() => Response)[]) {
  const requests: RequestInit[] = [];
  let i = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    requests.push(init);
    const next = responses[Math.min(i++, responses.length - 1)] as () => Response;
    return next();
  }) as typeof fetch;
  return { client: new GitHubClient({ token: "t0ken", fetch: fetchImpl, maxRetries: 1 }), requests };
}

const json =
  (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("GitHubClient", () => {
  it("maps a GraphQL page to domain records", async () => {
    const { client, requests } = clientReturning(json(graphqlPage()));
    const page = await client.fetchPullRequestPage(repo, null);

    expect(page.repository).toEqual({ owner: "Acme", name: "Widgets", defaultBranch: "main" });
    expect(page.nextCursor).toBe("Y3Vyc29y");
    const [p] = page.pullRequests;
    expect(p).toMatchObject({
      number: 42,
      author: "dependabot",
      authorIsBot: true,
      reviewsTotal: 3,
      mergedAt: "2026-10-02T09:00:00.000Z",
    });
    // PENDING reviews are drafts only their author can see, so they are dropped.
    expect(p?.reviews.map((r) => [r.id, r.author, r.commentCount])).toEqual([
      ["R1", "alice", 2],
      ["R3", null, 1],
    ]);

    const body = JSON.parse(requests[0]?.body as string);
    expect(body.variables).toMatchObject({ owner: "acme", name: "widgets", cursor: null });
    expect((requests[0]?.headers as Record<string, string> | undefined)?.authorization).toBe("Bearer t0ken");
  });

  it("treats private and missing repositories as not found", async () => {
    await expect(
      clientReturning(json(graphqlPage({ isPrivate: true }))).client.fetchPullRequestPage(repo, null),
    ).rejects.toBeInstanceOf(NotFoundError);
    const missing = json({
      data: { rateLimit: null, repository: null },
      errors: [{ type: "NOT_FOUND", message: "Could not resolve" }],
    });
    await expect(clientReturning(missing).client.fetchPullRequestPage(repo, null)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("surfaces rate limiting as 503 with Retry-After", async () => {
    const limited = json({ message: "rate limited" }, 403, { "x-ratelimit-remaining": "0", "retry-after": "42" });
    const err = await clientReturning(limited)
      .client.fetchPullRequestPage(repo, null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(UnavailableError);
    expect(err.retryAfterSeconds).toBe(42);
  });

  it("retries transient 5xx responses, then gives up", async () => {
    const { client, requests } = clientReturning(json({}, 502), json(graphqlPage()));
    await expect(client.fetchPullRequestPage(repo, null)).resolves.toBeDefined();
    expect(requests).toHaveLength(2);

    const failing = clientReturning(json({}, 502));
    await expect(failing.client.fetchPullRequestPage(repo, null)).rejects.toBeInstanceOf(UpstreamError);
  });

  it("rejects responses that do not match the expected shape", async () => {
    await expect(
      clientReturning(json({ data: { repository: { nope: true } } })).client.fetchPullRequestPage(repo, null),
    ).rejects.toBeInstanceOf(UpstreamError);
  });
});
