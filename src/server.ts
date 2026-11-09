import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import { GitHubClient } from "./github/client.js";
import { ClaudeNarrativeModel } from "./narrative/service.js";

const config = loadConfig();
const db = openDatabase(config.DATABASE_PATH);

const app = await buildApp({
  config,
  db,
  github: new GitHubClient({ token: config.GITHUB_TOKEN }),
  narrativeModel: config.ANTHROPIC_API_KEY
    ? new ClaudeNarrativeModel({
        apiKey: config.ANTHROPIC_API_KEY,
        model: config.ANTHROPIC_MODEL,
        effort: config.ANTHROPIC_EFFORT,
        timeoutMs: config.LLM_TIMEOUT_MS,
      })
    : null,
});

if (!config.ANTHROPIC_API_KEY) app.log.warn("ANTHROPIC_API_KEY is not set: the narrative endpoint will return 503");

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  db.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.HOST, port: config.PORT });
