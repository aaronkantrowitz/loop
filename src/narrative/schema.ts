import { z } from "zod";

/**
 * What the model must return. Kept free of numeric range constraints so it maps cleanly onto
 * structured-output JSON Schema; ranges are enforced in verification instead.
 */
const EvidenceSchema = z.object({
  factId: z.string().describe("Exact id of a fact from the provided fact table"),
  interpretation: z.string().describe("One short clause on what this number shows and why it matters here"),
});

export const ModelNarrativeSchema = z.object({
  headline: z.string().describe("One sentence, at most ~15 words, naming the single most important finding"),
  summary: z.string().describe("3 to 5 plain sentences on what is interesting or unusual in the period"),
  observations: z
    .array(
      z.object({
        title: z.string(),
        detail: z.string(),
        evidence: z.array(EvidenceSchema),
      }),
    )
    .describe("2 to 4 notable observations, each backed by at least one fact"),
  hypothesis: z
    .object({
      statement: z.string().describe("Most likely root cause of the main observation"),
      reasoning: z.string().describe("How the cited evidence leads to the statement, step by step"),
      confidence: z.number().describe("0 to 1. How strongly the data supports the statement"),
      evidence: z.array(EvidenceSchema),
      alternativeExplanations: z.array(z.string()).describe("Other plausible causes the data cannot rule out"),
      howToConfirm: z.string().describe("What additional data would confirm or refute the hypothesis"),
    })
    .nullable()
    .describe("Null when the data does not support any root-cause hypothesis"),
  caveats: z.array(z.string()).describe("Limitations of the data that affect the reading"),
});

export type ModelNarrative = z.infer<typeof ModelNarrativeSchema>;
