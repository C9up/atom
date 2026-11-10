import { afterEach, describe, expect, it } from "vitest";
import {
	Decimal,
	money,
	type RoundMode,
	resetAtomContext,
	withAtomContext,
} from "../../src/index.js";
import { __overrideNativeForTesting } from "../../src/native.js";

afterEach(() => {
	resetAtomContext();
});

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

describe("Money.div — one rounding, from the exact quotient", () => {
	it("gives the same cents whatever the context's precision", () => {
		onBothEngines(() => {
			for (const precision of [0, 2, 18]) {
				for (const roundMode of ["trunc", "floor", "half-even"] as const) {
					withAtomContext({ precision, roundMode }, () => {
						const label = `precision ${precision}, ${roundMode}`;
						expect(`${label}: ${money("2.00", "EUR").div(3)}`).toBe(
							`${label}: 0.67 EUR`,
						);
						expect(`${label}: ${money("10.00", "EUR").div(3)}`).toBe(
							`${label}: 3.33 EUR`,
						);
						expect(
							`${label}: ${money("1.00", "EUR").div("99.99999999999999999", { mode: "ceil" })}`,
						).toBe(`${label}: 0.02 EUR`);
						expect(
							`${label}: ${money("0.05", "EUR").div("1.999999999999999999999", { mode: "half-even" })}`,
						).toBe(`${label}: 0.03 EUR`);
					});
				}
			}
		});
	});

	it("rounds in every mode as the exact rational rounds", () => {
		const modes: readonly RoundMode[] = [
			"trunc",
			"floor",
			"ceil",
			"half-up",
			"half-even",
		];
		let state = 404;
		const random = (): number => {
			state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
			return state / 2_147_483_648;
		};
		const amount = (): string => {
			const cents = Math.floor(random() * 2_000_001) - 1_000_000;
			return Decimal.fromMinorUnits(cents, 2).toFixed(2);
		};
		const divisor = (): string => {
			const units = Math.floor(random() * 200_000) + 1;
			const sign = random() < 0.3 ? "-" : "";
			return `${sign}${Decimal.fromMinorUnits(units, Math.floor(random() * 6))}`;
		};
		onBothEngines(() => {
			withAtomContext({ precision: 1 }, () => {
				for (let i = 0; i < 300; i++) {
					const a = amount();
					const b = divisor();
					const mode = modes[i % modes.length] ?? "trunc";
					// Rounded once at the currency's scale, independently of
					// Money: the quotient's exact digits, then the mode.
					const expected = new Decimal(a)
						.div(b, { precision: 2, mode })
						.toFixed(2);
					expect(`${a}/${b} ${mode}: ${money(a, "EUR").div(b, { mode })}`).toBe(
						`${a}/${b} ${mode}: ${expected} EUR`,
					);
				}
			});
		});
	});

	it("rounds at the currency's own scale", () => {
		expect(money("10", "JPY").div(3).toString()).toBe("3 JPY");
		expect(money("10.000", "KWD").div(3).toString()).toBe("3.333 KWD");
		expect(money("10.000", "KWD").div(6).toString()).toBe("1.667 KWD");
	});
});
