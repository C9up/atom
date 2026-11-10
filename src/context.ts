import type { RoundMode } from "./Decimal.js";

export interface AtomContext {
	precision: number;
	roundMode: RoundMode;
	quantizeMode: RoundMode;
	/**
	 * The most significant digits a value may carry, refused as input rather
	 * than paid for in CPU later: every operation re-parses its operands, so a
	 * megabyte of digits from a request costs seconds of event loop per call.
	 * The default is twice the largest scale — any value a scale allows, with
	 * an integer part as long again.
	 */
	maxDigits: number;
}

export type AtomContextOptions = Partial<AtomContext>;

const DEFAULT_CONTEXT: AtomContext = Object.freeze({
	precision: 18,
	roundMode: "trunc",
	quantizeMode: "half-up",
	maxDigits: 20_000,
});

/** The highest bound an application may configure. */
const MAX_DIGITS_CEILING = 1_000_000;

let currentContext: AtomContext = DEFAULT_CONTEXT;

export function getAtomContext(): AtomContext {
	return { ...currentContext };
}

export function configureAtomContext(options: AtomContextOptions): AtomContext {
	currentContext = normalizeContext({ ...currentContext, ...options });
	return getAtomContext();
}

export function resetAtomContext(): AtomContext {
	currentContext = DEFAULT_CONTEXT;
	return getAtomContext();
}

export function withAtomContext<T>(
	options: AtomContextOptions,
	callback: () => T,
): T {
	const previous = currentContext;
	currentContext = normalizeContext({ ...currentContext, ...options });
	try {
		return callback();
	} finally {
		currentContext = previous;
	}
}

export function defaultPrecision(): number {
	return currentContext.precision;
}

export function defaultRoundMode(): RoundMode {
	return currentContext.roundMode;
}

export function defaultQuantizeMode(): RoundMode {
	return currentContext.quantizeMode;
}

export function defaultMaxDigits(): number {
	return currentContext.maxDigits;
}

function normalizeContext(context: AtomContext): AtomContext {
	assertContextPrecision(context.precision);
	assertContextMaxDigits(context.maxDigits);
	return Object.freeze({ ...context });
}

function assertContextPrecision(precision: number): void {
	if (!Number.isInteger(precision) || precision < 0 || precision > 10_000) {
		throw new Error(`Invalid Atom context precision: ${precision}`);
	}
}

function assertContextMaxDigits(maxDigits: number): void {
	if (
		!Number.isInteger(maxDigits) ||
		maxDigits < 1 ||
		maxDigits > MAX_DIGITS_CEILING
	) {
		throw new Error(`Invalid Atom context maxDigits: ${maxDigits}`);
	}
}
