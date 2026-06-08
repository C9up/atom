import { describe, expect, it } from "vitest";
import {
	addTs,
	alignScale,
	cmpTs,
	divTs,
	formatDecimal,
	modTs,
	mulTs,
	parseDecimal,
	pow10BigInt,
	powTs,
	sqrtTs,
	subTs,
} from "../../src/math.js";

describe("atom > math > parseDecimal", () => {
	it("parses unsigned integers and fractions into {int, scale}", () => {
		expect(parseDecimal("123")).toEqual({ int: 123n, scale: 0 });
		expect(parseDecimal("0.5")).toEqual({ int: 5n, scale: 1 });
		expect(parseDecimal("12.345")).toEqual({ int: 12345n, scale: 3 });
	});

	it("strips a leading + and applies a leading -", () => {
		expect(parseDecimal("+42")).toEqual({ int: 42n, scale: 0 });
		expect(parseDecimal("-0.25")).toEqual({ int: -25n, scale: 2 });
	});

	it("trims surrounding whitespace before parsing", () => {
		expect(parseDecimal("  7.5  ")).toEqual({ int: 75n, scale: 1 });
	});

	it("treats '0' / '' / '.5' / '5.' as valid edge inputs", () => {
		expect(parseDecimal("0")).toEqual({ int: 0n, scale: 0 });
		expect(parseDecimal(".5")).toEqual({ int: 5n, scale: 1 });
		expect(parseDecimal("5.")).toEqual({ int: 5n, scale: 0 });
	});

	it("rejects empty / whitespace-only / multi-dot / non-digit inputs", () => {
		expect(() => parseDecimal("")).toThrow(/empty/);
		expect(() => parseDecimal("   ")).toThrow(/empty/);
		expect(() => parseDecimal("1.2.3")).toThrow(/Invalid decimal/);
		expect(() => parseDecimal("12abc")).toThrow(/Invalid decimal/);
		expect(() => parseDecimal("1,5")).toThrow(/Invalid decimal/);
	});
});

describe("atom > math > formatDecimal", () => {
	it("emits an integer when scale is 0", () => {
		expect(formatDecimal(123n, 0)).toBe("123");
		expect(formatDecimal(-7n, 0)).toBe("-7");
	});

	it("strips trailing zeros from the fractional part", () => {
		expect(formatDecimal(1500n, 3)).toBe("1.5"); // 1.500 → 1.5
		expect(formatDecimal(10n, 1)).toBe("1");
	});

	it("left-pads the integer part when |int| < 10^scale", () => {
		expect(formatDecimal(5n, 3)).toBe("0.005");
	});

	it("formats negative fractions with a single leading minus", () => {
		expect(formatDecimal(-25n, 2)).toBe("-0.25");
	});

	it("does not emit '-0' when the value rounds to zero after trimming", () => {
		expect(formatDecimal(0n, 5)).toBe("0");
	});
});

describe("atom > math > arithmetic helpers", () => {
	it("addTs / subTs align scales before operating", () => {
		expect(addTs("1.5", "2.25")).toBe("3.75");
		expect(addTs("1", "0.001")).toBe("1.001");
		expect(subTs("5.5", "0.05")).toBe("5.45");
	});

	it("mulTs accumulates the scale of both operands", () => {
		expect(mulTs("1.5", "2")).toBe("3");
		expect(mulTs("0.1", "0.2")).toBe("0.02"); // 0.02 exact, no float drift
	});

	it("divTs uses the requested precision and truncates toward zero", () => {
		expect(divTs("1", "3", 6)).toBe("0.333333");
		expect(divTs("10", "4", 2)).toBe("2.5");
	});

	it("divTs throws on divide-by-zero", () => {
		expect(() => divTs("1", "0", 4)).toThrow(/Division by zero/);
	});

	it("cmpTs returns -1 / 0 / 1 with scale alignment", () => {
		expect(cmpTs("1.5", "1.50")).toBe(0);
		expect(cmpTs("1.49", "1.50")).toBe(-1);
		expect(cmpTs("1.51", "1.50")).toBe(1);
	});

	it("modTs computes BigInt-style remainder after scale alignment", () => {
		expect(modTs("10", "3")).toBe("1");
		expect(modTs("7.5", "2.5")).toBe("0");
	});

	it("modTs throws on divide-by-zero", () => {
		expect(() => modTs("5", "0")).toThrow(/Division by zero/);
	});
});

describe("atom > math > powTs", () => {
	it("returns '1' for any exponent of 0", () => {
		expect(powTs("17", 0, 4)).toBe("1");
	});

	it("computes positive integer exponents via square-and-multiply", () => {
		expect(powTs("2", 10, 0)).toBe("1024");
		expect(powTs("1.5", 2, 4)).toBe("2.25");
	});

	it("inverts negative exponents through divTs(1, base^|exp|)", () => {
		expect(powTs("2", -3, 4)).toBe("0.125");
	});

	it("throws on a non-integer exponent", () => {
		expect(() => powTs("2", 1.5, 4)).toThrow(/Invalid exponent/);
	});
});

describe("atom > math > sqrtTs", () => {
	it("returns '0' for input '0' as a fast path", () => {
		expect(sqrtTs("0", 6)).toBe("0");
	});

	it("computes a truncated square root at the requested precision", () => {
		expect(sqrtTs("4", 0)).toBe("2");
		expect(sqrtTs("2", 6)).toBe("1.414213"); // √2 ≈ 1.41421356…
	});

	it("rejects negative inputs", () => {
		expect(() => sqrtTs("-1", 4)).toThrow(/negative/);
	});
});

describe("atom > math > primitives (alignScale + pow10BigInt)", () => {
	it("alignScale leaves equally-scaled inputs unchanged", () => {
		const a = parseDecimal("1.5");
		const b = parseDecimal("2.5");
		expect(alignScale(a, b)).toEqual([15n, 25n, 1]);
	});

	it("alignScale promotes the lower-scale side both directions", () => {
		const a = parseDecimal("1");
		const b = parseDecimal("0.001");
		expect(alignScale(a, b)).toEqual([1000n, 1n, 3]);
		expect(alignScale(b, a)).toEqual([1n, 1000n, 3]);
	});

	it("pow10BigInt(0) is 1 and pow10BigInt(n) = 10^n", () => {
		expect(pow10BigInt(0)).toBe(1n);
		expect(pow10BigInt(6)).toBe(1_000_000n);
	});
});
