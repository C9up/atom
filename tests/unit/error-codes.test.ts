/**
 * Every refusal atom raises carries a `code` a caller can branch on.
 *
 * Each case below triggers the real refusal through the public API (or the
 * TypeScript engine directly, where the native engine answers first and has
 * its own messages).
 */
import { Exception } from "@c9up/flare";
import { describe, expect, it } from "vitest";
import { decimalAtlasAdapter, decimalColumn } from "../../src/atlas.js";
import {
	avg,
	Bulk,
	Decimal,
	errors,
	max,
	median,
	min,
	money,
	stddev,
	withAtomContext,
} from "../../src/index.js";
import { divTs, modTs } from "../../src/math.js";
import {
	__overrideNativeForTesting,
	isNativeAvailable,
} from "../../src/native.js";

const code = (value: string) => expect.objectContaining({ code: value });

describe("atom > error codes", () => {
	it("refuses input that is not a decimal", () => {
		const parsed = Decimal.safeParse(true);
		expect(parsed.success).toBe(false);
		if (!parsed.success) {
			expect(parsed.error).toBeInstanceOf(errors.E_ATOM_INVALID_INPUT);
			expect(parsed.error).toMatchObject({ code: "E_ATOM_INVALID_INPUT" });
		}
		expect(() => Reflect.apply(avg, undefined, ["1", true])).toThrow(
			code("E_ATOM_INVALID_INPUT"),
		);
		expect(() => new Decimal("abc")).toThrow(code("E_ATOM_INVALID_DECIMAL"));
		expect(() => Decimal.parseLocale("abc", "en-US")).toThrow(
			code("E_ATOM_INVALID_DECIMAL"),
		);
	});

	it("refuses integers it cannot take exactly", () => {
		expect(() => new Decimal(2 ** 60)).toThrow(code("E_ATOM_UNSAFE_INTEGER"));
		expect(() => Decimal.fromMinorUnits(2 ** 60, 2)).toThrow(
			code("E_ATOM_UNSAFE_INTEGER"),
		);
		expect(() => Decimal.fromMinorUnits("1.5", 2)).toThrow(
			code("E_ATOM_INVALID_INTEGER"),
		);
	});

	it("refuses a scale, an exponent or a rounding mode out of range", () => {
		expect(() => Decimal.fromMinorUnits(1, -1)).toThrow(
			code("E_ATOM_INVALID_SCALE"),
		);
		expect(() => new Decimal("2").pow(1.5)).toThrow(
			code("E_ATOM_INVALID_EXPONENT"),
		);
		expect(() =>
			Reflect.apply(Decimal.prototype.div, new Decimal("1"), [
				"3",
				{ mode: "sideways" },
			]),
		).toThrow(code("E_ATOM_INVALID_ROUNDING_MODE"));
	});

	it("refuses ranges, steps and ratios that mean nothing", () => {
		const one = new Decimal("1");
		expect(() => one.clamp("2", "1")).toThrow(code("E_ATOM_INVALID_RANGE"));
		expect(() => one.between("2", "1")).toThrow(code("E_ATOM_INVALID_RANGE"));
		expect(() => one.quantize("0")).toThrow(code("E_ATOM_INVALID_STEP"));
		expect(() => one.allocate([])).toThrow(code("E_ATOM_INVALID_RATIOS"));
		expect(() => one.allocate([-1])).toThrow(code("E_ATOM_INVALID_RATIOS"));
		expect(() => one.allocate([0])).toThrow(code("E_ATOM_INVALID_RATIOS"));
		expect(() => Decimal.dot(["1"], ["1", "2"])).toThrow(
			code("E_ATOM_LENGTH_MISMATCH"),
		);
	});

	it("refuses to lose precision converting to minor units", () => {
		expect(() => new Decimal("1.005").toMinorUnits(2)).toThrow(
			code("E_ATOM_PRECISION_LOSS"),
		);
	});

	it("refuses division by zero and the root of a negative", () => {
		expect(() => divTs("1", "0", 4, "trunc")).toThrow(
			code("E_ATOM_DIVISION_BY_ZERO"),
		);
		expect(() => modTs("5", "0")).toThrow(code("E_ATOM_DIVISION_BY_ZERO"));
		// The native engine answers a negative root first, with its own error.
		__overrideNativeForTesting(null);
		try {
			expect(() => new Decimal("-1").sqrt()).toThrow(
				code("E_ATOM_NEGATIVE_SQRT"),
			);
		} finally {
			__overrideNativeForTesting(undefined);
		}
	});

	it("refuses aggregates over too few values", () => {
		expect(() => avg([])).toThrow(code("E_ATOM_EMPTY_INPUT"));
		expect(() => min([])).toThrow(code("E_ATOM_EMPTY_INPUT"));
		expect(() => max([])).toThrow(code("E_ATOM_EMPTY_INPUT"));
		expect(() => median([])).toThrow(code("E_ATOM_EMPTY_INPUT"));
		expect(() => stddev([])).toThrow(code("E_ATOM_EMPTY_INPUT"));
		expect(() => stddev(["1"], { sample: true })).toThrow(
			code("E_ATOM_TOO_FEW_VALUES"),
		);
	});

	it("refuses a context setting that is not one", () => {
		expect(() => withAtomContext({ precision: -1 }, () => 0)).toThrow(
			code("E_ATOM_INVALID_CONTEXT"),
		);
	});

	it("refuses an unknown currency and mixed currencies", () => {
		expect(() => money("1", "EU")).toThrow(code("E_ATOM_INVALID_CURRENCY"));
		expect(() => money("1", "EUR").plus(money("1", "USD"))).toThrow(
			code("E_ATOM_CURRENCY_MISMATCH"),
		);
	});

	it("refuses a run output that is not a planned value", () => {
		const plan = new Bulk();
		expect(() =>
			Reflect.apply(plan.run, plan, [{ total: new Decimal("1") }]),
		).toThrow(code("E_ATOM_BULK_BAD_OUTPUT"));
	});

	it("refuses a column value of the wrong type", () => {
		expect(() => decimalAtlasAdapter.consume(true)).toThrow(
			errors.E_ATOM_INVALID_COLUMN_VALUE,
		);
		expect(() => decimalAtlasAdapter.consume(true)).toThrow(
			code("E_ATOM_INVALID_COLUMN_VALUE"),
		);
		expect(() => decimalAtlasAdapter.prepare("1.1")).toThrow(
			code("E_ATOM_INVALID_COLUMN_VALUE"),
		);
		const required = decimalColumn({ nullable: false });
		expect(() => required.consume(null)).toThrow(
			code("E_ATOM_NULL_COLUMN_VALUE"),
		);
		expect(() => required.prepare(null)).toThrow(
			code("E_ATOM_NULL_COLUMN_VALUE"),
		);
	});

	it("raises the Rust engine's refusals as the TypeScript engine's errors", () => {
		expect(isNativeAvailable()).toBe(true);
		const one = new Decimal("1");
		expect(() => one.div("0")).toThrow(errors.E_ATOM_DIVISION_BY_ZERO);
		expect(() => one.mod("0")).toThrow(code("E_ATOM_DIVISION_BY_ZERO"));
		expect(() => new Decimal("-1").sqrt()).toThrow(errors.E_ATOM_NEGATIVE_SQRT);
		let caught: unknown;
		try {
			one.div("0");
		} catch (error) {
			caught = error;
		}
		expect(caught).toMatchObject({ message: "Division by zero" });
		expect(caught).toHaveProperty("cause.message", "Division by zero");
	});

	it("exports its errors as flare exceptions", () => {
		const error = new errors.E_ATOM_EMPTY_INPUT(["avg"]);
		expect(error).toBeInstanceOf(Exception);
		expect(error).toMatchObject({
			code: "E_ATOM_EMPTY_INPUT",
			status: 500,
			message: "Atom.avg requires at least one value",
		});
	});
});
