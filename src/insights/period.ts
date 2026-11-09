import { BadRequestError } from "../errors.js";
import type { Period } from "./metrics.js";

const DAY_MS = 86_400_000;
export const DEFAULT_PERIOD_DAYS = 30;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolves the query's `from`/`to` into a half-open UTC window.
 * A date-only `to` is inclusive of that day, so `from=2026-10-01&to=2026-10-31` covers all of October.
 * `to` is clamped to now, since the future has no data and an open-ended window would never be cacheable.
 */
export function resolvePeriod(
  query: { from?: string | undefined; to?: string | undefined },
  maxDays: number,
  now: Date = new Date(),
): Period {
  const toRaw = query.to ? parseInstant(query.to, "to") : now;
  const to = query.to && DATE_ONLY.test(query.to) ? new Date(toRaw.getTime() + DAY_MS) : toRaw;
  const clampedTo = to > now ? now : to;
  const from = query.from ? parseInstant(query.from, "from") : new Date(clampedTo.getTime() - DEFAULT_PERIOD_DAYS * DAY_MS);

  if (from >= clampedTo) throw new BadRequestError("`from` must be earlier than `to` (and not in the future)");
  if (clampedTo.getTime() - from.getTime() > maxDays * DAY_MS) {
    throw new BadRequestError(`The period may span at most ${maxDays} days`);
  }
  return { from, to: clampedTo };
}

/** The window of equal length immediately before `period`, used for period-over-period comparison. */
export function previousPeriod(period: Period): Period {
  const span = period.to.getTime() - period.from.getTime();
  return { from: new Date(period.from.getTime() - span), to: period.from };
}

function parseInstant(value: string, field: string): Date {
  // Accept a calendar date or a full ISO-8601 timestamp with an explicit offset; reject anything
  // Date.parse would guess at (e.g. "10/11/2026" or timestamps without a zone).
  const iso = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;
  const ms = iso.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) throw new BadRequestError(`\`${field}\` must be an ISO-8601 date (YYYY-MM-DD) or timestamp with a timezone`);
  return new Date(ms);
}
