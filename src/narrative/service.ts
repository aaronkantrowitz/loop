import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { FastifyBaseLogger } from "fastify";
import type { Store } from "../db/store.js";
import { UnavailableError, UpstreamError } from "../errors.js";
import type { InsightsReport } from "../insights/service.js";
import { buildFacts, toFactTable } from "./facts.js";
import { buildUserMessage, PROMPT_VERSION, SYSTEM_PROMPT } from "./prompt.js";
import { type ModelNarrative, ModelNarrativeSchema } from "./schema.js";
import { type VerifiedNarrative, verifyNarrative } from "./verify.js";

/** Seam between the service and the model so tests can run without network access or an API key. */
export interface NarrativeModel {
  readonly id: string;
  generate(system: string, user: string): Promise<{ output: ModelNarrative; servedBy: string }>;
}

export interface NarrativeResponse {
  repository: InsightsReport["repository"];
  period: InsightsReport["period"];
  narrative: VerifiedNarrative;
  generation: { model: string; promptVersion: string; generatedAt: string; cached: boolean };
}

export class NarrativeService {
  constructor(
    private readonly store: Store,
    private readonly model: NarrativeModel | null,
    private readonly log: FastifyBaseLogger,
  ) {}

  assertEnabled(): NarrativeModel {
    if (!this.model) {
      throw new UnavailableError("llm_not_configured", "Narratives are disabled: the server has no ANTHROPIC_API_KEY");
    }
    return this.model;
  }

  async narrate(report: InsightsReport): Promise<NarrativeResponse> {
    const model = this.assertEnabled();
    const facts = buildFacts(report);
    // Same model, prompt and numbers produce the same key, so repeat requests cost nothing.
    const cacheKey = createHash("sha256")
      .update(JSON.stringify({ model: model.id, PROMPT_VERSION, repo: report.repository, period: report.period, filters: report.filters, facts }))
      .digest("hex");

    const cached = this.store.getNarrative(cacheKey);
    if (cached) {
      const hit = JSON.parse(cached) as NarrativeResponse;
      return { ...hit, generation: { ...hit.generation, cached: true } };
    }

    const started = performance.now();
    const { output, servedBy } = await model.generate(SYSTEM_PROMPT, buildUserMessage(report, facts));
    const narrative = verifyNarrative(output, {
      facts: toFactTable(facts),
      mergedPrs: report.current.flow.prsMerged,
      dataComplete: report.data.complete,
    });
    this.log.info(
      {
        model: servedBy,
        ms: Math.round(performance.now() - started),
        facts: facts.length,
        grounded: narrative.verification.grounded,
        unknownFactIds: narrative.verification.unknownFactIds.length,
        unverifiedNumbers: narrative.verification.unverifiedNumbers.length,
      },
      "narrative generated",
    );

    const response: NarrativeResponse = {
      repository: report.repository,
      period: report.period,
      narrative,
      generation: { model: servedBy, promptVersion: PROMPT_VERSION, generatedAt: new Date().toISOString(), cached: false },
    };
    this.store.putNarrative(cacheKey, JSON.stringify(response));
    return response;
  }
}

export interface ClaudeModelOptions {
  apiKey: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs: number;
}

export class ClaudeNarrativeModel implements NarrativeModel {
  private readonly client: Anthropic;
  readonly id: string;

  constructor(private readonly options: ClaudeModelOptions) {
    this.client = new Anthropic({ apiKey: options.apiKey, timeout: options.timeoutMs, maxRetries: 2 });
    this.id = `${options.model}:${options.effort}`;
  }

  async generate(system: string, user: string): Promise<{ output: ModelNarrative; servedBy: string }> {
    let response: Awaited<ReturnType<typeof this.client.beta.messages.parse>>;
    try {
      response = await this.client.beta.messages.parse({
        model: this.options.model,
        max_tokens: 16_000,
        thinking: { type: "adaptive" },
        output_config: { effort: this.options.effort, format: betaZodOutputFormat(ModelNarrativeSchema) },
        // If a safety classifier declines, let the API retry on a suitable model within the same call.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system,
        messages: [{ role: "user", content: user }],
      });
    } catch (err) {
      throw mapAnthropicError(err);
    }

    if (response.stop_reason === "refusal") throw new UpstreamError("The model declined to analyze this data");
    if (response.stop_reason === "max_tokens") throw new UpstreamError("The model ran out of output tokens");
    if (!response.parsed_output) throw new UpstreamError("The model returned output that did not match the schema");
    return { output: response.parsed_output as ModelNarrative, servedBy: response.model };
  }
}

function mapAnthropicError(err: unknown): Error {
  if (err instanceof Anthropic.RateLimitError) {
    const retryAfter = Number(err.headers?.get("retry-after")) || 30;
    return new UnavailableError("llm_rate_limited", "The LLM provider is rate limiting requests", retryAfter);
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new UnavailableError("llm_auth", "The LLM provider rejected the configured API key");
  }
  // Keep the original error as `cause` so it reaches the server log but never the client.
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new UpstreamError("The LLM provider timed out", { cause: err });
  }
  if (err instanceof Anthropic.APIError) return new UpstreamError("The LLM provider returned an error", { cause: err });
  return new UpstreamError("Narrative generation failed", { cause: err });
}
