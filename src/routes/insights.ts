import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { resolvePeriod } from "../insights/period.js";
import type { InsightsService } from "../insights/service.js";
import type { NarrativeService } from "../narrative/service.js";

/**
 * GitHub's own naming rules. Validating here rejects path tricks ("..", "%2F") before any
 * value reaches the store or the upstream request.
 */
const RepoParams = z.object({
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, "Invalid GitHub owner"),
  repo: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,100}$/, "Invalid GitHub repository name")
    .refine((r) => r !== "." && r !== "..", "Invalid GitHub repository name"),
});

const PeriodQuery = z.object({
  from: z.string().max(40).optional().describe("Start of the period, ISO-8601 date or timestamp. Defaults to 30 days before `to`."),
  to: z.string().max(40).optional().describe("End of the period (a date is inclusive). Defaults to now."),
  includeBots: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true")
    .describe("Count bot accounts such as dependabot as authors and reviewers"),
});

const InsightsQuery = PeriodQuery.extend({
  limit: z.coerce.number().int().min(1).max(100).default(10).describe("Rows per ranked list"),
});

/** How many ranked rows the LLM sees. Enough to show concentration without bloating the prompt. */
const NARRATIVE_ROWS = 10;

export interface InsightsRouteDeps {
  insights: InsightsService;
  narratives: NarrativeService;
  maxPeriodDays: number;
  narrativeRateLimitPerMinute: number;
}

export const insightsRoutes =
  (deps: InsightsRouteDeps): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      "/repos/:owner/:repo/insights",
      { schema: { params: RepoParams, querystring: InsightsQuery } },
      async (request, reply) => {
        const { owner, repo } = request.params;
        const { from, to, limit, includeBots } = request.query;
        const period = resolvePeriod({ from, to }, deps.maxPeriodDays);
        const report = await deps.insights.getReport({ owner, name: repo }, period, { includeBots, limit });
        // Data is at most SYNC_TTL old; let clients revalidate cheaply with the ETag.
        reply.header("cache-control", "private, no-cache");
        return report;
      },
    );

    app.get(
      "/repos/:owner/:repo/insights/narrative",
      {
        schema: { params: RepoParams, querystring: PeriodQuery },
        config: { rateLimit: { max: deps.narrativeRateLimitPerMinute, timeWindow: "1 minute" } },
      },
      async (request, reply) => {
        const { owner, repo } = request.params;
        const { from, to, includeBots } = request.query;
        // Fail before syncing so an unconfigured server does no upstream work.
        deps.narratives.assertEnabled();
        const period = resolvePeriod({ from, to }, deps.maxPeriodDays);
        const report = await deps.insights.getReport({ owner, name: repo }, period, {
          includeBots,
          limit: NARRATIVE_ROWS,
        });
        reply.header("cache-control", "private, no-cache");
        return deps.narratives.narrate(report);
      },
    );
  };
