import { afterEach, describe, expect, it } from "vitest";
import {
	Bulk,
	configureAtomContext,
	Decimal,
	getAtomContext,
	resetAtomContext,
	withAtomContext,
} from "../../src/index.js";
import { __overrideNativeForTesting } from "../../src/native.js";

const TOO_LARGE = /ATOM_DECIMAL_TOO_LARGE/;

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

/** How long `work` took, in milliseconds. */
function timed(work: () => void): number {
	const started = performance.now();
	work();
	return performance.now() - started;
}

afterEach(() => {
	resetAtomContext();
});

describe("Decimal — the significant-digit bound", () => {
	it("defaults to twice the largest scale", () => {
		expect(getAtomContext().maxDigits).toBe(20_000);
	});

	it("takes a value at the bound and refuses one digit more", () => {
		const bound = getAtomContext().maxDigits;
		expect(new Decimal("7".repeat(bound)).toString()).toHaveLength(bound);
		expect(() => new Decimal("7".repeat(bound + 1))).toThrow(TOO_LARGE);
		const half = bound / 2;
		expect(
			new Decimal(`-${"7".repeat(half)}.${"7".repeat(half)}`).toParts().scale,
		).toBe(half);
		expect(
			() => new Decimal(`-${"7".repeat(half + 1)}.${"7".repeat(half)}`),
		).toThrow(TOO_LARGE);
	});

	it("refuses a megabyte of digits quickly, without echoing it", () => {
		const megabyte = "7".repeat(1_000_000);
		let message = "";
		const elapsed = timed(() => {
			try {
				new Decimal(megabyte);
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
		});
		expect(message).toMatch(TOO_LARGE);
		expect(message.length).toBeLessThan(300);
		expect(elapsed).toBeLessThan(100);
	});

	it("does not count leading zeros or a fraction's trailing zeros", () => {
		const tiny = `0.${"0".repeat(9_000)}1`;
		expect(new Decimal(tiny).toParts()).toEqual({ value: 1n, scale: 9_001 });
		expect(new Decimal(`${"0".repeat(100_000)}5`).toString()).toBe("5");
		expect(new Decimal(`1.${"0".repeat(10_000)}`).toString()).toBe("1");
	});

	it("refuses a fraction longer than the largest scale before aligning it", () => {
		// Aligning 1 to this scale would build a power of ten a million digits
		// long, one multiplication at a time.
		const deep = `0.${"0".repeat(1_000_000)}1`;
		onBothEngines(() => {
			const elapsed = timed(() => {
				expect(() => new Decimal("1").plus(deep)).toThrow(/Invalid scale/);
			});
			expect(elapsed).toBeLessThan(100);
		});
	});

	it("refuses a bigint past the bound wherever one is taken", () => {
		const bound = getAtomContext().maxDigits;
		const limit = 10n ** BigInt(bound);
		expect(new Decimal(limit - 1n).toString()).toHaveLength(bound);
		expect(() => new Decimal(limit)).toThrow(TOO_LARGE);
		expect(() => new Decimal(-limit)).toThrow(TOO_LARGE);
		expect(() => Decimal.fromMinorUnits(limit, 2)).toThrow(TOO_LARGE);
		expect(() => Decimal.fromMinorUnits(`${limit}`, 2)).toThrow(TOO_LARGE);
		expect(() => new Decimal("1").allocate([limit, 1n])).toThrow(TOO_LARGE);
		expect(() => Decimal.sum([1n, limit])).toThrow(TOO_LARGE);
	});

	it("refuses an arithmetic result past the bound", () => {
		const half = "9".repeat(12_000);
		onBothEngines(() => {
			expect(() => new Decimal(half).times(half)).toThrow(TOO_LARGE);
		});
	});

	it("follows the context, so an application can tighten it", () => {
		withAtomContext({ maxDigits: 1_000 }, () => {
			expect(new Decimal("7".repeat(1_000)).toString()).toHaveLength(1_000);
			expect(() => new Decimal("7".repeat(1_001))).toThrow(TOO_LARGE);
			expect(() => new Decimal(10n ** 1_001n)).toThrow(TOO_LARGE);
		});
		configureAtomContext({ maxDigits: 50 });
		expect(() => new Decimal("1".repeat(51))).toThrow(TOO_LARGE);
	});

	it("refuses a bound that is not a positive whole number up to a million", () => {
		for (const maxDigits of [
			0,
			-1,
			1.5,
			1_000_001,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		]) {
			expect(() => configureAtomContext({ maxDigits })).toThrow(
				/Invalid Atom context maxDigits/,
			);
		}
	});
});

describe("Decimal.pow — refused before it is computed", () => {
	it("refuses a power whose digits are predictably past the bound", () => {
		const base = "9".repeat(1_000);
		onBothEngines(() => {
			const elapsed = timed(() => {
				expect(() => new Decimal(base).pow(100_000)).toThrow(TOO_LARGE);
				expect(() => new Decimal(base).pow(-100_000)).toThrow(TOO_LARGE);
			});
			expect(elapsed).toBeLessThan(50);
		});
	});

	it("refuses a negative power whose quotient is predictably past the bound", () => {
		// 1 / (10^-5000)^100000 has five hundred million digits.
		const tiny = `0.${"0".repeat(4_999)}1`;
		onBothEngines(() => {
			const elapsed = timed(() => {
				expect(() => new Decimal(tiny).pow(-100_000)).toThrow(TOO_LARGE);
			});
			expect(elapsed).toBeLessThan(50);
			expect(new Decimal("0.5").pow(-3).toString()).toBe("8");
		});
	});

	it("refuses a power whose scale is predictably past the largest scale", () => {
		onBothEngines(() => {
			const elapsed = timed(() => {
				expect(() => new Decimal("1.1").pow(100_000)).toThrow(/Invalid scale/);
			});
			expect(elapsed).toBeLessThan(50);
		});
	});

	it("still computes the powers that fit", () => {
		onBothEngines(() => {
			expect(new Decimal("1").pow(100_000).toString()).toBe("1");
			expect(new Decimal("-1").pow(99_999).toString()).toBe("-1");
			expect(new Decimal("10").pow(19_999).toString()).toHaveLength(20_000);
			expect(() => new Decimal("10").pow(20_000)).toThrow(TOO_LARGE);
			expect(new Decimal("1.5").pow(10_000).toParts().scale).toBe(10_000);
			// A trailing zero in the base does not multiply the scale.
			expect(new Decimal("1.50").pow(10_000).toParts().scale).toBe(10_000);
		});
	});
});

describe("Atom.bulk — the same bound", () => {
	it("refuses a value past the bound when it is taken into a plan", () => {
		const plan = new Bulk();
		const bound = getAtomContext().maxDigits;
		expect(() => plan.column(["1", "7".repeat(bound + 1)])).toThrow(TOO_LARGE);
		expect(() => plan.of("7".repeat(bound + 1))).toThrow(TOO_LARGE);
		expect(() => plan.column([10n ** BigInt(bound)])).toThrow(TOO_LARGE);
		expect(() => plan.minorUnits([10n ** BigInt(bound)], 2)).toThrow(TOO_LARGE);
	});

	it("refuses a planned power past the bound before computing it", () => {
		onBothEngines(() => {
			const plan = new Bulk();
			const base = plan.of("9".repeat(1_000));
			const elapsed = timed(() => {
				expect(() => plan.run({ power: base.pow(100_000) })).toThrow(TOO_LARGE);
			});
			expect(elapsed).toBeLessThan(50);
		});
	});
});
