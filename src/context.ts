import type { RoundMode } from "./Decimal.js";

export interface AtomContext {
	precision: number;
	roundMode: RoundMode;
	quantizeMode: RoundMode;
}

export type AtomContextOptions = Partial<AtomContext>;

const DEFAULT_CONTEXT: AtomContext = Object.freeze({
	precision: 18,
	roundMode: "trunc",
	quantizeMode: "half-up",
});

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

function normalizeContext(context: AtomContext): AtomContext {
	assertContextPrecision(context.precision);
	return Object.freeze({ ...context });
}

function assertContextPrecision(precision: number): void {
	if (!Number.isInteger(precision) || precision < 0 || precision > 10_000) {
		throw new Error(`Invalid Atom context precision: ${precision}`);
	}
}
