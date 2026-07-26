import { describe, expect, it } from "vitest";
import { Decimal, sum } from "../../src/index.js";
import { __overrideNativeForTesting } from "../../src/native.js";

const VALUES = [
	"-999.99",
	"-12.345",
	"-1",
	"-0.01",
	"0",
	"0.001",
	"0.1",
	"1",
	"2.5",
	"10",
	"12345.6789",
];

function nativeResult(fn: () => string): string {
	__overrideNativeForTesting(undefined);
	return fn();
}

function fallbackResult(fn: () => string): string {
	__overrideNativeForTesting(null);
	try {
		return fn();
	} finally {
		__overrideNativeForTesting(undefined);
	}
}

describe("native/fallback parity", () => {
	it("matches arithmetic operations on representative generated pairs", () => {
		for (const a of VALUES) {
			for (const b of VALUES) {
				expect(fallbackResult(() => new Decimal(a).plus(b).toString())).toBe(
					nativeResult(() => new Decimal(a).plus(b).toString()),
				);
				expect(fallbackResult(() => new Decimal(a).minus(b).toString())).toBe(
					nativeResult(() => new Decimal(a).minus(b).toString()),
				);
				expect(fallbackResult(() => new Decimal(a).times(b).toString())).toBe(
					nativeResult(() => new Decimal(a).times(b).toString()),
				);
				expect(fallbackResult(() => new Decimal(a).cmp(b).toString())).toBe(
					nativeResult(() => new Decimal(a).cmp(b).toString()),
				);
				if (b !== "0") {
					expect(
						fallbackResult(() => new Decimal(a).div(b, { precision: 8 }).toString()),
					).toBe(
						nativeResult(() =>
							new Decimal(a).div(b, { precision: 8 }).toString(),
						),
					);
					expect(fallbackResult(() => new Decimal(a).mod(b).toString())).toBe(
						nativeResult(() => new Decimal(a).mod(b).toString()),
					);
				}
			}
		}
	});

	it("matches pow and sqrt on bounded representative inputs", () => {
		for (const value of ["0", "0.01", "1", "2", "4", "6.25", "10"]) {
			for (const exp of [-3, -1, 0, 1, 2, 5]) {
				if (value === "0" && exp < 0) continue;
				expect(
					fallbackResult(() =>
						new Decimal(value).pow(exp, { precision: 8 }).toString(),
					),
				).toBe(
					nativeResult(() =>
						new Decimal(value).pow(exp, { precision: 8 }).toString(),
					),
				);
			}
			expect(
				fallbackResult(() =>
					new Decimal(value).sqrt({ precision: 6, mode: "trunc" }).toString(),
				),
			).toBe(
				nativeResult(() =>
					new Decimal(value).sqrt({ precision: 6, mode: "trunc" }).toString(),
				),
			);
		}
	});
});

describe("decimal invariants", () => {
	it("round-trips add/subtract and preserves allocate totals", () => {
		for (const value of VALUES) {
			for (const delta of ["0.01", "1", "2.5"]) {
				const original = new Decimal(value);
				expect(original.plus(delta).minus(delta).eq(original)).toBe(true);
			}
		}

		for (const value of ["10.00", "0.05", "-10.00", "123.45"]) {
			const parts = new Decimal(value).allocate([1, 2, 3, 4]);
			expect(sum(parts).eq(new Decimal(value))).toBe(true);
		}
	});

	it("quantize results are multiples of the requested step", () => {
		for (const value of ["1.01", "1.025", "1.06", "-1.06", "10.28"]) {
			for (const step of ["0.01", "0.05", "0.1"]) {
				const quantized = new Decimal(value).quantize(step);
				expect(quantized.mod(step).isZero()).toBe(true);
			}
		}
	});
});
