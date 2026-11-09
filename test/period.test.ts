import { describe, expect, it } from "vitest";
import { BadRequestError } from "../src/errors.js";
import { previousPeriod, resolvePeriod } from "../src/insights/period.js";

const now = new Date("2026-11-09T12:00:00Z");

describe("resolvePeriod", () => {
  it("defaults to the 30 days ending now", () => {
    const p = resolvePeriod({}, 180, now);
    expect(p.to).toEqual(now);
    expect(p.from.toISOString()).toBe("2026-10-10T12:00:00.000Z");
  });

  it("treats a date-only `to` as inclusive of that day", () => {
    const p = resolvePeriod({ from: "2026-10-01", to: "2026-10-31" }, 180, now);
    expect(p.from.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(p.to.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("clamps `to` to the start of the current hour", () => {
    const later = new Date("2026-11-09T12:34:56Z");
    expect(resolvePeriod({ from: "2026-11-01", to: "2027-01-01" }, 180, later).to).toEqual(now);
    expect(resolvePeriod({}, 180, later).to).toEqual(now);
  });

  it.each([
    [{ from: "2026-11-05", to: "2026-11-01" }, "earlier"],
    [{ from: "2025-01-01" }, "at most"],
    [{ from: "10/01/2026" }, "ISO-8601"],
    [{ from: "2026-10-01T00:00:00" }, "ISO-8601"], // no timezone
    [{ from: "2026-12-01" }, "earlier"], // in the future
  ])("rejects %o", (query, message) => {
    expect(() => resolvePeriod(query, 180, now)).toThrow(BadRequestError);
    expect(() => resolvePeriod(query, 180, now)).toThrow(message);
  });

  it("builds the preceding window of equal length", () => {
    const prev = previousPeriod({ from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z") });
    expect(prev.from.toISOString()).toBe("2026-08-31T00:00:00.000Z");
    expect(prev.to.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
});
