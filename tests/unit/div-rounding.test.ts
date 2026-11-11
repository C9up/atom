import { afterEach, describe, expect, it } from "vitest";
import {
	Atom,
	Bulk,
	type BulkScalar,
	configureAtomContext,
	Decimal,
	Money,
	type RoundMode,
	resetAtomContext,
	withAtomContext,
} from "../../src/index.js";
import { __overrideNativeForTesting } from "../../src/native.js";

const MODES: readonly RoundMode[] = [
	"trunc",
	"floor",
	"ceil",
	"half-up",
	"half-even",
];

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

/**
 * `a / b` rounded once to `precision` digits — written independently of the
 * package, from floor division, so the two cannot share a mistake.
 */
function reference(
	a: string,
	b: string,
	precision: number,
	mode: RoundMode,
): string {
	const [aInt, aScale] = scaled(a);
	const [bInt, bScale] = scaled(b);
	let numerator = aInt * 10n ** BigInt(precision + bScale);
	let denominator = bInt * 10n ** BigInt(aScale);
	if (denominator < 0n) {
		numerator = -numerator;
		denominator = -denominator;
	}
	const floor =
		numerator >= 0n
			? numerator / denominator
			: -((-numerator + denominator - 1n) / denominator);
	const rest = numerator - floor * denominator; // 0 <= rest < denominator
	let result = floor;
	if (rest !== 0n) {
		const above = rest * 2n > denominator;
		const tie = rest * 2n === denominator;
		const positive = numerator > 0n;
		switch (mode) {
			case "floor":
				break;
			case "ceil":
				result = floor + 1n;
				break;
			case "trunc":
				result = positive ? floor : floor + 1n;
				break;
			case "half-up":
				result = above || (tie && positive) ? floor + 1n : floor;
				break;
			case "half-even":
				result = above || (tie && floor % 2n !== 0n) ? floor + 1n : floor;
				break;
		}
	}
	return Decimal.fromMinorUnits(result, precision).toString();
}

function scaled(value: string): [bigint, number] {
	const parts = new Decimal(value).toParts();
	return [parts.value, parts.scale];
}

/** A small deterministic generator, so a failure names its own inputs. */
function generator(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
		return state / 2_147_483_648;
	};
}

afterEach(() => {
	resetAtomContext();
});

describe("Decimal.div — rounded once, in the mode asked for", () => {
	it("rounds half-up by default, like big.js and decimal.js", () => {
		onBothEngines(() => {
			expect(new Decimal("2").div("3").toString()).toBe("0.666666666666666667");
			expect(new Decimal("-2").div("3").toString()).toBe(
				"-0.666666666666666667",
			);
			expect(new Decimal("1").div("8", { precision: 2 }).toString()).toBe(
				"0.13",
			);
		});
	});

	it("rounds a tie and a non-tie in every mode, on both signs", () => {
		const expected: Record<RoundMode, [string, string, string, string]> = {
			// 1/8, -1/8, 2/3, -2/3 at two digits
			trunc: ["0.12", "-0.12", "0.66", "-0.66"],
			floor: ["0.12", "-0.13", "0.66", "-0.67"],
			ceil: ["0.13", "-0.12", "0.67", "-0.66"],
			"half-up": ["0.13", "-0.13", "0.67", "-0.67"],
			"half-even": ["0.12", "-0.12", "0.67", "-0.67"],
		};
		onBothEngines(() => {
			for (const mode of MODES) {
				const options = { precision: 2, mode };
				const got = [
					new Decimal("1").div("8", options).toString(),
					new Decimal("1").div("-8", options).toString(),
					new Decimal("2").div("3", options).toString(),
					new Decimal("-2").div("3", options).toString(),
				];
				expect(`${mode}: ${got.join(" ")}`).toBe(
					`${mode}: ${expected[mode].join(" ")}`,
				);
			}
		});
	});

	it("follows the context's rounding mode when none is passed", () => {
		configureAtomContext({ roundMode: "trunc" });
		expect(new Decimal("2").div("3").toString()).toBe("0.666666666666666666");
		withAtomContext({ roundMode: "ceil", precision: 1 }, () => {
			expect(new Decimal("-1").div("3").toString()).toBe("-0.3");
			expect(new Decimal("1").div("3").toString()).toBe("0.4");
		});
	});

	it("agrees with an independent rounding of the exact quotient", () => {
		const random = generator(72);
		const operand = (): string => {
			const digits = 1 + Math.floor(random() * 30);
			let text = "";
			for (let i = 0; i < digits; i++) text += Math.floor(random() * 10);
			const scale = Math.floor(random() * Math.min(digits, 12));
			const sign = random() < 0.5 ? "-" : "";
			return `${sign}${text.slice(0, digits - scale) || "0"}.${text.slice(digits - scale) || "0"}`;
		};
		const cases: [string, string, number, RoundMode][] = [];
		while (cases.length < 300) {
			const b = operand();
			if (new Decimal(b).isZero()) continue;
			const mode = MODES[Math.floor(random() * MODES.length)] ?? "trunc";
			cases.push([operand(), b, Math.floor(random() * 25), mode]);
		}
		onBothEngines(() => {
			for (const [a, b, precision, mode] of cases) {
				const got = new Decimal(a).div(b, { precision, mode }).toString();
				expect(`${a}/${b}@${precision}/${mode}=${got}`).toBe(
					`${a}/${b}@${precision}/${mode}=${reference(a, b, precision, mode)}`,
				);
			}
		});
	});

	it("refuses a rounding mode it does not know, even on an exact quotient", () => {
		const exact = new Decimal("1");
		expect(() =>
			Reflect.apply(Decimal.prototype.div, exact, ["1", { mode: "bogus" }]),
		).toThrow(/Unknown rounding mode/);
	});

	it("refuses an unknown mode wherever one is taken, before it is needed", () => {
		// Each of these lands exactly, so the mode is never read: unchecked,
		// the typo passed here and threw on the first value that needed it.
		const bogus = { exact: false, mode: "bogus" };
		expect(() =>
			Reflect.apply(Decimal.prototype.toMinorUnits, new Decimal("1.23"), [
				2,
				bogus,
			]),
		).toThrow(/Unknown rounding mode: bogus/);
		expect(() =>
			Reflect.apply(Decimal.prototype.toMinorUnits, new Decimal("1.23"), [
				2,
				{ mode: "bogus" },
			]),
		).toThrow(/Unknown rounding mode: bogus/);
		expect(() =>
			Reflect.apply(Decimal.prototype.quantize, new Decimal("1.25"), [
				"0.05",
				{ mode: "bogus" },
			]),
		).toThrow(/Unknown rounding mode: bogus/);
		expect(() =>
			Reflect.construct(Money, ["1.00", "EUR", { mode: "bogus" }]),
		).toThrow(/Unknown rounding mode: bogus/);
		expect(
			new Decimal("1.234").toMinorUnits(2, { exact: false, mode: "ceil" }),
		).toBe(124n);
	});

	it("rounds a negative power, percentages and a median the same way", () => {
		onBothEngines(() => {
			expect(new Decimal("1.5").pow(-1, { precision: 2 }).toString()).toBe(
				"0.67",
			);
			expect(
				new Decimal("1.5").pow(-1, { precision: 2, mode: "trunc" }).toString(),
			).toBe("0.66");
			expect(
				new Decimal("1").percent("12.5", { precision: 2 }).toString(),
			).toBe("0.13");
			expect(
				new Decimal("1")
					.percentageOf("3", { precision: 2, mode: "floor" })
					.toString(),
			).toBe("33");
			expect(Atom.median(["1", "2"], { precision: 0 }).toString()).toBe("2");
			expect(
				Atom.median(["1", "2"], { precision: 0, mode: "half-even" }).toString(),
			).toBe("2");
			expect(
				Atom.median(["1", "4"], { precision: 0, mode: "half-even" }).toString(),
			).toBe("2");
		});
	});
});

describe("Atom.bulk — the same rounding on both executors", () => {
	function bothExecutors(
		build: (b: Bulk) => Readonly<Record<string, BulkScalar>>,
	): Record<string, string>[] {
		const out: Record<string, string>[] = [];
		for (const engine of [undefined, null] as const) {
			__overrideNativeForTesting(engine);
			try {
				const plan = new Bulk();
				const results = plan.run(build(plan));
				const flat: Record<string, string> = {};
				for (const [key, value] of Object.entries(results)) {
					flat[key] = value.toString();
				}
				out.push(flat);
			} finally {
				__overrideNativeForTesting(undefined);
			}
		}
		return out;
	}

	it("divides, raises and takes roots in every mode as Decimal does", () => {
		for (const mode of MODES) {
			const [native, fallback] = bothExecutors((b) => ({
				third: b.of("-2").div(b.of("3"), { precision: 4, mode }),
				eighth: b.of("1").div(b.of("8"), { precision: 2, mode }),
				inverse: b.of("1.5").pow(-3, { precision: 3, mode }),
				root: b.of("2").sqrt({ precision: 5, mode }),
				tie: b.of("2.25").sqrt({ precision: 0, mode }),
			}));
			const expected = {
				third: new Decimal("-2").div("3", { precision: 4, mode }).toString(),
				eighth: new Decimal("1").div("8", { precision: 2, mode }).toString(),
				inverse: new Decimal("1.5").pow(-3, { precision: 3, mode }).toString(),
				root: new Decimal("2").sqrt({ precision: 5, mode }).toString(),
				tie: new Decimal("2.25").sqrt({ precision: 0, mode }).toString(),
			};
			expect({ mode, ...native }).toEqual({ mode, ...expected });
			expect({ mode, ...fallback }).toEqual({ mode, ...expected });
		}
	});

	it("averages, takes medians and deviations in every mode as Atom does", () => {
		const values = ["1", "2", "4", "7.25", "-3.5", "8"];
		for (const mode of MODES) {
			for (const precision of [0, 2, 7]) {
				const [native, fallback] = bothExecutors((b) => {
					const column = b.column(values);
					return {
						mean: column.avg({ precision, mode }),
						middle: column.median({ precision, mode }),
						spread: column.stddev({ precision, mode }),
					};
				});
				const expected = {
					mean: Atom.sum(values)
						.div(String(values.length), { precision, mode })
						.toString(),
					middle: Atom.median(values, { precision, mode }).toString(),
					spread: Atom.stddev(values, { precision, mode }).toString(),
				};
				const label = { mode, precision };
				expect({ ...label, ...native }).toEqual({ ...label, ...expected });
				expect({ ...label, ...fallback }).toEqual({ ...label, ...expected });
			}
		}
	});

	it("takes the context's rounding mode when none is passed", () => {
		configureAtomContext({ roundMode: "ceil" });
		const [native, fallback] = bothExecutors((b) => ({
			third: b.of("1").div(b.of("3"), { precision: 2 }),
		}));
		expect(native).toEqual({ third: "0.34" });
		expect(fallback).toEqual({ third: "0.34" });
	});
});
