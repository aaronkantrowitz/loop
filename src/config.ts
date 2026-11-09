import { z } from "zod";

const RepoSlug = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/);

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_PATH: z.string().default("./data/repo-pulse.db"),

  GITHUB_TOKEN: z.string().min(1, "GITHUB_TOKEN is required (a read-only fine-grained PAT is enough)"),
  /** Minutes before a synced repository is considered stale and incrementally refreshed. */
  SYNC_TTL_MINUTES: z.coerce.number().int().min(0).default(15),
  /** Hard cap on GraphQL pages per sync (50 PRs per page) so one request can't drain the rate limit. */
  SYNC_MAX_PAGES: z.coerce.number().int().min(1).max(500).default(40),
  /** Optional comma separated allowlist, e.g. "fastify/fastify,vercel/next.js". Empty means any public repo. */
  ALLOWED_REPOS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    )
    .pipe(z.array(RepoSlug)),
  MAX_PERIOD_DAYS: z.coerce.number().int().min(1).max(365).default(180),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  ANTHROPIC_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),

  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(60),
  NARRATIVE_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(6),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // Only print field names and messages, never values: some of them are secrets.
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
