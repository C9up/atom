import { defaultMaxDigits, isRoundMode } from "./context.js";

export type RoundMode = "trunc" | "floor" | "ceil" | "half-up" | "half-even";

/**
 * Refuse a mode before it is used. Rounding only reads it when a remainder is
 * left over, so an unchecked typo would pass every exact quotient and fail on
 * the first inexact one, far from where it was written.
 */
export function assertRoundMode(value: unknown): RoundMode {
	if (!isRoundMode(value)) {
		throw new Error(`Unknown rounding mode: ${String(value)}`);
	}
	return value;
}

export interface ParsedDecimal {
	int: bigint;
	scale: number;
}

/** The most fractional digits a value, a precision or a scale may ask for. */
export const MAX_SCALE = 10_000;

function tooLarge(what: string): Error {
	return new Error(
		`[ATOM_DECIMAL_TOO_LARGE] ${what} past the bound of ${defaultMaxDigits()} significant digits (configureAtomContext({ maxDigits }) sets it)`,
	);
}

/** Digits that cost something: leading zeros and a fraction's trailing ones do not. */
function significantDigits(whole: string, frac: string): number {
	let fracEnd = frac.length;
	while (fracEnd > 0 && frac.charCodeAt(fracEnd - 1) === 48) fracEnd--;
	let wholeStart = 0;
	while (wholeStart < whole.length && whole.charCodeAt(wholeStart) === 48) {
		wholeStart++;
	}
	if (wholeStart < whole.length) return whole.length - wholeStart + fracEnd;
	let fracStart = 0;
	while (fracStart < fracEnd && frac.charCodeAt(fracStart) === 48) fracStart++;
	return fracEnd - fracStart;
}

let boundDigits = 0;
let boundLimit = 1n;

/**
 * Refuse a whole number of more than the bound's digits.
 *
 * Compared against a cached `10^bound` rather than measured through
 * `toString()`, which is the very cost being refused.
 */
export function assertIntegerDigits(value: bigint): void {
	const bound = defaultMaxDigits();
	if (bound !== boundDigits) {
		boundLimit = 10n ** BigInt(bound);
		boundDigits = bound;
	}
	if (value >= boundLimit || value <= -boundLimit) {
		throw tooLarge("A whole number");
	}
}

/**
 * How far an exponent may move the decimal point.
 *
 * An expression like `1E1000000` is syntactically fine and would expand to a
 * megabyte of zeroes before anything could reject it. The bound is far past any
 * real monetary or measurement scale, and refuses the pathological input as
 * input rather than as an out-of-memory later.
 */
const MAX_EXPONENT = 10_000;

/**
 * Expand scientific notation into plain decimal text.
 *
 * `1E-10` is what `JSON.stringify` emits for a small number and what many APIs
 * return, so a value that survives as a `number` has to survive as the string
 * carrying it too — otherwise the same amount parses or throws depending on
 * which side of a JSON boundary it arrived from.
 */
function expandScientific(input: string): string {
	const matched = /^([+-]?)(\d*)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(input);
	if (!matched) {
		throw new Error(`Invalid decimal: ${input}`);
	}
	const [, sign, wholeRaw = "", fracRaw = "", exponentRaw = "0"] = matched;
	if (wholeRaw.length === 0 && fracRaw.length === 0) {
		throw new Error(`Invalid decimal: ${input}`);
	}

	const exponent = Number(exponentRaw);
	if (!Number.isInteger(exponent) || Math.abs(exponent) > MAX_EXPONENT) {
		throw new Error(`Invalid decimal: ${input}`);
	}

	const digits = `${wholeRaw}${fracRaw}`;
	const pointIndex = wholeRaw.length + exponent;

	let expanded: string;
	if (pointIndex <= 0) {
		expanded = `0.${"0".repeat(-pointIndex)}${digits}`;
	} else if (pointIndex >= digits.length) {
		expanded = `${digits}${"0".repeat(pointIndex - digits.length)}`;
	} else {
		expanded = `${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`;
	}
	return sign === "-" ? `-${expanded}` : expanded;
}

export function parseDecimal(input: string): ParsedDecimal {
	let s = input.trim();
	if (!s) {
		throw new Error("Invalid decimal: empty string");
	}
	if (/[eE]/.test(s)) {
		s = expandScientific(s);
	}

	let sign = 1n;
	let body = s;
	if (body.startsWith("-")) {
		sign = -1n;
		body = body.slice(1);
	} else if (body.startsWith("+")) {
		body = body.slice(1);
	}

	const parts = body.split(".");
	if (parts.length > 2) {
		throw new Error(`Invalid decimal: ${input}`);
	}
	const whole = parts[0] ?? "";
	const frac = parts[1] ?? "";
	if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) {
		throw new Error(`Invalid decimal: ${input}`);
	}
	if (whole.length + frac.length === 0) {
		throw new Error(`Invalid decimal: ${input}`);
	}
	// Both bounds are checked on the text, before any BigInt is built: a scale
	// past MAX_SCALE would otherwise be paid for by aligning the other operand
	// to it, one multiplication by ten per digit.
	if (frac.length > MAX_SCALE) {
		throw new Error(`Invalid scale: ${frac.length}`);
	}
	if (significantDigits(whole, frac) > defaultMaxDigits()) {
		throw tooLarge("A decimal");
	}

	const digits = `${whole}${frac}`;
	let start = 0;
	while (start < digits.length - 1 && digits.charCodeAt(start) === 48) start++;
	const int = BigInt(digits.slice(start)) * sign;
	return { int, scale: frac.length };
}

export function formatDecimal(int: bigint, scale: number): string {
	if (scale === 0) return int.toString();

	const negative = int < 0n;
	let s = (negative ? -int : int).toString();
	if (s.length <= scale) {
		s = `${"0".repeat(scale + 1 - s.length)}${s}`;
	}

	const split = s.length - scale;
	const whole = s.slice(0, split);
	// A backwards scan, not `/0+$/`: the regex retries from every zero of a
	// run that ends in another digit, so `0.<9 999 zeros>1` cost tens of
	// milliseconds a value.
	let end = s.length;
	while (end > split && s.charCodeAt(end - 1) === 48) end--;
	const frac = s.slice(split, end);

	let out = frac ? `${whole}.${frac}` : whole;
	if (negative && out !== "0") out = `-${out}`;
	return out;
}

export function addTs(a: string, b: string): string {
	const da = parseDecimal(a);
	const db = parseDecimal(b);
	const [ai, bi, scale] = alignScale(da, db);
	return formatDecimal(ai + bi, scale);
}

export function subTs(a: string, b: string): string {
	const da = parseDecimal(a);
	const db = parseDecimal(b);
	const [ai, bi, scale] = alignScale(da, db);
	return formatDecimal(ai - bi, scale);
}

export function mulTs(a: string, b: string): string {
	const da = parseDecimal(a);
	const db = parseDecimal(b);
	return formatDecimal(da.int * db.int, da.scale + db.scale);
}

/**
 * `a / b` at `precision` digits, rounded once from the exact quotient — the
 * contract of the Rust `div`.
 */
export function divTs(
	a: string,
	b: string,
	precision: number,
	mode: RoundMode,
): string {
	const da = parseDecimal(a);
	const db = parseDecimal(b);
	if (db.int === 0n) {
		throw new Error("Division by zero");
	}
	let numerator = da.int * pow10BigInt(precision + db.scale);
	let denominator = db.int * pow10BigInt(da.scale);
	if (denominator < 0n) {
		numerator = -numerator;
		denominator = -denominator;
	}
	return formatDecimal(
		roundRationalToInt(numerator, denominator, mode),
		precision,
	);
}

export function cmpTs(a: string, b: string): -1 | 0 | 1 {
	const da = parseDecimal(a);
	const db = parseDecimal(b);
	const [ai, bi] = alignScale(da, db);
	if (ai < bi) return -1;
	if (ai > bi) return 1;
	return 0;
}

/**
 * Align two parsed decimals to the same scale by multiplying the less-precise
 * one by `10^(scaleDelta)`. Used by the TS arithmetic helpers below
 * (add/sub/cmp/mod). NOTE: `Decimal.ts` does NOT import this — it aligns scales
 * inline via `pow10BigInt`, so this is not a shared-dedup point.
 */
export function alignScale(
	a: ParsedDecimal,
	b: ParsedDecimal,
): [bigint, bigint, number] {
	if (a.scale === b.scale) return [a.int, b.int, a.scale];
	if (a.scale > b.scale) {
		const factor = pow10BigInt(a.scale - b.scale);
		return [a.int, b.int * factor, a.scale];
	}
	const factor = pow10BigInt(b.scale - a.scale);
	return [a.int * factor, b.int, b.scale];
}

/** The distance between two rungs of the power-of-ten ladder. */
const LADDER_STEP = 100;

/**
 * Rungs up to twice the largest scale: a product is worked at the sum of two
 * scales, and a square root's radicand at twice its precision.
 */
const LADDER_RUNGS = (2 * MAX_SCALE) / LADDER_STEP;

/**
 * `10^(100·k)`, each built the first time it is asked for. Every rung kept is
 * under a megabyte all together, which is what bounds the cache.
 */
const ladder: Array<bigint | undefined> = [];

/**
 * Exact `10^exp` as a `bigint`. Exported — single definition for the whole TS
 * side.
 *
 * Built from the ladder's rung below `exp` and one small power, so a scale
 * alignment costs one multiplication linear in the digits instead of `exp` of
 * them — rebuilding `10^10000` one factor of ten at a time was what made a
 * single value at scale 10 000 cost seconds across a list.
 */
export function pow10BigInt(exp: number): bigint {
	if (!Number.isSafeInteger(exp) || exp < 0) {
		throw new Error(`Invalid exponent: ${exp}`);
	}
	const rung = Math.floor(exp / LADDER_STEP);
	if (rung > LADDER_RUNGS) return 10n ** BigInt(exp);
	let high = ladder[rung];
	if (high === undefined) {
		high = 10n ** BigInt(rung * LADDER_STEP);
		ladder[rung] = high;
	}
	const rest = exp % LADDER_STEP;
	return rest === 0 ? high : high * 10n ** BigInt(rest);
}

/**
 * Add up integers grouped by scale, then raise each group once to the
 * largest scale — exact, because nothing is rounded to the common scale.
 *
 * Raising every member on its own made one value at scale 10 000 cost a
 * 10 000-digit multiplication for each of the others; grouped, a list costs
 * its length plus one multiplication per distinct scale.
 */
function sumByScale(groups: Map<number, bigint>): string {
	let scale = 0;
	for (const groupScale of groups.keys()) {
		if (groupScale > scale) scale = groupScale;
	}
	let total = 0n;
	for (const [groupScale, int] of groups) {
		total += int * pow10BigInt(scale - groupScale);
	}
	return formatDecimal(total, scale);
}

/** Pure-TS `sum` — the Rust `sum` contract: the exact total, `0` when empty. */
export function sumTs(values: readonly string[]): string {
	const groups = new Map<number, bigint>();
	for (const value of values) {
		const parsed = parseDecimal(value);
		groups.set(parsed.scale, (groups.get(parsed.scale) ?? 0n) + parsed.int);
	}
	return sumByScale(groups);
}

/** Pure-TS `dot` — `Σ aᵢ·bᵢ`, exact, refusing lists of different lengths. */
export function dotTs(a: readonly string[], b: readonly string[]): string {
	if (a.length !== b.length) {
		throw new Error(`Mismatched batch lengths: ${a.length} and ${b.length}`);
	}
	const groups = new Map<number, bigint>();
	for (const [index, left] of a.entries()) {
		const right = b[index];
		if (right === undefined) {
			throw new Error(`Mismatched batch lengths: ${a.length} and ${b.length}`);
		}
		const da = parseDecimal(left);
		const db = parseDecimal(right);
		const scale = da.scale + db.scale;
		groups.set(scale, (groups.get(scale) ?? 0n) + da.int * db.int);
	}
	return sumByScale(groups);
}

/**
 * Pure-TS modulo — fallback for when the native engine is unavailable. The
 * Rust `rem` path should be preferred when `isNativeAvailable()`.
 */
export function modTs(a: string, b: string): string {
	const da = parseDecimal(a);
	const db = parseDecimal(b);
	if (db.int === 0n) {
		throw new Error("Division by zero");
	}
	const [ai, bi, scale] = alignScale(da, db);
	return formatDecimal(ai % bi, scale);
}

/**
 * Refuse a power that would not fit, before computing it.
 *
 * Both sizes are known from the base: a power of a canonical base carries
 * `scale · exp` fractional digits exactly, and about `exp · log10|int|`
 * significant ones. A negative power divides one by that, so its integer part
 * has about `|exp| · (scale − log10|int|)` digits. Computing first and
 * refusing on the way out was how `pow(1.1, 100000)` and a thousand-digit base
 * to the 100 000th ran for minutes before failing.
 */
export function assertPowerFits(base: ParsedDecimal, exp: number): void {
	if (exp === 0 || base.int === 0n) return;
	let int = base.int < 0n ? -base.int : base.int;
	let scale = base.scale;
	// Trailing zeros of a fraction are not digits the power multiplies.
	while (scale > 0 && int % 10n === 0n) {
		int /= 10n;
		scale--;
	}
	const steps = Math.abs(exp);
	if (exp > 0 && scale * steps > MAX_SCALE) {
		throw new Error(`Invalid scale: ${scale * steps}`);
	}
	const text = int.toString();
	const lead = Math.min(text.length, 15);
	const log10 = Math.log10(Number(text.slice(0, lead))) + (text.length - lead);
	// The exact count is checked again when the result is read; this only has
	// to refuse what is certainly past the bound.
	const bound = defaultMaxDigits();
	if (steps * log10 > bound || (exp < 0 && steps * (scale - log10) > bound)) {
		throw tooLarge("A power");
	}
}

/**
 * Pure-TS integer exponentiation; a negative exponent divides, rounded in
 * `mode`. Mirrors the Rust `pow` contract so the two paths produce identical
 * results.
 */
export function powTs(
	a: string,
	exp: number,
	precision: number,
	mode: RoundMode,
): string {
	if (!Number.isInteger(exp)) {
		throw new Error(`Invalid exponent: ${exp}`);
	}
	if (exp === 0) return "1";
	assertPowerFits(parseDecimal(a), exp);
	if (exp < 0) {
		return divTs("1", powTs(a, -exp, precision, mode), precision, mode);
	}

	const base = parseDecimal(a);
	let resultInt = 1n;
	let resultScale = 0;
	let currentInt = base.int;
	let currentScale = base.scale;
	let e = exp;

	while (e > 0) {
		if (e % 2 === 1) {
			resultInt *= currentInt;
			resultScale += currentScale;
		}
		e = Math.floor(e / 2);
		if (e > 0) {
			currentInt *= currentInt;
			currentScale *= 2;
		}
	}
	return formatDecimal(resultInt, resultScale);
}

/**
 * Pure-TS integer square root via Newton's iteration on BigInt, scaled to
 * produce `precision` fractional digits. Truncates toward zero; rounding
 * modes are applied by the caller.
 */
export function sqrtTs(a: string, precision: number): string {
	const parsed = parseDecimal(a);
	if (parsed.int < 0n) {
		throw new Error("Cannot compute sqrt of a negative decimal");
	}
	if (parsed.int === 0n) return "0";

	const factorExp = 2 * precision - parsed.scale;
	let radicand = parsed.int;
	if (factorExp >= 0) {
		radicand *= pow10BigInt(factorExp);
	} else {
		radicand /= pow10BigInt(-factorExp);
	}
	const root = bigintSqrt(radicand);
	return formatDecimal(root, precision);
}

/** `sqrtTs`, rounded in `mode` — what `Decimal.sqrt` answers. */
export function sqrtRoundedTs(
	a: string,
	precision: number,
	mode: RoundMode,
): string {
	const root = parseDecimal(sqrtTs(a, precision));
	if (mode === "trunc") return formatDecimal(root.int, root.scale);
	const truncated = root.int * pow10BigInt(precision - root.scale);
	return formatDecimal(roundSqrtInt(a, truncated, precision, mode), precision);
}

/**
 * Newton's iteration from `2^⌈bits/2⌉`, a power of two at or above the root.
 * Started from `value` itself it first halved its way down for about `bits/2`
 * steps, each a full-width division: seconds on a 20 000-digit value. From an
 * upper bound within a factor of two it converges in `O(log bits)` steps.
 */
function bigintSqrt(value: bigint): bigint {
	if (value < 0n) throw new Error("Cannot compute sqrt of negative bigint");
	if (value < 2n) return value;
	const bits = value.toString(2).length;
	let x0 = 1n << BigInt(Math.ceil(bits / 2));
	let x1 = (x0 + value / x0) >> 1n;
	while (x1 < x0) {
		x0 = x1;
		x1 = (x0 + value / x0) >> 1n;
	}
	return x0;
}

/** `numerator / denominator` rounded once to an integer in `mode`. */
export function roundRationalToInt(
	numerator: bigint,
	denominator: bigint,
	mode: RoundMode,
): bigint {
	if (denominator <= 0n) {
		throw new Error("Invalid rational denominator");
	}
	const q = numerator / denominator;
	const r = numerator % denominator;
	if (r === 0n) return q;

	const absR = r < 0n ? -r : r;
	const sign = numerator < 0n ? -1n : 1n;

	switch (mode) {
		case "trunc":
			return q;
		case "floor":
			return numerator < 0n ? q - 1n : q;
		case "ceil":
			return numerator > 0n ? q + 1n : q;
		case "half-up":
			return absR * 2n >= denominator ? q + sign : q;
		case "half-even": {
			const twice = absR * 2n;
			if (twice < denominator) return q;
			if (twice > denominator) return q + sign;
			const isEven = (q < 0n ? -q : q) % 2n === 0n;
			return isEven ? q : q + sign;
		}
		default:
			throw new Error(`Unknown rounding mode: ${String(mode)}`);
	}
}

/**
 * The root `truncated` (at `precision` digits) of `value`, rounded in `mode`
 * by comparing squares exactly.
 */
export function roundSqrtInt(
	value: string,
	truncated: bigint,
	precision: number,
	mode: Exclude<RoundMode, "trunc">,
): bigint {
	const parsed = parseDecimal(value);
	if (parsed.int < 0n) {
		throw new Error("Cannot compute sqrt of a negative decimal");
	}

	const squareCmp = compareScaled(
		truncated * truncated,
		2 * precision,
		parsed.int,
		parsed.scale,
	);

	if (mode === "floor") return truncated;
	if (mode === "ceil") {
		return squareCmp === 0 ? truncated : truncated + 1n;
	}

	const thresholdCmp = compareScaled(
		(2n * truncated + 1n) * (2n * truncated + 1n),
		2 * precision,
		4n * parsed.int,
		parsed.scale,
	);
	if (thresholdCmp < 0) return truncated + 1n;
	if (thresholdCmp > 0) return truncated;
	if (mode === "half-up") return truncated + 1n;

	return truncated % 2n === 0n ? truncated : truncated + 1n;
}

function compareScaled(
	leftInt: bigint,
	leftScale: number,
	rightInt: bigint,
	rightScale: number,
): -1 | 0 | 1 {
	let left = leftInt;
	let right = rightInt;
	if (leftScale > rightScale) {
		right *= pow10BigInt(leftScale - rightScale);
	} else if (rightScale > leftScale) {
		left *= pow10BigInt(rightScale - leftScale);
	}
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
