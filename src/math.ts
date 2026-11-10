import { defaultMaxDigits } from "./context.js";

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
	let frac = s.slice(split);
	frac = frac.replace(/0+$/, "");

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

export function divTs(a: string, b: string, precision: number): string {
	const da = parseDecimal(a);
	const db = parseDecimal(b);
	if (db.int === 0n) {
		throw new Error("Division by zero");
	}
	const numerator = da.int * pow10BigInt(precision + db.scale);
	const denominator = db.int * pow10BigInt(da.scale);
	const q = numerator / denominator;
	return formatDecimal(q, precision);
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

/** Exact `10^exp` as a `bigint`. Exported — single definition for the whole TS side. */
export function pow10BigInt(exp: number): bigint {
	let acc = 1n;
	for (let i = 0; i < exp; i++) acc *= 10n;
	return acc;
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
 * Pure-TS integer exponentiation with truncating div for negative exponents.
 * Mirrors the Rust `pow` contract so the two paths produce identical results.
 */
export function powTs(a: string, exp: number, precision: number): string {
	if (!Number.isInteger(exp)) {
		throw new Error(`Invalid exponent: ${exp}`);
	}
	if (exp === 0) return "1";
	assertPowerFits(parseDecimal(a), exp);
	if (exp < 0) {
		return divTs("1", powTs(a, -exp, precision), precision);
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

function bigintSqrt(value: bigint): bigint {
	if (value < 0n) throw new Error("Cannot compute sqrt of negative bigint");
	if (value < 2n) return value;
	let x0 = value;
	let x1 = (x0 + value / x0) / 2n;
	while (x1 < x0) {
		x0 = x1;
		x1 = (x0 + value / x0) / 2n;
	}
	return x0;
}
