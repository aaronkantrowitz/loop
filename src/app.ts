import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import etag from "@fastify/etag";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { Config } from "./config.js";
import { Store } from "./db/store.js";
import type { GitHubSource } from "./github/client.js";
import { registerErrorHandler } from "./http/error-handler.js";
import { SyncService } from "./ingest/sync.js";
import { InsightsService } from "./insights/service.js";
import { type NarrativeModel, NarrativeService } from "./narrative/service.js";
import { insightsRoutes } from "./routes/insights.js";

export interface AppDeps {
  config: Config;
  db: DatabaseSync;
  github: GitHubSource;
  narrativeModel: NarrativeModel | null;
}

/** Builds the app from injected dependencies so tests can swap GitHub and the LLM for fakes. */
export async function buildApp({ config, db, github, narrativeModel }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ["req.headers.authorization", "req.headers.cookie", "*.token", "*.apiKey"],
      ...(config.NODE_ENV === "development" && { transport: { target: "pino-pretty" } }),
    },
    // Narratives can take a while on a cold cache; everything else returns well under this.
    requestTimeout: config.LLM_TIMEOUT_MS + 30_000,
    bodyLimit: 16 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", "data:"] },
    },
  });
  await app.register(rateLimit, { max: config.RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute" });
  await app.register(etag);

  const store = new Store(db);
  const sync = new SyncService(
    store,
    github,
    { ttlMs: config.SYNC_TTL_MINUTES * 60_000, maxPages: config.SYNC_MAX_PAGES },
    app.log,
  );
  const insights = new InsightsService(store, sync, config.ALLOWED_REPOS);
  const narratives = new NarrativeService(store, narrativeModel, app.log);

  app.get("/healthz", { config: { rateLimit: false } }, async () => ({ status: "ok" }));
  app.get("/readyz", { config: { rateLimit: false } }, async () => {
    db.prepare("SELECT 1").get();
    return { status: "ready", narratives: narrativeModel ? "enabled" : "disabled" };
  });

  await app.register(
    insightsRoutes({
      insights,
      narratives,
      maxPeriodDays: config.MAX_PERIOD_DAYS,
      narrativeRateLimitPerMinute: config.NARRATIVE_RATE_LIMIT_PER_MINUTE,
    }),
    { prefix: "/api/v1" },
  );

  await app.register(fastifyStatic, { root: resolve(import.meta.dirname, "../public"), index: "index.html" });

  return app;
}
