import { describe, expect, it } from "vitest";
import {
	Atom,
	avg,
	Decimal,
	decimal,
	isNativeAvailable,
	max,
	median,
	min,
	mode,
	money,
	stddev,
	sum,
} from "../../src/index.js";

describe("Atom", () => {
	it("exposes native availability flag", () => {
		expect(typeof isNativeAvailable()).toBe("boolean");
	});

	it("normalizes decimal strings", () => {
		expect(new Decimal("001.2300").toString()).toBe("1.23");
		expect(new Decimal("-0.000").toString()).toBe("0");
	});

	it("adds and subtracts exactly", () => {
		expect(new Decimal("0.1").plus("0.2").toString()).toBe("0.3");
		expect(new Decimal("10").minus("2.5").toString()).toBe("7.5");
	});

	it("multiplies exactly", () => {
		expect(new Decimal("1.2").times("3").toString()).toBe("3.6");
		expect(new Decimal("2.50").times("2").toString()).toBe("5");
	});

	it("divides with precision", () => {
		expect(new Decimal("1").div("8", { precision: 6 }).toString()).toBe(
			"0.125",
		);
		expect(new Decimal("10").div("4", { precision: 4 }).toString()).toBe("2.5");
	});

	it("compares correctly", () => {
		const a = new Decimal("1.20");
		expect(a.eq("1.2")).toBe(true);
		expect(a.gt("1.19")).toBe(true);
		expect(a.lt("1.21")).toBe(true);
	});

	it("throws on division by zero", () => {
		expect(() => new Decimal("1").div("0")).toThrow("Division by zero");
	});

	it("supports Atom min, max and sum", () => {
		expect(Atom.min("4.2", "4.19", 10n).toString()).toBe("4.19");
		expect(Atom.max("4.2", "4.19", 10n).toString()).toBe("10");
		expect(Atom.sum("1.2", "2.3", "3.5").toString()).toBe("7");
		expect(Atom.sum(["1.2", "2.3", "3.5"]).toString()).toBe("7");
	});

	it("supports Atom namespace helpers", () => {
		expect(decimal("1.25").plus("0.75").toString()).toBe("2");
		expect(Atom.sum("1.2", "2.3", "3.5").toString()).toBe("7");
		expect(Atom.min("4.2", "4.19", 10n).toString()).toBe("4.19");
		expect(Atom.max("4.2", "4.19", 10n).toString()).toBe("10");
	});

	it("supports direct named exports for helpers", () => {
		expect(sum("1", "2", "3").toString()).toBe("6");
		expect(sum(["1", "2", "3"]).toString()).toBe("6");
		expect(avg("1", "2", "3").toString()).toBe("2");
		expect(avg(["1", "2", "3"]).toString()).toBe("2");
		expect(median("1", "3", "2").toString()).toBe("2");
		expect(median(["1", "3", "2"], { precision: 4 }).toString()).toBe("2");
		expect(mode("1", "2", "2").map((x) => x.toString())).toEqual(["2"]);
		expect(mode(["1", "2", "2"]).map((x) => x.toString())).toEqual(["2"]);
		expect(stddev("2", "4", "4", "4", "5", "5", "7", "9").toString()).toBe("2");
		expect(
			stddev(["2", "4", "4", "4", "5", "5", "7", "9"], {
				sample: true,
			}).toString(),
		).toBe("2.138089935299395077");
		expect(min("2.1", "2.01").toString()).toBe("2.01");
		expect(min(["2.1", "2.01"]).toString()).toBe("2.01");
		expect(max("2.1", "2.01").toString()).toBe("2.1");
		expect(max(["2.1", "2.01"]).toString()).toBe("2.1");
	});

	it("supports median, mode and stddev on Atom", () => {
		expect(Atom.median("1", "3", "2").toString()).toBe("2");
		expect(Atom.median("1", "2", "3", "4").toString()).toBe("2.5");
		expect(Atom.median("1", "2", "3").toString()).toBe("2");

		expect(Atom.mode("1", "2", "2", "3").map((x) => x.toString())).toEqual([
			"2",
		]);
		expect(Atom.mode("1", "1", "2", "2", "3").map((x) => x.toString())).toEqual(
			["1", "2"],
		);
		expect(Atom.mode("1", "2", "3")).toEqual([]);
		expect(Atom.mode("1", "2", "2").map((x) => x.toString())).toEqual(["2"]);

		expect(Atom.stddev("2", "4", "4", "4", "5", "5", "7", "9").toString()).toBe(
			"2",
		);
		expect(
			Atom.stddev(["2", "4", "4", "4", "5", "5", "7", "9"], {
				sample: true,
			}).toString(),
		).toBe("2.138089935299395077");
		expect(Atom.stddev("2", "4", "4", "4", "5", "5", "7", "9").toString()).toBe(
			"2",
		);
	});

	it("supports mod operation", () => {
		expect(new Decimal("10.5").mod("3").toString()).toBe("1.5");
		expect(() => new Decimal("1").mod("0")).toThrow("Division by zero");
	});

	it("supports pow operation", () => {
		expect(new Decimal("1.5").pow(3).toString()).toBe("3.375");
		expect(new Decimal("2").pow(-2).toString()).toBe("0.25");
		expect(() => new Decimal("2").pow(-2147483648)).toThrow(/Invalid exponent/);
	});

	it("supports sqrt operation", () => {
		expect(new Decimal("2").sqrt({ precision: 6 }).toString()).toBe("1.414213");
		expect(
			new Decimal("2").sqrt({ precision: 3, mode: "half-up" }).toString(),
		).toBe("1.414");
		expect(
			new Decimal("4").sqrt({ precision: 3, mode: "half-up" }).toString(),
		).toBe("2");
		expect(
			new Decimal("6.25").sqrt({ precision: 2, mode: "half-even" }).toString(),
		).toBe("2.5");
		expect(
			new Decimal("6.3").sqrt({ precision: 0, mode: "half-even" }).toString(),
		).toBe("3");
		expect(() => new Decimal("-1").sqrt()).toThrow("Cannot compute sqrt");
	});

	it("supports instance min, max and clamp", () => {
		const v = new Decimal("5.4");
		expect(v.min("5.5").toString()).toBe("5.4");
		expect(v.max("5.5").toString()).toBe("5.5");
		expect(v.clamp("0", "10").toString()).toBe("5.4");
		expect(v.clamp("5.5", "10").toString()).toBe("5.5");
		expect(v.clamp("0", "5.3").toString()).toBe("5.3");
	});

	it("supports abs/neg and sign helpers", () => {
		const a = new Decimal("-7.5");
		expect(a.abs().toString()).toBe("7.5");
		expect(a.neg().toString()).toBe("7.5");
		expect(new Decimal("7.5").neg().toString()).toBe("-7.5");
		expect(new Decimal("0").isZero()).toBe(true);
		expect(new Decimal("7.5").isPositive()).toBe(true);
		expect(new Decimal("-7.5").isNegative()).toBe(true);
	});

	it("supports trunc, floor, ceil and round modes", () => {
		const v = new Decimal("12.3456");
		expect(v.trunc(2).toString()).toBe("12.34");
		expect(v.floor(2).toString()).toBe("12.34");
		expect(v.ceil(2).toString()).toBe("12.35");
		expect(v.round(2, "half-up").toString()).toBe("12.35");
		expect(new Decimal("12.345").round(2, "half-even").toString()).toBe(
			"12.34",
		);
		expect(new Decimal("12.355").round(2, "half-even").toString()).toBe(
			"12.36",
		);
	});

	it("rounding handles negatives correctly", () => {
		const v = new Decimal("-1.234");
		expect(v.trunc(2).toString()).toBe("-1.23");
		expect(v.floor(2).toString()).toBe("-1.24");
		expect(v.ceil(2).toString()).toBe("-1.23");
		expect(v.round(2, "half-up").toString()).toBe("-1.23");
	});

	it("supports toFixed with padding", () => {
		expect(new Decimal("12").toFixed(2)).toBe("12.00");
		expect(new Decimal("12.3").toFixed(2)).toBe("12.30");
		expect(new Decimal("12.345").toFixed(2, "half-up")).toBe("12.35");
	});

	it("supports minor units conversion", () => {
		expect(Decimal.fromMinorUnits(12345, 2).toString()).toBe("123.45");
		expect(new Decimal("123.45").toMinorUnits(2)).toBe(12345n);
		expect(new Decimal("123.4").toMinorUnits(2)).toBe(12340n);
		expect(
			new Decimal("123.456").toMinorUnits(2, { exact: false, mode: "half-up" }),
		).toBe(12346n);
	});

	it("supports percent helpers", () => {
		expect(new Decimal("200").percent("15").toString()).toBe("30");
		expect(new Decimal("200").applyPercent("15").toString()).toBe("230");
		expect(new Decimal("30").percentageOf("200").toString()).toBe("15");
	});

	it("supports integer and range helpers", () => {
		expect(new Decimal("10").isInteger()).toBe(true);
		expect(new Decimal("10.1").isInteger()).toBe(false);
		expect(new Decimal("5").between("5", "10")).toBe(true);
		expect(new Decimal("5").between("5", "10", { inclusive: false })).toBe(
			false,
		);
	});

	it("supports quantize", () => {
		expect(new Decimal("10.27").quantize("0.05").toString()).toBe("10.25");
		expect(new Decimal("10.28").quantize("0.05").toString()).toBe("10.3");
		// The scale comes from the step, and only from the step. This line used
		// to pass `{ precision: 0 }`, which was validated and then ignored — the
		// answer is the same with it and without it.
		expect(new Decimal("1.06").quantize("0.1").toString()).toBe("1.1");
	});

	it("keeps a rounded amount at the scale its currency has", () => {
		// `times` and `div` declared the full MoneyOptions and forwarded `mode`
		// alone, so these two arguments were accepted and overwritten. They are
		// gone from the type: a multiplied amount of money is still money.
		const price = money("13.33", "EUR");
		expect(price.times("1.5").scale).toBe(2);
		expect(price.times("1.333").toString()).toBe("17.77 EUR");
		expect(price.times("1.5", { mode: "half-even" }).toString()).toBe(
			"20.00 EUR",
		);
	});

	it("supports allocate", () => {
		const parts = new Decimal("10")
			.allocate([1, 1, 1])
			.map((item) => item.toString());
		expect(parts).toEqual(["4", "3", "3"]);

		const negative = new Decimal("-10")
			.allocate([1, 1, 1])
			.map((item) => item.toString());
		expect(negative).toEqual(["-4", "-3", "-3"]);

		const cents = new Decimal("10.00")
			.allocate([1, 1, 1])
			.map((item) => item.toString());
		expect(cents).toEqual(["3.34", "3.33", "3.33"]);
	});

	it("supports locale parse/format helpers", () => {
		const parsed = Decimal.parseLocale("1 234,56", "fr-FR");
		expect(parsed.toString()).toBe("1234.56");
		expect(parsed.toLocale("en-US")).toBe("1,234.56");
		expect(Atom.parseLocale("1 234,56", "fr-FR").toString()).toBe("1234.56");
		expect(Decimal.parseLocale("١٬٢٣٤٫٥٦", "ar-EG").toString()).toBe("1234.56");
		expect(() => Decimal.parseLocale("1,,2", "en-US")).toThrow(
			/Invalid localized decimal/,
		);
		expect(() => Decimal.parseLocale("12,34,567", "en-US")).toThrow(
			/Invalid localized decimal/,
		);
	});

	it("supports toParts for scaled representation", () => {
		expect(new Decimal("12.34").toParts()).toEqual({ value: 1234n, scale: 2 });
		expect(new Decimal("-0.500").toParts()).toEqual({ value: -500n, scale: 3 });
		expect(Decimal.fromMinorUnits(1000n, 2).toParts()).toEqual({
			value: 1000n,
			scale: 2,
		});
	});
});

// === Audit fixes — fallback, toLocale precision, mode/round guards ===

import { __overrideNativeForTesting, nativeAtom } from "../../src/native.js";

describe("atom > JS fallback when native is unavailable", () => {
	it("all native-backed ops keep working when native is disabled", () => {
		__overrideNativeForTesting(null);
		try {
			const a = new Decimal("1.23");
			const b = new Decimal("4.56");
			expect(a.plus(b).toString()).toBe("5.79");
			expect(a.minus(b).toString()).toBe("-3.33");
			expect(a.times(b).toString()).toBe("5.6088");
			expect(a.div(b, { precision: 4 }).toString()).toBe("0.2697");
			expect(a.cmp(b)).toBe(-1);
			expect(new Decimal("10.5").mod("3").toString()).toBe("1.5");
			expect(new Decimal("2").pow(3).toString()).toBe("8");
			expect(new Decimal("4").sqrt().toString()).toBe("2");
		} finally {
			__overrideNativeForTesting(undefined);
		}
	});

	it("keeps nativeAtom fail-loud for direct internal callers", () => {
		__overrideNativeForTesting(null);
		try {
			expect(() => nativeAtom()).toThrow(/ATOM_NAPI_DISABLED/);
		} finally {
			__overrideNativeForTesting(undefined);
		}
	});
});

describe("atom > toLocale precision (audit fix)", () => {
	it("preserves every digit on values beyond Number precision", () => {
		// 18 significant digits — well past Number.MAX_SAFE_INTEGER
		const d = new Decimal("9999999999999999.99");
		const formatted = d.toLocale("en-US");
		// Strip group separators for the digit-preservation check
		const digits = formatted.replace(/[,.\s]/g, "");
		expect(digits).toBe("999999999999999999");
	});

	it("preserves precision on a 30-digit integer", () => {
		const d = new Decimal("123456789012345678901234567890");
		const formatted = d.toLocale("en-US");
		expect(formatted.replace(/[,\s]/g, "")).toBe(
			"123456789012345678901234567890",
		);
	});
});

describe("atom > round mode guard (audit fix)", () => {
	it("toScale rejects an unknown rounding mode", () => {
		const d = new Decimal("1.5");
		expect(() => d.toScale(0, "nuke" as never)).toThrow(
			/Unknown rounding mode/,
		);
	});
});

describe("atom > mode aggregate semantics (documented gap)", () => {
	it("returns [] when no value repeats — documented in JSDoc", () => {
		expect(Atom.mode("1", "2", "3")).toEqual([]);
		expect(Atom.mode([])).toEqual([]);
	});
});

describe("atom > unsafe decimal inputs", () => {
	// `Number.MAX_SAFE_INTEGER + 1` rather than the literal one past it: the
	// literal does not survive being written down — it is read back as this
	// value — so the test would have been asserting about a number it never
	// passed.
	it("rejects unsafe JS integer inputs", () => {
		expect(() => new Decimal(Number.MAX_SAFE_INTEGER + 1)).toThrow(
			/Unsafe integer/,
		);
	});

	it("accepts finite number inputs written by JS in scientific notation", () => {
		expect(new Decimal(1e-7).toString()).toBe("0.0000001");
		expect(new Decimal(1.23e5).toString()).toBe("123000");
		expect(new Decimal(-1.2e-7).toString()).toBe("-0.00000012");
	});

	it("rejects digit-free decimal strings", () => {
		expect(() => new Decimal(".")).toThrow(/Invalid decimal/);
		expect(() => new Decimal("+")).toThrow(/Invalid decimal/);
		expect(() => new Decimal("-")).toThrow(/Invalid decimal/);
	});

	it("rejects unsafe integer inputs in minor-unit and allocation helpers", () => {
		expect(() =>
			Decimal.fromMinorUnits(Number.MAX_SAFE_INTEGER + 1, 2),
		).toThrow(/Unsafe integer/);
		expect(() =>
			new Decimal("10").allocate([Number.MAX_SAFE_INTEGER + 1]),
		).toThrow(/Unsafe integer/);
	});

	it("bounds scales and exponents before crossing NAPI", () => {
		expect(() => new Decimal("1").div("3", { precision: 10_001 })).toThrow(
			/Invalid scale/,
		);
		expect(() => new Decimal("2").pow(100_001)).toThrow(/Invalid exponent/);
		expect(() => new Decimal("2").pow(1.5)).toThrow(/Invalid exponent/);
	});
});

describe("atom > exact rounding regressions", () => {
	it("rounds sqrt exactly across all non-trunc modes", () => {
		expect(
			new Decimal("2").sqrt({ precision: 0, mode: "floor" }).toString(),
		).toBe("1");
		expect(
			new Decimal("2").sqrt({ precision: 0, mode: "ceil" }).toString(),
		).toBe("2");
		expect(
			new Decimal("4").sqrt({ precision: 0, mode: "ceil" }).toString(),
		).toBe("2");
		expect(
			new Decimal("6.25").sqrt({ precision: 0, mode: "half-up" }).toString(),
		).toBe("3");
		expect(
			new Decimal("6.25").sqrt({ precision: 0, mode: "half-even" }).toString(),
		).toBe("2");
	});

	it("quantize uses exact rational rounding modes", () => {
		expect(
			new Decimal("1.06").quantize("0.1", { mode: "floor" }).toString(),
		).toBe("1");
		expect(
			new Decimal("1.01").quantize("0.1", { mode: "ceil" }).toString(),
		).toBe("1.1");
		expect(
			new Decimal("1.25").quantize("0.5", { mode: "half-even" }).toString(),
		).toBe("1");
		expect(
			new Decimal("-1.25").quantize("0.5", { mode: "half-up" }).toString(),
		).toBe("-1.5");
	});
});

describe("atom > locale validation regressions", () => {
	it("accepts valid localized grouping and parenthesized negatives", () => {
		expect(Decimal.parseLocale("12,34,567.89", "en-IN").toString()).toBe(
			"1234567.89",
		);
		expect(Decimal.parseLocale("(123)", "en-US").toString()).toBe("-123");
	});

	it("rejects malformed localized fractions and Rosetta grouping", () => {
		expect(() => Decimal.parseLocale("1,234.5.6", "en-US")).toThrow(
			/Invalid localized decimal/,
		);
		const stub = {
			getNumberFormatData: () => ({
				decimal: ";",
				group: "_",
				minus: "-",
				plusSign: "+",
			}),
			formatNumberString: (value: string) => value,
		};
		expect(() => Decimal.parseLocale("1__234;56", stub)).toThrow(
			/Invalid localized decimal/,
		);
	});
});

describe("atom > aggregate error paths", () => {
	it("keeps empty aggregate guards except mode/sum", () => {
		expect(() => Atom.avg([])).toThrow(/at least one/);
		expect(() => Atom.min([])).toThrow(/at least one/);
		expect(() => Atom.max([])).toThrow(/at least one/);
		expect(() => Atom.median([])).toThrow(/at least one/);
		expect(() => Atom.stddev([], { sample: true })).toThrow(/at least one/);
		expect(() => Atom.stddev(["1"], { sample: true })).toThrow(/at least two/);
	});
});

describe("atom > what an aggregate accepts as a value", () => {
	it("names the argument it cannot use instead of failing inside Decimal", () => {
		// The variadic form used to be asserted into shape, so anything else
		// reached `new Decimal(...)` and came back as
		// `input.trim is not a function` — an error naming neither the value nor
		// the call it came from.
		expect(() => Atom.sum("1", { precision: 2 } as never)).toThrow(
			/Atom aggregates take a string, number, bigint or Decimal, got object/,
		);
		expect(() => Atom.min("1", null as never)).toThrow(/got null/);
	});

	it("still takes the two shapes it documents", () => {
		expect(Atom.sum("1.10", "2.20", "3.33").toString()).toBe("6.63");
		expect(Atom.sum(["1.10", "2.20", "3.33"]).toString()).toBe("6.63");
		expect(Atom.median(["1", "2"], { precision: 4 }).toString()).toBe("1.5");
		expect(Atom.stddev(["2", "4"], { sample: true }).toString()).toBe(
			new Decimal("2").sqrt().toString(),
		);
	});
});
