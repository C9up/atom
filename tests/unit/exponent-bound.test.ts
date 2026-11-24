import { afterEach, describe, expect, it } from "vitest";
import {
	Atom,
	Bulk,
	configureAtomContext,
	Decimal,
	getAtomContext,
	resetAtomContext,
	withAtomContext,
} from "../../src/index.js";
import { __overrideNativeForTesting } from "../../src/native.js";

const TOO_LARGE = expect.objectContaining({ code: "E_ATOM_DECIMAL_TOO_LARGE" });
const BAD_SCALE = expect.objectContaining({ code: "E_ATOM_INVALID_SCALE" });

/** Runs `check` on the native engine, then on the TypeScript one. */
function onBothEngines(check: () => void): void {
	for (const engine of [undefined, null] as const) {
		__overrideNativeForTesting(engine);
		try {
			check();
		} finally {
			__overrideNativeForTesting(undefined);
		}
	}
}

afterEach(() => {
	resetAtomContext();
});

describe("Decimal — the exponent bound of a scientific literal", () => {
	it("defaults to an exponent of 100 and the widest scale", () => {
		expect(getAtomContext().maxExponent).toBe(100);
		expect(getAtomContext().maxScale).toBe(10_000);
	});

	it("takes an exponent at the bound and refuses one past it, either way", () => {
		onBothEngines(() => {
			expect(new Decimal("1e100").toString()).toBe(`1${"0".repeat(100)}`);
			expect(new Decimal("1e-100").toParts()).toEqual({
				value: 1n,
				scale: 100,
			});
			expect(new Decimal("-2.5E+99").toString()).toBe(`-25${"0".repeat(98)}`);
			expect(() => new Decimal("1e101")).toThrow(TOO_LARGE);
			expect(() => new Decimal("1e-101")).toThrow(TOO_LARGE);
		});
	});

	it("refuses a six-byte literal wherever a value is read", () => {
		const wide = ["1e9990", "1e-9990"];
		onBothEngines(() => {
			for (const literal of wide) {
				expect(() => new Decimal(literal)).toThrow(TOO_LARGE);
				expect(() => new Decimal("1").plus(literal)).toThrow(TOO_LARGE);
				expect(() => new Decimal("1").cmp(literal)).toThrow(TOO_LARGE);
				expect(() => Decimal.sum(["1", literal])).toThrow(TOO_LARGE);
				expect(() => Atom.median(["1", literal])).toThrow(TOO_LARGE);
				expect(() => Atom.max(["1", literal])).toThrow(TOO_LARGE);
				expect(() => new Bulk().column(["1", literal])).toThrow(TOO_LARGE);
				expect(() => new Bulk().of(literal)).toThrow(TOO_LARGE);
			}
		});
	});

	it("refuses without echoing the literal", () => {
		let caught: unknown;
		try {
			new Decimal(`1e-${"9".repeat(500)}`);
		} catch (error) {
			caught = error;
		}
		expect(caught).toEqual(TOO_LARGE);
		const message = caught instanceof Error ? caught.message : "";
		expect(message).toContain("maxExponent");
		expect(message).not.toContain("999");
	});

	it("holds a number to the same bound as its string form", () => {
		expect(() => new Decimal(1e-150)).toThrow(TOO_LARGE);
		expect(() => new Decimal("1e-150")).toThrow(TOO_LARGE);
		expect(new Decimal(1e-20).toString()).toBe(new Decimal("1e-20").toString());
		withAtomContext({ maxExponent: 324 }, () => {
			expect(new Decimal(Number.MIN_VALUE).toParts().scale).toBe(324);
			expect(new Decimal("5e-324").toParts().scale).toBe(324);
		});
	});

	it("follows the context, so an application can raise or lower it", () => {
		withAtomContext({ maxExponent: 10_000 }, () => {
			expect(new Decimal("1e-9990").toParts().scale).toBe(9_990);
		});
		configureAtomContext({ maxExponent: 2 });
		expect(new Decimal("1.5e2").toString()).toBe("150");
		expect(() => new Decimal("1.5e3")).toThrow(TOO_LARGE);
		configureAtomContext({ maxExponent: 0 });
		expect(new Decimal("7e0").toString()).toBe("7");
		expect(() => new Decimal("7e1")).toThrow(TOO_LARGE);
	});

	it("refuses a bound that is not a whole number from 0 to 10 000", () => {
		for (const maxExponent of [-1, 1.5, 10_001, Number.NaN]) {
			expect(() => configureAtomContext({ maxExponent })).toThrow(
				/Invalid Atom context maxExponent/,
			);
		}
	});
});

describe("Decimal — the configurable scale bound", () => {
	it("refuses a value, a precision or a scale past it, on both engines", () => {
		withAtomContext({ maxScale: 4, precision: 2 }, () => {
			onBothEngines(() => {
				expect(new Decimal("1.1234").toParts().scale).toBe(4);
				expect(() => new Decimal("1.12345")).toThrow(BAD_SCALE);
				// The scale of an expansion is refused before it is written.
				expect(() => new Decimal("1e-5")).toThrow(BAD_SCALE);
				expect(() => new Decimal("1.23e-3")).toThrow(BAD_SCALE);
				expect(new Decimal("1.23e-2").toString()).toBe("0.0123");
				// A result past the bound is refused the same way.
				expect(() => new Decimal("0.01").times("0.001")).toThrow(BAD_SCALE);
				expect(() => new Decimal("1").div("3", { precision: 5 })).toThrow(
					BAD_SCALE,
				);
				expect(new Decimal("1").div("3").toString()).toBe("0.33");
				expect(() => Decimal.fromMinorUnits(1n, 5)).toThrow(BAD_SCALE);
			});
		});
	});

	it("holds a plan to it", () => {
		withAtomContext({ maxScale: 4, precision: 2 }, () => {
			const plan = new Bulk();
			expect(() => plan.minorUnits([1n], 5)).toThrow(
				expect.objectContaining({ code: "E_ATOM_BULK_BAD_SCALE" }),
			);
			const column = plan.column(["1", "2"]);
			expect(() => column.avg({ precision: 5 })).toThrow(
				expect.objectContaining({ code: "E_ATOM_BULK_BAD_PRECISION" }),
			);
		});
	});

	it("refuses a bound out of range, or below the default precision", () => {
		for (const maxScale of [-1, 1.5, 10_001]) {
			expect(() => configureAtomContext({ maxScale })).toThrow(
				/Invalid Atom context maxScale/,
			);
		}
		expect(() => configureAtomContext({ maxScale: 10 })).toThrow(
			/Invalid Atom context precision/,
		);
		expect(configureAtomContext({ maxScale: 10, precision: 10 }).maxScale).toBe(
			10,
		);
	});
});
