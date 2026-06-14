import { describe, expect, it } from "vitest";
import { formatDecimal, parseDecimal, pow10BigInt } from "../../src/math.js";

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

describe("atom > math > pow10BigInt", () => {
	it("pow10BigInt(0) is 1 and pow10BigInt(n) = 10^n", () => {
		expect(pow10BigInt(0)).toBe(1n);
		expect(pow10BigInt(6)).toBe(1_000_000n);
	});
});
