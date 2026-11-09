import type { InsightsReport } from "../insights/service.js";

/**
 * A fact is one number from the report with a stable, human-readable id such as
 * `current.flow.prsMerged` or `current.reviewers[alice].reviews`. The model may only cite facts by id,
 * and the server, not the model, attaches the value. That keeps every number in the evidence chain
 * traceable to the computed report.
 */
export interface Fact {
  id: string;
  value: number;
}

export type FactTable = ReadonlyMap<string, number>;

export function buildFacts(report: InsightsReport): Fact[] {
  const facts: Fact[] = [];
  const add = (id: string, value: number | null) => {
    if (value !== null && Number.isFinite(value)) facts.push({ id, value });
  };
  const addObject = (prefix: string, obj: object) => {
    for (const [key, value] of Object.entries(obj)) add(`${prefix}.${key}`, typeof value === "number" ? value : null);
  };

  addObject("current.flow", report.current.flow);
  addObject("current.concentration", report.current.concentration);
  addObject("current.totals", report.current.totals);
  addObject("current.dataQuality", report.current.dataQuality);
  addObject("previous.flow", report.previous.flow);
  addObject("previous.concentration", report.previous.concentration);
  addObject("previous.totals", report.previous.totals);

  for (const c of report.changes) {
    add(`change.${c.metric}.delta`, c.delta);
    add(`change.${c.metric}.deltaRatio`, c.deltaRatio);
  }
  for (const c of report.current.contributors) {
    const { login, ...stats } = c;
    addObject(`current.contributors[${login}]`, stats);
  }
  for (const r of report.current.reviewers) {
    const { login, ...stats } = r;
    addObject(`current.reviewers[${login}]`, stats);
  }
  for (const p of report.current.reviewPairs) {
    add(`current.reviewPairs[${p.reviewer}->${p.author}].reviews`, p.reviews);
  }
  return facts;
}

export const toFactTable = (facts: readonly Fact[]): FactTable => new Map(facts.map((f) => [f.id, f.value]));
