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

/** The fastest of three runs of `work` after a warm-up, in milliseconds. */
function fastest(work: () => void): number {
	work();
	let best = Number.POSITIVE_INFINITY;
	for (let run = 0; run < 3; run++) {
		const started = performance.now();
		work();
		best = Math.min(best, performance.now() - started);
	}
	return best;
}

/**
 * How much slower `work` gets from the `small` input to the `large` one.
 *
 * A wall-clock ceiling measures the runner as much as the code: CI under v8
 * coverage missed a 50 ms bound on a refusal that takes a few here. What a
 * guard has to show is that it refuses without doing the work it stands in
 * front of, and that shows in how the time grows: the refusal stays flat, or
 * linear in the text it reads, while the refused work grows far faster than
 * its input — a thousand times the exponent, or four times the digits to align
 * one at a time, would cost orders of magnitude more.
 */
function growth<T>(work: (input: T) => void, small: T, large: T): number {
	const base = fastest(() => work(small));
	// Below half a millisecond the timer's own noise dominates the ratio.
	return fastest(() => work(large)) / Math.max(base, 0.5);
}

/** Linear work on four times the input stays near 4; anything worse fails. */
const MAX_GROWTH = 10;

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
		try {
			new Decimal(megabyte);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toMatch(TOO_LARGE);
		expect(message.length).toBeLessThan(300);
		const refuse = (digits: string) => {
			expect(() => new Decimal(digits)).toThrow(TOO_LARGE);
		};
		expect(growth(refuse, "7".repeat(250_000), megabyte)).toBeLessThan(
			MAX_GROWTH,
		);
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
		const deep = (zeros: number) => `0.${"0".repeat(zeros)}1`;
		const refuse = (fraction: string) => {
			expect(() => new Decimal("1").plus(fraction)).toThrow(/Invalid scale/);
		};
		onBothEngines(() => {
			expect(growth(refuse, deep(250_000), deep(1_000_000))).toBeLessThan(
				MAX_GROWTH,
			);
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
		const refuse = (exp: number) => {
			expect(() => new Decimal(base).pow(exp)).toThrow(TOO_LARGE);
			expect(() => new Decimal(base).pow(-exp)).toThrow(TOO_LARGE);
		};
		onBothEngines(() => {
			expect(growth(refuse, 100, 100_000)).toBeLessThan(MAX_GROWTH);
		});
	});

	it("refuses a negative power whose quotient is predictably past the bound", () => {
		// 1 / (10^-5000)^100000 has five hundred million digits.
		const tiny = `0.${"0".repeat(4_999)}1`;
		const refuse = (exp: number) => {
			expect(() => new Decimal(tiny).pow(exp)).toThrow(TOO_LARGE);
		};
		onBothEngines(() => {
			expect(growth(refuse, -100, -100_000)).toBeLessThan(MAX_GROWTH);
			expect(new Decimal("0.5").pow(-3).toString()).toBe("8");
		});
	});

	it("refuses a power whose scale is predictably past the largest scale", () => {
		// A hundred fractional digits pass the largest scale from the 101st power.
		const base = `1.${"0".repeat(99)}1`;
		const refuse = (exp: number) => {
			expect(() => new Decimal(base).pow(exp)).toThrow(/Invalid scale/);
		};
		onBothEngines(() => {
			expect(() => new Decimal("1.1").pow(100_000)).toThrow(/Invalid scale/);
			expect(growth(refuse, 200, 100_000)).toBeLessThan(MAX_GROWTH);
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
		const refuse = (exp: number) => {
			const plan = new Bulk();
			const base = plan.of("9".repeat(1_000));
			expect(() => plan.run({ power: base.pow(exp) })).toThrow(TOO_LARGE);
		};
		onBothEngines(() => {
			expect(growth(refuse, 100, 100_000)).toBeLessThan(MAX_GROWTH);
		});
	});
});

describe("Decimal — work that grows with the input, not with its square", () => {
	it("normalises a long run of fractional zeros in time linear in its length", () => {
		// Eight bytes of JSON expand to `0.<9 999 zeros>1`, and every value is
		// normalised on the way in: a trailing-zero strip that retried from
		// each zero of the run cost tens of milliseconds a value.
		const normalise = (zeros: number) => {
			for (let i = 0; i < 20; i++) {
				expect(new Decimal(`1e-${zeros}`).toParts().scale).toBe(zeros);
			}
		};
		onBothEngines(() => {
			expect(growth(normalise, 2_500, 10_000)).toBeLessThan(MAX_GROWTH);
		});
	});
});
