import { describe, expect, test } from "vitest";
import { addDays, addMonths, formatTemporal, monthWeeks, parseTemporal, temporalSpec, withDate, withTime } from "./temporal";

describe("temporalSpec", () => {
  test("mysql types and precision", () => {
    expect(temporalSpec("date", "mysql")).toEqual({ kind: "date", fraction: 0, trim: false, zone: false });
    expect(temporalSpec("time", "mysql")).toEqual({ kind: "time", fraction: 0, trim: false, zone: false });
    expect(temporalSpec("time(6)", "mysql")).toEqual({ kind: "time", fraction: 6, trim: false, zone: false });
    expect(temporalSpec("datetime", "mysql")).toEqual({ kind: "datetime", fraction: 0, trim: false, zone: false });
    expect(temporalSpec("DATETIME(3)", "mysql")).toEqual({ kind: "datetime", fraction: 3, trim: false, zone: false });
    expect(temporalSpec("timestamp(6)", "mysql")).toEqual({ kind: "datetime", fraction: 6, trim: false, zone: false });
    expect(temporalSpec("year", "mysql")).toBeNull();
    expect(temporalSpec("varchar(10)", "mysql")).toBeNull();
  });

  test("postgres types: no precision means up to microseconds, trailing zeros dropped", () => {
    expect(temporalSpec("date", "postgres")).toEqual({ kind: "date", fraction: 0, trim: true, zone: false });
    expect(temporalSpec("time without time zone", "postgres")).toEqual({ kind: "time", fraction: 6, trim: true, zone: false });
    expect(temporalSpec("time(0) with time zone", "postgres")).toEqual({ kind: "time", fraction: 0, trim: true, zone: true });
    expect(temporalSpec("timestamp without time zone", "postgres")).toEqual({ kind: "datetime", fraction: 6, trim: true, zone: false });
    expect(temporalSpec("timestamp(3) without time zone", "postgres")).toEqual({ kind: "datetime", fraction: 3, trim: true, zone: false });
    expect(temporalSpec("timestamp(6) with time zone", "postgres")).toEqual({ kind: "datetime", fraction: 6, trim: true, zone: true });
    expect(temporalSpec("timestamptz", "postgres")).toEqual({ kind: "datetime", fraction: 6, trim: true, zone: true });
    expect(temporalSpec("timestamp without time zone[]", "postgres")).toBeNull();
    expect(temporalSpec("interval", "postgres")).toBeNull();
  });

  test("sqlite declared types", () => {
    expect(temporalSpec("DATE", "sqlite")?.kind).toBe("date");
    expect(temporalSpec("DATETIME", "sqlite")).toEqual({ kind: "datetime", fraction: 3, trim: true, zone: false });
    expect(temporalSpec("TEXT", "sqlite")).toBeNull();
  });
});

const roundTrip = (text: string, type: string, dialect: "mysql" | "postgres" | "sqlite") => {
  const spec = temporalSpec(type, dialect)!;
  const v = parseTemporal(text, spec);
  expect(v, text).not.toBeNull();
  return formatTemporal(v!, spec);
};

describe("parse and format keep the grid's text unchanged", () => {
  test.each([
    ["2026-03-01", "date", "mysql"],
    ["13:04:05", "time", "mysql"],
    ["13:04:05.000120", "time(6)", "mysql"],
    ["2026-03-01 13:04:05", "datetime", "mysql"],
    ["2026-03-01 13:04:05.120", "datetime(3)", "mysql"],
    ["2026-03-01 13:04:05.000001", "timestamp(6)", "mysql"],
    ["2026-03-01 13:04:05.12", "timestamp(6) without time zone", "postgres"],
    ["2026-03-01 13:04:05", "timestamp without time zone", "postgres"],
    ["2026-03-01 13:04:05.5+00", "timestamp with time zone", "postgres"],
    ["2026-03-01 13:04:05+05:30", "timestamptz", "postgres"],
    ["13:04:05-08", "time with time zone", "postgres"],
    ["2026-03-01 13:04:05", "DATETIME", "sqlite"],
  ] as const)("%s as %s (%s)", (text, type, dialect) => {
    expect(roundTrip(text, type, dialect)).toBe(text);
  });
});

describe("parseTemporal", () => {
  const dt3 = temporalSpec("datetime(3)", "mysql")!;
  test("reads the parts", () => {
    expect(parseTemporal("2026-03-01 13:04:05.120", dt3)).toEqual({
      date: { y: 2026, m: 3, d: 1 },
      time: { h: 13, mi: 4, s: 5, frac: "120" },
      zone: "",
    });
    expect(parseTemporal("2026-03-01T07:08", dt3)?.time).toEqual({ h: 7, mi: 8, s: 0, frac: "" });
    expect(parseTemporal("2026-03-01", dt3)).toEqual({ date: { y: 2026, m: 3, d: 1 }, time: null, zone: "" });
  });

  test("keeps the offset text exactly as typed", () => {
    const tz = temporalSpec("timestamptz", "postgres")!;
    expect(parseTemporal("2026-03-01 13:04:05+0530", tz)?.zone).toBe("+0530");
    expect(parseTemporal("2026-03-01 13:04:05Z", tz)?.zone).toBe("Z");
  });

  test("gives null for what the picker cannot show", () => {
    const d = temporalSpec("date", "postgres")!;
    for (const t of ["", "infinity", "2026-02-30", "2026-13-01", "0000-00-00", "2026-3-1", "0044-03-15 BC"]) expect(parseTemporal(t, d), t).toBeNull();
    expect(parseTemporal("25:00:00", temporalSpec("time", "mysql")!)).toBeNull();
    expect(parseTemporal("838:59:59", temporalSpec("time", "mysql")!)).toBeNull();
    // MySQL has no zone types: an offset is not a value the picker understands.
    expect(parseTemporal("2026-03-01 13:04:05+00", dt3)).toBeNull();
  });
});

describe("formatTemporal follows the column's precision", () => {
  const time = { h: 9, mi: 5, s: 7, frac: "1" };
  const date = { y: 2026, m: 3, d: 1 };
  test("mysql pads the fraction to the precision", () => {
    expect(formatTemporal({ date, time, zone: "" }, temporalSpec("datetime(3)", "mysql")!)).toBe("2026-03-01 09:05:07.100");
    expect(formatTemporal({ date, time, zone: "" }, temporalSpec("datetime", "mysql")!)).toBe("2026-03-01 09:05:07");
    expect(formatTemporal({ date: null, time: { ...time, frac: "1234567" }, zone: "" }, temporalSpec("time(6)", "mysql")!)).toBe("09:05:07.123456");
  });
  test("postgres drops trailing zeros and an empty fraction", () => {
    const ts = temporalSpec("timestamp(6) without time zone", "postgres")!;
    expect(formatTemporal({ date, time: { ...time, frac: "120" }, zone: "" }, ts)).toBe("2026-03-01 09:05:07.12");
    expect(formatTemporal({ date, time: { ...time, frac: "000" }, zone: "" }, ts)).toBe("2026-03-01 09:05:07");
  });
  test("a datetime with no time yet gets midnight", () => {
    expect(formatTemporal({ date, time: null, zone: "" }, temporalSpec("datetime", "mysql")!)).toBe("2026-03-01 00:00:00");
  });
});

describe("withDate and withTime start from the value or a default", () => {
  const spec = temporalSpec("timestamptz", "postgres")!;
  test("a picked day keeps the time and the offset", () => {
    const v = parseTemporal("2026-03-01 13:04:05+00", spec);
    expect(formatTemporal(withDate(v, { y: 2026, m: 4, d: 2 }), spec)).toBe("2026-04-02 13:04:05+00");
  });
  test("a changed time keeps the day", () => {
    const v = parseTemporal("2026-03-01 13:04:05+00", spec);
    expect(formatTemporal(withTime(v, { h: 1, mi: 2, s: 3, frac: "" }), spec)).toBe("2026-03-01 01:02:03+00");
  });
  test("from nothing, a time gets today's date", () => {
    const today = new Date(2026, 9, 29);
    expect(formatTemporal(withTime(null, { h: 1, mi: 2, s: 3, frac: "" }, today), spec)).toBe("2026-10-29 01:02:03");
  });
});

describe("calendar math", () => {
  test("monthWeeks starts on Sunday and pads with nulls", () => {
    // March 2026 starts on a Sunday and has 31 days.
    const weeks = monthWeeks(2026, 3);
    expect(weeks[0]).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(weeks[4]).toEqual([29, 30, 31, null, null, null, null]);
    // February 2026 starts on a Sunday too; April 2026 on a Wednesday.
    expect(monthWeeks(2026, 4)[0]).toEqual([null, null, null, 1, 2, 3, 4]);
  });
  test("addDays and addMonths cross months, years and short months", () => {
    expect(addDays({ y: 2026, m: 3, d: 31 }, 1)).toEqual({ y: 2026, m: 4, d: 1 });
    expect(addDays({ y: 2026, m: 1, d: 1 }, -1)).toEqual({ y: 2025, m: 12, d: 31 });
    expect(addMonths({ y: 2026, m: 1, d: 31 }, 1)).toEqual({ y: 2026, m: 2, d: 28 });
    expect(addMonths({ y: 2026, m: 12, d: 15 }, 1)).toEqual({ y: 2027, m: 1, d: 15 });
    expect(addMonths({ y: 2024, m: 3, d: 31 }, -1)).toEqual({ y: 2024, m: 2, d: 29 });
  });
});
