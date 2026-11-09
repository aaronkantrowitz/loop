import type { FactTable } from "./facts.js";
import type { ModelNarrative } from "./schema.js";

export interface ResolvedEvidence {
  factId: string;
  value: number;
  interpretation: string;
}

export interface ConfidenceAdjustment {
  reason: string;
  /** Confidence after this adjustment. */
  confidenceAfter: number;
}

export interface VerifiedNarrative {
  headline: string;
  summary: string;
  observations: { title: string; detail: string; evidence: ResolvedEvidence[] }[];
  hypothesis: {
    statement: string;
    reasoning: string;
    modelConfidence: number;
    confidence: number;
    confidenceAdjustments: ConfidenceAdjustment[];
    evidence: ResolvedEvidence[];
    alternativeExplanations: string[];
    howToConfirm: string;
  } | null;
  caveats: string[];
  verification: {
    citedFacts: number;
    unknownFactIds: string[];
    /** Numbers in the prose that match no fact (allowing for rounding and unit conversion). */
    unverifiedNumbers: string[];
    grounded: boolean;
  };
}

export interface VerificationContext {
  facts: FactTable;
  mergedPrs: number;
  dataComplete: boolean;
}

/**
 * Checks the model's output against the facts it was given.
 *
 * - Evidence ids that do not exist are dropped and reported, and the server attaches the real value
 *   to every surviving citation, so the evidence chain never contains a model-written number.
 * - Every number in the prose must match some fact (after rounding, ratio to percent, or hours to days).
 * - The model's confidence is kept for transparency, then capped by evidence quality, sample size and
 *   data completeness. Each cap is listed so a reader can see why the score moved.
 */
export function verifyNarrative(raw: ModelNarrative, ctx: VerificationContext): VerifiedNarrative {
  const unknown = new Set<string>();
  let cited = 0;

  const resolve = (evidence: ModelNarrative["observations"][number]["evidence"]): ResolvedEvidence[] =>
    evidence.flatMap((e) => {
      const value = ctx.facts.get(e.factId);
      if (value === undefined) {
        unknown.add(e.factId);
        return [];
      }
      cited++;
      return [{ factId: e.factId, value, interpretation: e.interpretation }];
    });

  const observations = raw.observations
    .map((o) => ({ title: o.title, detail: o.detail, evidence: resolve(o.evidence) }))
    // An observation with no surviving evidence is an unsupported claim; drop it.
    .filter((o) => o.evidence.length > 0);

  const proseNumbers = (text: string) => extractNumbers(text).filter((n) => !matchesAnyFact(n, ctx.facts));
  const unverified = new Set<string>([
    ...proseNumbers(raw.headline),
    ...proseNumbers(raw.summary),
    ...raw.observations.flatMap((o) => proseNumbers(`${o.title} ${o.detail}`)),
  ]);

  let hypothesis: VerifiedNarrative["hypothesis"] = null;
  if (raw.hypothesis) {
    const h = raw.hypothesis;
    const evidence = resolve(h.evidence);
    const hypothesisUnverified = proseNumbers(`${h.statement} ${h.reasoning}`);
    for (const n of hypothesisUnverified) unverified.add(n);

    const modelConfidence = clamp01(h.confidence);
    const adjustments: ConfidenceAdjustment[] = [];
    let confidence = modelConfidence;
    const cap = (limit: number, reason: string) => {
      if (confidence > limit) {
        confidence = limit;
        adjustments.push({ reason, confidenceAfter: round2(confidence) });
      }
    };
    const scale = (factor: number, reason: string) => {
      confidence *= factor;
      adjustments.push({ reason, confidenceAfter: round2(confidence) });
    };

    if (evidence.length === 0) cap(0.1, "No cited evidence matched a known fact");
    else if (evidence.length < h.evidence.length) {
      scale(evidence.length / h.evidence.length, "Some cited evidence did not match a known fact");
    }
    if (hypothesisUnverified.length > 0) scale(0.8, "Hypothesis quotes numbers that match no fact");
    if (ctx.mergedPrs < 5) cap(0.3, `Very small sample: ${ctx.mergedPrs} merged PRs in the period`);
    else if (ctx.mergedPrs < 20) cap(0.6, `Small sample: ${ctx.mergedPrs} merged PRs in the period`);
    if (!ctx.dataComplete) scale(0.8, "Sync hit its page cap, so the period may be missing older PRs");

    hypothesis = {
      statement: h.statement,
      reasoning: h.reasoning,
      modelConfidence: round2(modelConfidence),
      confidence: round2(confidence),
      confidenceAdjustments: adjustments,
      evidence,
      alternativeExplanations: h.alternativeExplanations,
      howToConfirm: h.howToConfirm,
    };
  }

  return {
    headline: raw.headline,
    summary: raw.summary,
    observations,
    hypothesis,
    caveats: raw.caveats,
    verification: {
      citedFacts: cited,
      unknownFactIds: [...unknown],
      unverifiedNumbers: [...unverified],
      grounded: unknown.size === 0 && unverified.size === 0,
    },
  };
}

/**
 * Pulls numeric literals out of prose. Dates are removed first, and digits glued to letters
 * (p90, 2x, H1) are not standalone claims, so they are skipped.
 */
export function extractNumbers(text: string): string[] {
  const withoutDates = text.replace(/\b\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?\b/g, " ");
  const matches = withoutDates.matchAll(/(?<![\w.])-?\d+(?:,\d{3})*(?:\.\d+)?%?(?![\w])/g);
  return [...matches].map((m) => m[0]);
}

/** Small counting words like "2 observations" or "top 3" are not claims about the data. */
const TRIVIAL = new Set([0, 1, 2, 3]);

export function matchesAnyFact(literal: string, facts: FactTable): boolean {
  const isPercent = literal.endsWith("%");
  const n = Number(literal.replace(/[,%]/g, ""));
  if (!Number.isFinite(n)) return true;
  if (!isPercent && TRIVIAL.has(Math.abs(n))) return true;
  const decimals = literal.replace(/[,%]/g, "").split(".")[1]?.length ?? 0;

  for (const value of facts.values()) {
    const candidates = isPercent ? [value * 100, value] : [value, value / 24, value * 24, value * 100];
    for (const c of candidates) {
      if (roundsTo(Math.abs(c), Math.abs(n), decimals)) return true;
    }
  }
  return false;
}

/** True if `value` written with `decimals` places (or rounded to a whole number) reads as `target`. */
function roundsTo(value: number, target: number, decimals: number): boolean {
  const factor = 10 ** decimals;
  if (Math.round(value * factor) / factor === target) return true;
  // Allow light rounding in prose, e.g. 41.7 hours described as "about 42".
  return decimals === 0 && Math.abs(value - target) <= Math.max(0.5, Math.abs(target) * 0.02);
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const round2 = (n: number): number => Math.round(n * 100) / 100;
