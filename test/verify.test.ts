import { describe, expect, it } from "vitest";
import type { ModelNarrative } from "../src/narrative/schema.js";
import { extractNumbers, matchesAnyFact, verifyNarrative } from "../src/narrative/verify.js";

const facts = new Map<string, number>([
  ["current.flow.prsMerged", 48],
  ["current.flow.mergedWithoutReviewRate", 0.271],
  ["current.flow.medianHoursToFirstReview", 30.5],
  ["previous.flow.medianHoursToFirstReview", 9.2],
  ["current.reviewers[alice].reviews", 61],
]);

const base: ModelNarrative = {
  headline: "Review wait times tripled",
  summary: "48 PRs merged. Median first review took 30.5 hours, up from 9.2.",
  observations: [
    {
      title: "Slower reviews",
      detail: "About 1.3 days to first review.",
      evidence: [{ factId: "current.flow.medianHoursToFirstReview", interpretation: "slow" }],
    },
  ],
  hypothesis: {
    statement: "alice is a review bottleneck",
    reasoning: "alice did 61 reviews while 27% of PRs merged without review.",
    confidence: 0.8,
    evidence: [
      { factId: "current.reviewers[alice].reviews", interpretation: "most reviews" },
      { factId: "current.reviewers[bob].reviews", interpretation: "made up" },
    ],
    alternativeExplanations: ["holiday season"],
    howToConfirm: "Check review assignment rules",
  },
  caveats: [],
};

describe("verifyNarrative", () => {
  it("attaches server-side values, drops unknown facts and scales confidence", () => {
    const v = verifyNarrative(base, { facts, mergedPrs: 48, dataComplete: true });
    expect(v.observations[0]?.evidence).toEqual([
      { factId: "current.flow.medianHoursToFirstReview", value: 30.5, interpretation: "slow" },
    ]);
    expect(v.hypothesis?.evidence.map((e) => e.factId)).toEqual(["current.reviewers[alice].reviews"]);
    expect(v.verification.unknownFactIds).toEqual(["current.reviewers[bob].reviews"]);
    expect(v.verification.unverifiedNumbers).toEqual([]);
    expect(v.hypothesis?.modelConfidence).toBe(0.8);
    expect(v.hypothesis?.confidence).toBe(0.4);
    expect(v.verification.grounded).toBe(false);
  });

  it("flags numbers that match no fact and caps confidence on small samples", () => {
    const v = verifyNarrative(
      { ...base, summary: "Merges rose 340% this month.", hypothesis: { ...base.hypothesis!, evidence: base.hypothesis!.evidence.slice(0, 1) } },
      { facts, mergedPrs: 8, dataComplete: true },
    );
    expect(v.verification.unverifiedNumbers).toEqual(["340%"]);
    expect(v.hypothesis?.confidence).toBe(0.6);
    expect(v.hypothesis?.confidenceAdjustments.at(-1)?.reason).toContain("Small sample");
  });

  it("drops observations whose evidence is all invalid and keeps null hypotheses null", () => {
    const v = verifyNarrative(
      { ...base, observations: [{ title: "x", detail: "y", evidence: [{ factId: "nope", interpretation: "" }] }], hypothesis: null },
      { facts, mergedPrs: 48, dataComplete: true },
    );
    expect(v.observations).toEqual([]);
    expect(v.hypothesis).toBeNull();
  });
});

describe("number grounding", () => {
  it("extracts standalone numbers but not dates or identifiers", () => {
    expect(extractNumbers("On 2026-10-01, p90 hit 41.5 hours for 1,200 PRs (27%)")).toEqual(["41.5", "1,200", "27%"]);
  });

  it("accepts rounding, percentages and hour to day conversion", () => {
    expect(matchesAnyFact("27%", facts)).toBe(true); // 0.271
    expect(matchesAnyFact("27.1%", facts)).toBe(true);
    expect(matchesAnyFact("31", facts)).toBe(true); // 30.5 rounded
    expect(matchesAnyFact("1.3", facts)).toBe(true); // 30.5 hours in days
    expect(matchesAnyFact("2", facts)).toBe(true); // trivial counting word
    expect(matchesAnyFact("75", facts)).toBe(false);
    expect(matchesAnyFact("12.4%", facts)).toBe(false);
  });
});
