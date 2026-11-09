import Fastify from "fastify";
import { loadConfig } from "../src/config.js";

/** Fastify's no-op logger, so tests stay quiet without pulling in pino directly. */
export const silentLogger = Fastify({ logger: false }).log;

export const testConfig = (overrides: Record<string, string> = {}) =>
  loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    GITHUB_TOKEN: "test-token",
    DATABASE_PATH: ":memory:",
    ...overrides,
  });
