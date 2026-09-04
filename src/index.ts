/**
 * @c9up/atom — exact decimal arithmetic.
 * The Rust engine is preferred (NAPI in Node, WASM in browser), with a
 * pure TypeScript BigInt fallback for unsupported platforms.
 */

export type { AtomContext, AtomContextOptions } from "./context.js";
export {
	configureAtomContext,
	getAtomContext,
	resetAtomContext,
	withAtomContext,
} from "./context.js";
export type {
	BetweenOptions,
	DecimalInput,
	DecimalSafeParseResult,
	DecimalScaled,
	DivOptions,
	MedianOptions,
	PowOptions,
	QuantizeOptions,
	RoundMode,
	SqrtOptions,
	StddevOptions,
	ToMinorUnitsOptions,
} from "./Decimal.js";
export { Decimal } from "./Decimal.js";
export type {
	MoneyFormatOptions,
	MoneyOptions,
	MoneyRoundingOptions,
} from "./Money.js";
export { Money, money } from "./Money.js";
export { isNativeAvailable } from "./native.js";

import { defaultPrecision, defaultRoundMode } from "./context.js";
import type { MedianOptions, StddevOptions } from "./Decimal.js";
import { Decimal, type DecimalInput } from "./Decimal.js";
import { money } from "./Money.js";

export function decimal(value: DecimalInput): Decimal {
	return Decimal.from(value);
}

function isDecimalIterable(value: unknown): value is Iterable<DecimalInput> {
	if (typeof value === "string") return false;
	return (
		typeof value === "object" && value !== null && Symbol.iterator in value
	);
}

/**
 * What every aggregate accepts as one value.
 *
 * The variadic form used to be asserted back into shape — a claim about the
 * caller's arguments made in the one place that can check them. Anything else
 * reached `new Decimal(...)`, where an object failed as
 * `input.trim is not a function`, naming neither the argument nor the call.
 */
function isDecimalValue(value: unknown): value is DecimalInput {
	return (
		Decimal.isDecimal(value) ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "bigint"
	);
}

function toDecimalValue(value: unknown): DecimalInput {
	if (isDecimalValue(value)) return value;
	throw new Error(
		`Atom aggregates take a string, number, bigint or Decimal, got ${
			value === null ? "null" : typeof value
		}`,
	);
}

function resolveValues(args: readonly unknown[]): Iterable<DecimalInput> {
	const head = args[0];
	if (args.length === 1 && isDecimalIterable(head)) return head;
	return args.map(toDecimalValue);
}

function sumImpl(values: Iterable<DecimalInput>): Decimal {
	let total = Decimal.zero();
	for (const value of values) {
		total = total.plus(value);
	}
	return total;
}

function avgImpl(values: Iterable<DecimalInput>): Decimal {
	let total = Decimal.zero();
	let count = 0;
	for (const value of values) {
		total = total.plus(value);
		count++;
	}
	if (count === 0) {
		throw new Error("Atom.avg requires at least one value");
	}
	return total.div(String(count));
}

function minImpl(values: Iterable<DecimalInput>): Decimal {
	const [first, ...rest] = [...values].map((value) => new Decimal(value));
	if (first === undefined) {
		throw new Error("Atom.min requires at least one value");
	}
	let best = first;
	for (const candidate of rest) {
		if (candidate.lt(best)) best = candidate;
	}
	return best;
}

function maxImpl(values: Iterable<DecimalInput>): Decimal {
	const [first, ...rest] = [...values].map((value) => new Decimal(value));
	if (first === undefined) {
		throw new Error("Atom.max requires at least one value");
	}
	let best = first;
	for (const candidate of rest) {
		if (candidate.gt(best)) best = candidate;
	}
	return best;
}

function medianImpl(
	values: Iterable<DecimalInput>,
	options: MedianOptions = {},
): Decimal {
	const list = [...values].map((value) => new Decimal(value));
	if (list.length === 0) {
		throw new Error("Atom.median requires at least one value");
	}
	list.sort((a, b) => a.cmp(b));
	const mid = Math.floor(list.length / 2);
	// The empty case threw above, so both halves of the middle are present.
	const upper = list[mid];
	if (upper === undefined) throw new Error("Atom.median lost its middle value");
	if (list.length % 2 === 1) return upper;
	const lower = list[mid - 1];
	if (lower === undefined) throw new Error("Atom.median lost its middle value");
	const precision = options.precision ?? defaultPrecision();
	return lower.plus(upper).div("2", { precision });
}

function modeImpl(values: Iterable<DecimalInput>): Decimal[] {
	const frequencies = new Map<string, number>();
	for (const value of values) {
		const key = new Decimal(value).toString();
		frequencies.set(key, (frequencies.get(key) ?? 0) + 1);
	}
	if (frequencies.size === 0) {
		return [];
	}
	let maxCount = 0;
	for (const count of frequencies.values()) {
		if (count > maxCount) maxCount = count;
	}
	if (maxCount <= 1) return [];
	return [...frequencies.entries()]
		.filter(([, count]) => count === maxCount)
		.map(([value]) => new Decimal(value))
		.sort((a, b) => a.cmp(b));
}

function stddevImpl(
	values: Iterable<DecimalInput>,
	options: StddevOptions = {},
): Decimal {
	const list = [...values].map((value) => new Decimal(value));
	if (list.length === 0) {
		throw new Error("Atom.stddev requires at least one value");
	}
	const sample = options.sample ?? false;
	const precision = options.precision ?? defaultPrecision();
	const mode = options.mode ?? defaultRoundMode();
	const divisor = sample ? list.length - 1 : list.length;
	if (divisor <= 0) {
		throw new Error("Atom.stddev sample mode requires at least two values");
	}
	const mean = avgImpl(list);
	let sumSquares = Decimal.zero();
	for (const value of list) {
		const diff = value.minus(mean);
		sumSquares = sumSquares.plus(diff.times(diff));
	}
	const variance = sumSquares.div(String(divisor), {
		precision: precision + 8,
	});
	return variance.sqrt({ precision, mode });
}

/**
 * The trailing options object of `median(values, options)` / `stddev(values,
 * options)`, or `{}`.
 *
 * A `Decimal` is an object too, so excluding it is what lets the compiler
 * check the narrowing instead of being told the answer.
 */
function optionsFrom<T extends MedianOptions | StddevOptions>(
	value: DecimalInput | T | undefined,
): T | Record<string, never> {
	if (typeof value !== "object" || value === null) return {};
	if (Decimal.isDecimal(value)) return {};
	return value;
}

function parseMedianArgs(
	args: [Iterable<DecimalInput>, MedianOptions?] | DecimalInput[],
): { values: Iterable<DecimalInput>; options: MedianOptions } {
	const head = args[0];
	if (isDecimalIterable(head)) {
		return { values: head, options: optionsFrom<MedianOptions>(args[1]) };
	}
	return { values: resolveValues(args), options: {} };
}

function parseStddevArgs(
	args: [Iterable<DecimalInput>, StddevOptions?] | DecimalInput[],
): { values: Iterable<DecimalInput>; options: StddevOptions } {
	const head = args[0];
	if (isDecimalIterable(head)) {
		return { values: head, options: optionsFrom<StddevOptions>(args[1]) };
	}
	return { values: resolveValues(args), options: {} };
}

function sumFn(...args: [Iterable<DecimalInput>] | DecimalInput[]): Decimal {
	return sumImpl(resolveValues(args));
}

function avgFn(...args: [Iterable<DecimalInput>] | DecimalInput[]): Decimal {
	return avgImpl(resolveValues(args));
}

function minFn(...args: [Iterable<DecimalInput>] | DecimalInput[]): Decimal {
	return minImpl(resolveValues(args));
}

function maxFn(...args: [Iterable<DecimalInput>] | DecimalInput[]): Decimal {
	return maxImpl(resolveValues(args));
}

function modeFn(...args: [Iterable<DecimalInput>] | DecimalInput[]): Decimal[] {
	return modeImpl(resolveValues(args));
}

function medianFn(
	...args: [Iterable<DecimalInput>, MedianOptions?] | DecimalInput[]
): Decimal {
	const { values, options } = parseMedianArgs(args);
	return medianImpl(values, options);
}

function stddevFn(
	...args: [Iterable<DecimalInput>, StddevOptions?] | DecimalInput[]
): Decimal {
	const { values, options } = parseStddevArgs(args);
	return stddevImpl(values, options);
}

/**
 * Atom — namespace bundling the public functional API.
 *
 * Two equivalent ways to access aggregates: `Atom.sum(...)` for namespaced
 * usage, or named imports (`import { sum } from '@c9up/atom'`).
 *
 * @example
 *   import { Atom, decimal } from '@c9up/atom'
 *   const total = Atom.sum('1.10', '2.20', '3.33')   // → Decimal('6.63')
 *   const mean  = Atom.avg(['10', '20', '30'])       // → Decimal('20')
 *   const value = decimal('99.99').times('0.20')     // → Decimal('19.998')
 */
export const Atom = {
	/** Construct a `Decimal` from a string / number / bigint / Decimal. Alias for `Decimal.from`. */
	decimal,
	/** Exact sum of N values. Empty input → `Decimal('0')`. */
	sum: sumFn,
	/** Arithmetic mean of N values. Throws on empty input. */
	avg: avgFn,
	/** Sorted-middle of N values. Even-length lists return the average of the two middle elements at the configured precision (default 18). Throws on empty input. */
	median: medianFn,
	/**
	 * Statistical mode — values appearing the most often. Returns an array
	 * (multi-modal lists possible).
	 *
	 * **Edge case**: returns `[]` when no value repeats (every value has count 1).
	 * This is intentional — there is no "mode" in a strictly unique list. If
	 * your use case requires "first encountered" semantics on unique lists, use
	 * `[...new Set(values)][0]` instead.
	 */
	mode: modeFn,
	/**
	 * Standard deviation. `sample: false` (default) computes the population
	 * stddev (`/ N`); `sample: true` computes the sample stddev (`/ N-1`),
	 * which requires at least two values. Internal precision is bumped by 8
	 * extra digits to mitigate compounding rounding error.
	 */
	stddev: stddevFn,
	/** Smallest of N values. Throws on empty input. */
	min: minFn,
	/** Largest of N values. Throws on empty input. */
	max: maxFn,
	/** Parse a locale-formatted decimal string (e.g. `'1.234,56'` in `fr-FR`). */
	parseLocale: (value: string, locales?: Intl.LocalesArgument) =>
		Decimal.parseLocale(value, locales),
	/** Construct a currency-bound `Money` value. */
	money,
};

export const sum = sumFn;
export const avg = avgFn;
export const median = medianFn;
export const mode = modeFn;
export const stddev = stddevFn;
export const min = minFn;
export const max = maxFn;
