import {
	defaultPrecision,
	defaultQuantizeMode,
	defaultRoundMode,
} from "./context.js";
import {
	addTs,
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
} from "./math.js";
import { tryNativeAtom } from "./native.js";

export type DecimalInput = string | number | bigint | Decimal;
export type RoundMode = "trunc" | "floor" | "ceil" | "half-up" | "half-even";

export interface DecimalScaled {
	value: bigint;
	scale: number;
}

export interface DivOptions {
	precision?: number;
}

export interface PowOptions {
	precision?: number;
}

export interface SqrtOptions {
	precision?: number;
	mode?: RoundMode;
}

export interface BetweenOptions {
	inclusive?: boolean;
}

export interface QuantizeOptions {
	mode?: RoundMode;
	precision?: number;
}

export interface MedianOptions {
	precision?: number;
}

export interface StddevOptions {
	sample?: boolean;
	precision?: number;
	mode?: RoundMode;
}

export interface ToMinorUnitsOptions {
	exact?: boolean;
	mode?: RoundMode;
}

export type DecimalSafeParseResult =
	| { success: true; value: Decimal }
	| { success: false; error: Error };

const MAX_SCALE = 10_000;
const MAX_EXPONENT_ABS = 100_000;

export class Decimal {
	#value: string;
	#scaleHint: number;

	constructor(value: DecimalInput, scaleHint?: number) {
		if (value instanceof Decimal) {
			this.#value = value.#value;
			this.#scaleHint = scaleHint ?? value.#scaleHint;
			assertScale(this.#scaleHint);
			return;
		}
		this.#value = normalizeInput(value);
		this.#scaleHint = scaleHint ?? inferInputScale(value, this.#value);
		assertScale(this.#scaleHint);
	}

	static from(value: DecimalInput): Decimal {
		return new Decimal(value);
	}

	static parse(value: DecimalInput): Decimal {
		return new Decimal(value);
	}

	static tryParse(value: unknown): Decimal | null {
		const parsed = Decimal.safeParse(value);
		return parsed.success ? parsed.value : null;
	}

	static safeParse(value: unknown): DecimalSafeParseResult {
		try {
			if (!isDecimalInput(value)) {
				throw new Error(`Invalid decimal input type: ${typeof value}`);
			}
			return { success: true, value: new Decimal(value) };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error : new Error(String(error)),
			};
		}
	}

	static isDecimal(value: unknown): value is Decimal {
		return value instanceof Decimal;
	}

	static zero(): Decimal {
		return new Decimal("0");
	}

	static one(): Decimal {
		return new Decimal("1");
	}

	static fromMinorUnits(
		value: string | number | bigint,
		scale: number,
	): Decimal {
		assertScale(scale);
		const minor = parseIntegerInput(value);
		return fromIntScale(minor, scale);
	}

	static parseLocale(
		value: string,
		localesOrRosetta?: Intl.LocalesArgument | RosettaLike,
	): Decimal {
		if (isRosettaLike(localesOrRosetta)) {
			return new Decimal(normalizeViaRosetta(value, localesOrRosetta));
		}
		return new Decimal(normalizeLocaleNumber(value, localesOrRosetta));
	}

	plus(other: DecimalInput): Decimal {
		const b = normalizeInput(other);
		const native = tryNativeAtom();
		const result = native ? native.add(this.#value, b) : addTs(this.#value, b);
		return new Decimal(result);
	}

	minus(other: DecimalInput): Decimal {
		const b = normalizeInput(other);
		const native = tryNativeAtom();
		const result = native ? native.sub(this.#value, b) : subTs(this.#value, b);
		return new Decimal(result);
	}

	times(other: DecimalInput): Decimal {
		const b = normalizeInput(other);
		const native = tryNativeAtom();
		const result = native ? native.mul(this.#value, b) : mulTs(this.#value, b);
		return new Decimal(result);
	}

	div(other: DecimalInput, options: DivOptions = {}): Decimal {
		const b = normalizeInput(other);
		const precision = options.precision ?? defaultPrecision();
		assertScale(precision);
		const native = tryNativeAtom();
		const result = native
			? native.div(this.#value, b, precision)
			: divTs(this.#value, b, precision);
		return new Decimal(result);
	}

	mod(other: DecimalInput): Decimal {
		const b = normalizeInput(other);
		const native = tryNativeAtom();
		const result = native ? native.rem(this.#value, b) : modTs(this.#value, b);
		return new Decimal(result);
	}

	pow(exp: number, options: PowOptions = {}): Decimal {
		assertExponent(exp);
		const precision = options.precision ?? defaultPrecision();
		assertScale(precision);
		const native = tryNativeAtom();
		const result = native
			? native.pow(this.#value, exp, precision)
			: powTs(this.#value, exp, precision);
		return new Decimal(result);
	}

	sqrt(options: SqrtOptions = {}): Decimal {
		const precision = options.precision ?? defaultPrecision();
		const mode = options.mode ?? defaultRoundMode();
		assertScale(precision);
		if (mode === "trunc") {
			return fromIntScale(this.sqrtTruncInt(precision), precision);
		}
		const truncated = this.sqrtTruncInt(precision);
		const rounded = roundSqrtInt(this.#value, truncated, precision, mode);
		return fromIntScale(rounded, precision);
	}

	cmp(other: DecimalInput): -1 | 0 | 1 {
		const b = normalizeInput(other);
		const native = tryNativeAtom();
		const result = native ? native.cmp(this.#value, b) : cmpTs(this.#value, b);
		if (result < 0) return -1;
		if (result > 0) return 1;
		return 0;
	}

	eq(other: DecimalInput): boolean {
		return this.cmp(other) === 0;
	}

	lt(other: DecimalInput): boolean {
		return this.cmp(other) < 0;
	}

	lte(other: DecimalInput): boolean {
		return this.cmp(other) <= 0;
	}

	gt(other: DecimalInput): boolean {
		return this.cmp(other) > 0;
	}

	gte(other: DecimalInput): boolean {
		return this.cmp(other) >= 0;
	}

	min(other: DecimalInput): Decimal {
		return this.lte(other) ? this : new Decimal(other);
	}

	max(other: DecimalInput): Decimal {
		return this.gte(other) ? this : new Decimal(other);
	}

	clamp(min: DecimalInput, max: DecimalInput): Decimal {
		const minValue = new Decimal(min);
		const maxValue = new Decimal(max);
		if (minValue.gt(maxValue)) {
			throw new Error("Invalid clamp range: min is greater than max");
		}
		if (this.lt(minValue)) return minValue;
		if (this.gt(maxValue)) return maxValue;
		return this;
	}

	between(
		min: DecimalInput,
		max: DecimalInput,
		options: BetweenOptions = {},
	): boolean {
		const { inclusive = true } = options;
		const minValue = new Decimal(min);
		const maxValue = new Decimal(max);
		if (minValue.gt(maxValue)) {
			throw new Error("Invalid between range: min is greater than max");
		}
		if (inclusive) {
			return this.gte(minValue) && this.lte(maxValue);
		}
		return this.gt(minValue) && this.lt(maxValue);
	}

	abs(): Decimal {
		return this.isNegative() ? this.neg() : this;
	}

	neg(): Decimal {
		return this.isZero()
			? this
			: new Decimal(
					this.#value.startsWith("-")
						? this.#value.slice(1)
						: `-${this.#value}`,
				);
	}

	isZero(): boolean {
		return this.#value === "0";
	}

	isPositive(): boolean {
		return this.#value !== "0" && !this.#value.startsWith("-");
	}

	isNegative(): boolean {
		return this.#value.startsWith("-");
	}

	isInteger(): boolean {
		return parseDecimal(this.#value).scale === 0;
	}

	trunc(scale = 0): Decimal {
		return this.toScale(scale, "trunc");
	}

	floor(scale = 0): Decimal {
		return this.toScale(scale, "floor");
	}

	ceil(scale = 0): Decimal {
		return this.toScale(scale, "ceil");
	}

	round(scale = 0, mode: RoundMode = "half-up"): Decimal {
		return this.toScale(scale, mode);
	}

	/**
	 * Snap the value to the nearest multiple of `step`. Useful for rounding
	 * prices to the nearest cent (`.quantize('0.01')`), the nearest 5-cent
	 * increment, or any custom unit. The default rounding mode is `'half-up'`;
	 * pass `{ mode: 'half-even' }` for banker's rounding.
	 *
	 *     new Decimal('1.234').quantize('0.01')  // → Decimal('1.23')
	 *     new Decimal('1.025').quantize('0.05')  // → Decimal('1.05')
	 */
	quantize(step: DecimalInput, options: QuantizeOptions = {}): Decimal {
		const { mode = defaultQuantizeMode() } = options;
		const stepValue = new Decimal(step);
		if (!stepValue.gt(0)) {
			throw new Error("Quantize step must be greater than zero");
		}
		if (options.precision !== undefined) {
			assertScale(options.precision);
		}
		const thisParts = parseDecimal(this.#value);
		const stepParts = parseDecimal(stepValue.#value);
		const numerator = thisParts.int * pow10BigInt(stepParts.scale);
		const denominator = stepParts.int * pow10BigInt(thisParts.scale);
		const units = fromIntScale(
			roundRationalToInt(numerator, denominator, mode),
			0,
		);
		return units.times(stepValue);
	}

	toScale(scale = 0, mode: RoundMode = "trunc"): Decimal {
		assertScale(scale);
		const parsed = parseDecimal(this.#value);
		return fromIntScale(
			roundIntScale(parsed.int, parsed.scale, scale, mode),
			scale,
		);
	}

	toFixed(scale: number, mode: RoundMode = "trunc"): string {
		assertScale(scale);
		const parsed = parseDecimal(this.#value);
		const roundedInt = roundIntScale(parsed.int, parsed.scale, scale, mode);
		const negative = roundedInt < 0n;
		const raw = (negative ? -roundedInt : roundedInt)
			.toString()
			.padStart(scale + 1, "0");
		if (scale === 0) return negative ? `-${raw}` : raw;
		const whole = raw.slice(0, raw.length - scale);
		const frac = raw.slice(raw.length - scale);
		const out = `${whole}.${frac}`;
		return negative ? `-${out}` : out;
	}

	/**
	 * Convert to a minor-unit `bigint` representation — typically used for
	 * persisting prices to a database as integer cents (`scale: 2`).
	 *
	 * - `exact: true` (default) throws if the conversion would lose precision
	 *   (e.g. `'1.234'.toMinorUnits(2)` errors because `0.004` can't be
	 *   represented at scale 2 without rounding).
	 * - `exact: false` rounds using the requested `mode` (default `'trunc'`).
	 *
	 *     new Decimal('19.99').toMinorUnits(2)  // → 1999n
	 *     new Decimal('1.234').toMinorUnits(2, { exact: false })  // → 123n (truncated)
	 */
	toMinorUnits(scale: number, options: ToMinorUnitsOptions = {}): bigint {
		assertScale(scale);
		const { exact = true, mode = "trunc" } = options;
		const parsed = parseDecimal(this.#value);
		if (parsed.scale === scale) return parsed.int;
		if (parsed.scale < scale) {
			return parsed.int * pow10BigInt(scale - parsed.scale);
		}

		const drop = parsed.scale - scale;
		const factor = pow10BigInt(drop);
		const remainder = parsed.int % factor;
		if (exact && remainder !== 0n) {
			throw new Error(
				`Cannot convert ${this.#value} to minor units at scale ${scale} without precision loss`,
			);
		}
		return roundIntScale(parsed.int, parsed.scale, scale, mode);
	}

	/**
	 * Compute `this * rate / 100` — the percentage portion of the value.
	 *
	 *     new Decimal('200').percent('15')  // → Decimal('30')
	 */
	percent(rate: DecimalInput, options: DivOptions = {}): Decimal {
		return this.times(rate).div("100", options);
	}

	/**
	 * Add a percentage to the value: `this + (this * rate / 100)`. Handy for
	 * tax/markup calculations.
	 *
	 *     new Decimal('100').applyPercent('20')  // → Decimal('120')
	 */
	applyPercent(rate: DecimalInput, options: DivOptions = {}): Decimal {
		return this.plus(this.percent(rate, options));
	}

	/**
	 * Express this value as a percentage of `total`: `this / total * 100`.
	 *
	 *     new Decimal('30').percentageOf('200')  // → Decimal('15')
	 */
	percentageOf(total: DecimalInput, options: DivOptions = {}): Decimal {
		return this.div(total, options).times("100");
	}

	/**
	 * Distribute the value across N buckets according to integer ratios with
	 * **zero rounding loss**: the sum of the returned shares equals the
	 * original value exactly. Used for splitting money: `'10.00'.allocate([1, 1, 1])`
	 * returns `['3.34', '3.33', '3.33']`, not three `'3.33'` (which would
	 * lose a cent).
	 *
	 * The remainder pennies are distributed largest-remainder-first, with
	 * stable input order as the tiebreaker.
	 */
	allocate(ratios: Array<string | number | bigint>): Decimal[] {
		if (ratios.length === 0) {
			throw new Error("Allocate requires at least one ratio");
		}

		const normalized = ratios.map((ratio) => {
			const value = parseIntegerInput(ratio);
			if (value < 0n) {
				throw new Error(`Allocate ratios must be >= 0, got ${ratio}`);
			}
			return value;
		});

		const ratioTotal = normalized.reduce((acc, value) => acc + value, 0n);
		if (ratioTotal <= 0n) {
			throw new Error("Allocate requires at least one positive ratio");
		}

		const parsed = this.toParts();
		const sign = parsed.value < 0n ? -1n : 1n;
		const total = parsed.value < 0n ? -parsed.value : parsed.value;

		const baseShares: bigint[] = [];
		const remainders: Array<{ index: number; remainder: bigint }> = [];
		let consumed = 0n;

		for (let index = 0; index < normalized.length; index++) {
			const ratio = normalized[index];
			const weighted = total * ratio;
			const share = weighted / ratioTotal;
			const remainder = weighted % ratioTotal;
			baseShares.push(share);
			remainders.push({ index, remainder });
			consumed += share;
		}

		let left = total - consumed;
		remainders.sort((a, b) => {
			if (a.remainder > b.remainder) return -1;
			if (a.remainder < b.remainder) return 1;
			return a.index - b.index;
		});

		let pointer = 0;
		while (left > 0n) {
			baseShares[remainders[pointer].index] += 1n;
			left -= 1n;
			pointer++;
			if (pointer >= remainders.length) pointer = 0;
		}

		return baseShares.map((share) => fromIntScale(share * sign, parsed.scale));
	}

	toParts(): DecimalScaled {
		const parsed = parseDecimal(this.#value);
		if (this.#scaleHint <= parsed.scale) {
			return { value: parsed.int, scale: parsed.scale };
		}
		return {
			value: parsed.int * pow10BigInt(this.#scaleHint - parsed.scale),
			scale: this.#scaleHint,
		};
	}

	toString(): string {
		return this.#value;
	}

	toJSON(): string {
		return this.#value;
	}

	/**
	 * Convert to a JavaScript `number` — **lossy** for values with more than
	 * 15-16 significant digits. Use `toString()` / `toJSON()` for exact output.
	 * Provided for interop with APIs that expect a primitive number.
	 */
	toNumber(): number {
		return Number(this.#value);
	}

	private sqrtTruncInt(precision: number): bigint {
		const native = tryNativeAtom();
		const result = native
			? native.sqrt(this.#value, precision)
			: sqrtTs(this.#value, precision);
		const parsed = parseDecimal(result);
		return roundIntScale(parsed.int, parsed.scale, precision, "trunc");
	}

	/**
	 * Format the value as a localized string via `Intl.NumberFormat`.
	 *
	 * Unlike `toNumber()`, this path is **exact** — we route through the
	 * string-accepting overload of `Intl.NumberFormat.format` (ECMA-402
	 * stage-4, supported by every V8 since Node 20). A `Decimal` of
	 * `'9999999999999999.99'` formats correctly instead of rounding to
	 * `10000000000000000`, which is the whole reason Atom exists.
	 *
	 * For pure integers without a decimal point, we hand the value to
	 * `format` as a BigInt (which has been in the type system since ES2020).
	 * For fractional values, we use the runtime's string support via a
	 * typed extension interface — no `any` escape hatch.
	 */
	toLocale(
		localesOrRosetta?: Intl.LocalesArgument | RosettaLike,
		options?: Intl.NumberFormatOptions,
	): string {
		if (isRosettaLike(localesOrRosetta)) {
			return localesOrRosetta.formatNumberString(this.#value, options);
		}
		const formatter = new Intl.NumberFormat(
			localesOrRosetta,
			options,
		) as StringFormatter;
		if (this.isInteger()) {
			return formatter.format(BigInt(this.#value));
		}
		return formatter.format(this.#value);
	}
}

/**
 * Extension of the standard `Intl.NumberFormat` type to declare the
 * string-accepting overload. ECMA-402 specifies `format` as accepting
 * `number | bigint | string`; TypeScript's built-in lib only has
 * `number | bigint`. Declaring this locally keeps the public API free of
 * casts while remaining 100% runtime-compatible.
 */
interface StringFormatter extends Intl.NumberFormat {
	format(value: number | bigint | string): string;
}

function normalizeInput(value: DecimalInput): string {
	if (value instanceof Decimal) {
		return value.toString();
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error(`Invalid decimal: ${value}`);
		}
		return normalizeDecimalString(decimalStringFromNumber(value));
	}
	return normalizeDecimalString(value);
}

function isDecimalInput(value: unknown): value is DecimalInput {
	return (
		value instanceof Decimal ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "bigint"
	);
}

function inferInputScale(
	value: string | number | bigint,
	normalized: string,
): number {
	if (typeof value === "bigint") return 0;
	if (typeof value === "number") {
		return parseDecimal(decimalStringFromNumber(value)).scale;
	}
	try {
		return parseDecimal(value).scale;
	} catch {
		return parseDecimal(normalized).scale;
	}
}

function decimalStringFromNumber(value: number): string {
	if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
		throw new Error(`Unsafe integer decimal input: ${value}`);
	}
	const raw = String(value);
	if (!/[eE]/.test(raw)) return raw;

	const [coefficient, exponentRaw] = raw.toLowerCase().split("e");
	const exponent = Number(exponentRaw);
	if (!Number.isInteger(exponent)) {
		throw new Error(`Invalid decimal: ${value}`);
	}
	const negative = coefficient.startsWith("-");
	const unsigned =
		negative || coefficient.startsWith("+")
			? coefficient.slice(1)
			: coefficient;
	const [wholeRaw, fracRaw = ""] = unsigned.split(".");
	const digits = `${wholeRaw}${fracRaw}`;
	const decimalIndex = wholeRaw.length + exponent;

	let expanded: string;
	if (decimalIndex <= 0) {
		expanded = `0.${"0".repeat(-decimalIndex)}${digits}`;
	} else if (decimalIndex >= digits.length) {
		expanded = `${digits}${"0".repeat(decimalIndex - digits.length)}`;
	} else {
		expanded = `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
	}
	return negative ? `-${expanded}` : expanded;
}

function normalizeDecimalString(input: string): string {
	const parsed = parseDecimal(input);
	return formatDecimal(parsed.int, parsed.scale);
}

function parseIntegerInput(value: string | number | bigint): bigint {
	if (typeof value === "bigint") return value;
	if (typeof value === "number") {
		if (!Number.isInteger(value)) {
			throw new Error(`Invalid integer: ${value}`);
		}
		if (!Number.isSafeInteger(value)) {
			throw new Error(`Unsafe integer input: ${value}`);
		}
		return BigInt(value);
	}
	const s = value.trim();
	if (!/^[+-]?\d+$/.test(s)) {
		throw new Error(`Invalid integer: ${value}`);
	}
	return BigInt(s);
}

function fromIntScale(int: bigint, scale: number): Decimal {
	return new Decimal(formatDecimal(int, scale), scale);
}

function assertScale(scale: number): void {
	if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
		throw new Error(`Invalid scale: ${scale}`);
	}
}

function assertExponent(exp: number): void {
	if (
		!Number.isInteger(exp) ||
		exp < -MAX_EXPONENT_ABS ||
		exp > MAX_EXPONENT_ABS
	) {
		throw new Error(`Invalid exponent: ${exp}`);
	}
}

function roundIntScale(
	int: bigint,
	sourceScale: number,
	targetScale: number,
	mode: RoundMode,
): bigint {
	if (targetScale >= sourceScale) {
		return int * pow10BigInt(targetScale - sourceScale);
	}

	const drop = sourceScale - targetScale;
	const factor = pow10BigInt(drop);
	const q = int / factor;
	const r = int % factor;
	if (r === 0n) return q;

	const absR = r < 0n ? -r : r;
	const sign = int < 0n ? -1n : 1n;

	switch (mode) {
		case "trunc":
			return q;
		case "floor":
			return int < 0n ? q - 1n : q;
		case "ceil":
			return int > 0n ? q + 1n : q;
		case "half-up":
			return absR * 2n >= factor ? q + sign : q;
		case "half-even": {
			const twice = absR * 2n;
			if (twice < factor) return q;
			if (twice > factor) return q + sign;
			const isEven = (q < 0n ? -q : q) % 2n === 0n;
			return isEven ? q : q + sign;
		}
		default:
			// Defensive guard — the TypeScript type system already restricts `mode`
			// to the `RoundMode` union, so this branch is unreachable under normal
			// usage. We throw instead of silently returning the truncated result
			// because a silent fallback would hide a bug: an upstream cast past the
			// type system (`as RoundMode`) would lose precision without any signal.
			throw new Error(`Unknown rounding mode: ${String(mode)}`);
	}
}

function roundRationalToInt(
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

function roundSqrtInt(
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

/**
 * Structural type matching `@c9up/rosetta`'s `Rosetta` and
 * `RosettaLocale` surfaces. Atom never imports the Rosetta
 * package directly — duck-typing keeps the integration optional
 * and avoids a hard cross-package dependency.
 */
export interface RosettaNumberFormatData {
	decimal: string;
	group: string;
	minus: string;
	plusSign: string;
}

export interface RosettaLike {
	getNumberFormatData(): RosettaNumberFormatData;
	formatNumberString(value: string, options?: Intl.NumberFormatOptions): string;
}

function isRosettaLike(arg: unknown): arg is RosettaLike {
	return (
		typeof arg === "object" &&
		arg !== null &&
		"getNumberFormatData" in arg &&
		typeof (arg as RosettaLike).getNumberFormatData === "function" &&
		"formatNumberString" in arg &&
		typeof (arg as RosettaLike).formatNumberString === "function"
	);
}

function normalizeViaRosetta(input: string, rosetta: RosettaLike): string {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error("Invalid localized decimal: empty string");
	}
	const raw = rosetta.getNumberFormatData();
	// Guard: a malformed `RosettaLike` returning empty separators
	// would produce regexes matching every position. Fall back to
	// ASCII defaults rather than corrupting the input.
	const data = {
		decimal: raw.decimal || ".",
		group: raw.group || ",",
		minus: raw.minus || "-",
		plusSign: raw.plusSign || "+",
	};
	let normalized = trimmed.replace(/\s| | /g, "");
	if (data.minus !== "-") {
		normalized = normalized.replace(
			new RegExp(escapeRegExp(data.minus), "g"),
			"-",
		);
	}
	normalized = normalized.replace(/[−﹣－]/g, "-");
	// Substitute the locale's plus sign (e.g., U+FF0B `＋`,
	// U+FB29 `﬩`) to ASCII so the strict validator accepts it.
	if (data.plusSign !== "+") {
		normalized = normalized.replace(
			new RegExp(escapeRegExp(data.plusSign), "g"),
			"+",
		);
	}

	if (/^\(.*\)$/.test(normalized)) {
		normalized = `-${normalized.slice(1, -1)}`;
	}

	validateLocalizedSyntax(normalized, data.group, data.decimal);
	normalized = normalized.replace(
		new RegExp(escapeRegExp(data.group), "g"),
		"",
	);
	normalized = normalized.replace(
		new RegExp(escapeRegExp(data.decimal), "g"),
		".",
	);

	if (!/^[+-]?\d+(\.\d+)?$/.test(normalized)) {
		throw new Error(`Invalid localized decimal: ${input}`);
	}
	return normalized;
}

function normalizeLocaleNumber(
	input: string,
	locales?: Intl.LocalesArgument,
): string {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error("Invalid localized decimal: empty string");
	}

	const formatter = new Intl.NumberFormat(locales);
	const parts = formatter.formatToParts(-12345.6);
	const group = parts.find((part) => part.type === "group")?.value ?? ",";
	const decimal = parts.find((part) => part.type === "decimal")?.value ?? ".";
	const minus = parts.find((part) => part.type === "minusSign")?.value ?? "-";

	let normalized = normalizeLocaleDigits(trimmed, locales);
	normalized = normalized.replace(/\s|\u00A0|\u202F/g, "");
	if (minus !== "-") {
		normalized = normalized.replace(new RegExp(escapeRegExp(minus), "g"), "-");
	}
	normalized = normalized.replace(/[−﹣－]/g, "-");

	if (/^\(.*\)$/.test(normalized)) {
		normalized = `-${normalized.slice(1, -1)}`;
	}

	validateLocalizedSyntax(
		normalized,
		group,
		decimal,
		getLocaleGrouping(locales),
	);
	normalized = normalized.replace(new RegExp(escapeRegExp(group), "g"), "");
	normalized = normalized.replace(new RegExp(escapeRegExp(decimal), "g"), ".");

	if (!/^[+-]?\d+(\.\d+)?$/.test(normalized)) {
		throw new Error(`Invalid localized decimal: ${input}`);
	}
	return normalized;
}

function normalizeLocaleDigits(
	input: string,
	locales?: Intl.LocalesArgument,
): string {
	const digitMap = getLocaleDigitMap(locales);
	let out = "";
	for (const char of input) {
		out += digitMap.get(char) ?? char;
	}
	return out;
}

function getLocaleDigitMap(
	locales?: Intl.LocalesArgument,
): Map<string, string> {
	const formatter = new Intl.NumberFormat(locales, { useGrouping: false });
	const digits = formatter.format(9876543210);
	const map = new Map<string, string>();
	let value = 9;
	for (const char of digits) {
		if (!map.has(char) && value >= 0) {
			map.set(char, String(value));
			value--;
		}
	}
	return map;
}

interface GroupingSpec {
	primary: number;
	secondary: number;
}

function getLocaleGrouping(locales?: Intl.LocalesArgument): GroupingSpec {
	const parts = new Intl.NumberFormat(locales)
		.formatToParts(1234567890123)
		.filter((part) => part.type === "integer" || part.type === "group");
	const lengths: number[] = [];
	let current = 0;
	for (const part of parts) {
		if (part.type === "integer") {
			current += [...part.value].length;
		} else {
			lengths.push(current);
			current = 0;
		}
	}
	lengths.push(current);
	if (lengths.length < 2) {
		return { primary: 3, secondary: 3 };
	}
	const primary = lengths[lengths.length - 1];
	const secondary = lengths[lengths.length - 2] ?? primary;
	return { primary, secondary };
}

function validateLocalizedSyntax(
	value: string,
	group: string,
	decimal: string,
	grouping: GroupingSpec = { primary: 3, secondary: 3 },
): void {
	const decimalParts = value.split(decimal);
	if (decimalParts.length > 2) {
		throw new Error(`Invalid localized decimal: ${value}`);
	}
	let integer = decimalParts[0] ?? "";
	const fraction = decimalParts[1];
	if (integer.startsWith("+") || integer.startsWith("-")) {
		integer = integer.slice(1);
	}
	if (!integer) {
		throw new Error(`Invalid localized decimal: ${value}`);
	}
	if (fraction !== undefined && !/^\d+$/.test(fraction)) {
		throw new Error(`Invalid localized decimal: ${value}`);
	}
	if (!integer.includes(group)) {
		if (!/^\d+$/.test(integer)) {
			throw new Error(`Invalid localized decimal: ${value}`);
		}
		return;
	}
	const groups = integer.split(group);
	if (groups.some((part) => !/^\d+$/.test(part))) {
		throw new Error(`Invalid localized decimal: ${value}`);
	}
	for (let i = groups.length - 1, distance = 0; i >= 0; i--, distance++) {
		const size = distance === 0 ? grouping.primary : grouping.secondary;
		if (i === 0) {
			if (groups[i].length < 1 || groups[i].length > size) {
				throw new Error(`Invalid localized decimal: ${value}`);
			}
		} else if (groups[i].length !== size) {
			throw new Error(`Invalid localized decimal: ${value}`);
		}
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
