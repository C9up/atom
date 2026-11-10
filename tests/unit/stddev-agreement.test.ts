import { afterEach, describe, expect, it } from "vitest";
import {
	Atom,
	Bulk,
	configureAtomContext,
	type RoundMode,
	resetAtomContext,
} from "../../src/index.js";
import { __overrideNativeForTesting } from "../../src/native.js";

const MODES: readonly RoundMode[] = [
	"trunc",
	"floor",
	"ceil",
	"half-up",
	"half-even",
];

afterEach(() => {
	resetAtomContext();
});

/** The bulk deviation on each executor, native first. */
function bulkSpread(
	values: readonly string[],
	options: { precision: number; mode: RoundMode; sample: boolean },
): [string, string] {
	const out: string[] = [];
	for (const engine of [undefined, null] as const) {
		__overrideNativeForTesting(engine);
		try {
			const plan = new Bulk();
			const { spread } = plan.run({
				spread: plan.column(values).stddev(options),
			});
			out.push(spread.toString());
		} finally {
			__overrideNativeForTesting(undefined);
		}
	}
	return [out[0] ?? "missing", out[1] ?? "missing"];
}

describe("stddev — one definition on every path", () => {
	it("agrees with bulk when the mean is not exact", () => {
		// 5/3 has no finite expansion: the mean's own precision shows here.
		for (let precision = 0; precision <= 12; precision++) {
			const options = { precision, mode: "half-up" as const, sample: false };
			const expected = Atom.stddev(["1", "2", "2"], options).toString();
			expect(bulkSpread(["1", "2", "2"], options)).toEqual([
				expected,
				expected,
			]);
		}
	});

	it("does not depend on the context's precision", () => {
		const options = { precision: 6, mode: "half-even" as const };
		const reference = Atom.stddev(["1", "2", "2", "7.125"], options).toString();
		configureAtomContext({ precision: 1 });
		expect(Atom.stddev(["1", "2", "2", "7.125"], options).toString()).toBe(
			reference,
		);
	});

	it("agrees with bulk over random columns, in every mode, on both executors", () => {
		let state = 530;
		const random = (): number => {
			state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
			return state / 2_147_483_648;
		};
		const value = (): string => {
			const units = Math.floor(random() * 2_000_000) - 1_000_000;
			const scale = Math.floor(random() * 5);
			const text = String(Math.abs(units)).padStart(scale + 1, "0");
			const point = text.length - scale;
			const sign = units < 0 ? "-" : "";
			return scale === 0
				? `${sign}${text}`
				: `${sign}${text.slice(0, point)}.${text.slice(point)}`;
		};
		for (let round = 0; round < 150; round++) {
			const values = Array.from(
				{ length: 2 + Math.floor(random() * 9) },
				value,
			);
			const mode = MODES[round % MODES.length] ?? "trunc";
			const precision = Math.floor(random() * 15);
			const sample = random() < 0.5;
			// Half the rounds under a coarse context: the mean must not follow it.
			configureAtomContext({ precision: round % 2 === 0 ? 18 : 2 });
			const options = { precision, mode, sample };
			const expected = Atom.stddev(values, options).toString();
			const label = `${values.join(",")} p${precision} ${mode} ${sample}`;
			const [native, fallback] = bulkSpread(values, options);
			expect(`${label}: ${native}`).toBe(`${label}: ${expected}`);
			expect(`${label}: ${fallback}`).toBe(`${label}: ${expected}`);
		}
	});
});
