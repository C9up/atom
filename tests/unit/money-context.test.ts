import { describe, expect, it } from "vitest";
import {
	Atom,
	configureAtomContext,
	Decimal,
	getAtomContext,
	Money,
	money,
	resetAtomContext,
	withAtomContext,
} from "../../src/index.js";

describe("Decimal safe parsing", () => {
	it("exposes parse / tryParse / safeParse / isDecimal", () => {
		const parsed = Decimal.parse("1.23");
		expect(Decimal.isDecimal(parsed)).toBe(true);
		expect(Decimal.tryParse("bad")).toBeNull();
		expect(Decimal.tryParse("1.23")?.toString()).toBe("1.23");

		const ok = Decimal.safeParse("2.50");
		expect(ok.success).toBe(true);
		if (ok.success) expect(ok.value.toString()).toBe("2.5");

		const bad = Decimal.safeParse({});
		expect(bad.success).toBe(false);
		if (!bad.success) expect(bad.error.message).toMatch(/Invalid decimal input/);
	});
});

describe("Atom context", () => {
	it("configures default precision and rounding without changing explicit options", () => {
		resetAtomContext();
		expect(getAtomContext()).toEqual({
			precision: 18,
			roundMode: "trunc",
			quantizeMode: "half-up",
		});

		configureAtomContext({ precision: 4, roundMode: "ceil" });
		expect(new Decimal("1").div("3").toString()).toBe("0.3333");
		expect(new Decimal("2").sqrt({ precision: 0 }).toString()).toBe("2");
		expect(new Decimal("2").sqrt({ precision: 0, mode: "floor" }).toString()).toBe(
			"1",
		);
		resetAtomContext();
	});

	it("scopes context with withAtomContext", () => {
		resetAtomContext();
		const scoped = withAtomContext({ precision: 2 }, () =>
			new Decimal("1").div("8").toString(),
		);
		expect(scoped).toBe("0.12");
		expect(new Decimal("1").div("8").toString()).toBe("0.125");
	});

	it("applies quantizeMode when no per-call mode is passed", () => {
		resetAtomContext();
		configureAtomContext({ quantizeMode: "floor" });
		expect(new Decimal("1.09").quantize("0.1").toString()).toBe("1");
		resetAtomContext();
	});

	it("rejects invalid context precision", () => {
		expect(() => configureAtomContext({ precision: -1 })).toThrow(
			/Invalid Atom context precision/,
		);
		resetAtomContext();
	});
});

describe("Money", () => {
	it("constructs major and minor currency values with ISO scale", () => {
		expect(money("19.99", "eur").toString()).toBe("19.99 EUR");
		expect(Money.fromMinorUnits(1999n, "USD").toString()).toBe("19.99 USD");
		expect(Money.fromMajor("100", "JPY").toString()).toBe("100 JPY");
	});

	it("rejects incompatible currencies and invalid exact scale", () => {
		expect(() => money("1.001", "USD")).toThrow(/without precision loss/);
		expect(() => money("1", "EURO")).toThrow(/Invalid currency/);
		expect(() => money("1", "USD").plus(money("1", "EUR"))).toThrow(
			/Currency mismatch/,
		);
	});

	it("adds, subtracts, multiplies, divides and allocates money safely", () => {
		const a = money("10.00", "USD");
		const b = money("2.50", "USD");
		expect(a.plus(b).toString()).toBe("12.50 USD");
		expect(a.minus(b).toString()).toBe("7.50 USD");
		expect(a.times("1.075").toString()).toBe("10.75 USD");
		expect(a.div("3").toString()).toBe("3.33 USD");
		expect(a.allocate([1, 1, 1]).map((part) => part.toString())).toEqual([
			"3.34 USD",
			"3.33 USD",
			"3.33 USD",
		]);
	});

	it("serializes, formats and exposes minor units", () => {
		const value = money("19.99", "USD");
		expect(value.amount.toString()).toBe("19.99");
		expect(value.currency).toBe("USD");
		expect(value.scale).toBe(2);
		expect(value.toMinorUnits()).toBe(1999n);
		expect(value.toJSON()).toEqual({ amount: "19.99", currency: "USD" });
		expect(value.format({ locale: "en-US" })).toBe("$19.99");
	});

	it("is exposed through the Atom namespace", () => {
		expect(Atom.money("1.00", "USD").toString()).toBe("1.00 USD");
	});
});
