import { E_ATOM_INVALID_CONTEXT } from "./errors.js";
import type { RoundMode } from "./math.js";

/**
 * The most fractional digits a value, a precision or a scale may ever ask
 * for, and the ceiling of `maxScale` and `maxExponent`. Kept in step with
 * `MAX_SCALE` in the Rust engine.
 */
export const MAX_SCALE = 10_000;

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
	/**
	 * How far the exponent of a scientific literal (`1e-18`, `2.5E+6`) may
	 * move the decimal point, either way. The literal is written out in full
	 * before anything else reads it, so six bytes like `1e-9990` would
	 * otherwise become ten thousand digits that every later operation pays
	 * for. The default covers money and any real measurement; an application
	 * that reads wider literals raises it.
	 */
	maxExponent: number;
	/**
	 * The most fractional digits a value, a precision or a scale may carry.
	 * Aligning two operands costs one digit per unit of scale between them, so
	 * an application that only handles amounts can lower it.
	 */
	maxScale: number;
}

export type AtomContextOptions = Partial<AtomContext>;

const DEFAULT_CONTEXT: AtomContext = Object.freeze({
	precision: 18,
	// Half-up, as big.js (`RM = 1`) and decimal.js (`rounding = 4`) round a
	// quotient and a root by default. Truncating biased every quotient toward
	// zero.
	roundMode: "half-up",
	quantizeMode: "half-up",
	maxDigits: 20_000,
	maxExponent: 100,
	maxScale: MAX_SCALE,
});

/** The highest bound an application may configure. */
const MAX_DIGITS_CEILING = 1_000_000;

const ROUND_MODES: readonly string[] = [
	"trunc",
	"floor",
	"ceil",
	"half-up",
	"half-even",
];

export function isRoundMode(value: unknown): value is RoundMode {
	return typeof value === "string" && ROUND_MODES.includes(value);
}

/**
 * What one `withAtomContext` call opened. A `configureAtomContext` inside the
 * call replaces `context` here, so the change ends with the scope.
 */
interface Scope {
	context: AtomContext;
}

interface ScopeStorage {
	getStore(): Scope | undefined;
	run<R>(store: Scope, callback: () => R): R;
}

/**
 * Where an open scope lives.
 *
 * On Node, an `AsyncLocalStorage`: the scope follows the async call it was
 * opened for, so the lines after an `await` inside `withAtomContext` still run
 * in it and two requests' scopes never see each other — the way ream's
 * `HttpContext` follows a request. Swapping a module global and restoring it in
 * a `finally` restored it when the callback RETURNED its promise, before any
 * of its continuations ran.
 *
 * A browser has no such storage. There the scope is swapped synchronously, so
 * it holds for a synchronous callback only.
 */
function createScopeStorage(): ScopeStorage {
	const hooks =
		typeof globalThis.process !== "undefined" &&
		typeof globalThis.process.getBuiltinModule === "function"
			? globalThis.process.getBuiltinModule("node:async_hooks")
			: undefined;
	if (hooks !== undefined) return new hooks.AsyncLocalStorage<Scope>();
	let open: Scope | undefined;
	return {
		getStore: () => open,
		run(store, callback) {
			const previous = open;
			open = store;
			try {
				return callback();
			} finally {
				open = previous;
			}
		},
	};
}

const scopes = createScopeStorage();

/** The process-wide defaults: what applies outside any scope. */
let globalContext: AtomContext = DEFAULT_CONTEXT;

function currentContext(): AtomContext {
	return scopes.getStore()?.context ?? globalContext;
}

export function getAtomContext(): AtomContext {
	return { ...currentContext() };
}

/**
 * Change the defaults. Outside a scope, the process-wide ones; inside one,
 * that scope's own, which end with it — as they always did.
 */
export function configureAtomContext(options: AtomContextOptions): AtomContext {
	const next = normalizeContext({ ...currentContext(), ...options });
	const scope = scopes.getStore();
	if (scope !== undefined) scope.context = next;
	else globalContext = next;
	return getAtomContext();
}

export function resetAtomContext(): AtomContext {
	const scope = scopes.getStore();
	if (scope !== undefined) scope.context = DEFAULT_CONTEXT;
	else globalContext = DEFAULT_CONTEXT;
	return getAtomContext();
}

/**
 * Run `callback` with these options over the current context. On Node an
 * async callback keeps them across every `await`; see {@link createScopeStorage}.
 */
export function withAtomContext<T>(
	options: AtomContextOptions,
	callback: () => T,
): T {
	const context = normalizeContext({ ...currentContext(), ...options });
	return scopes.run({ context }, callback);
}

export function defaultPrecision(): number {
	return currentContext().precision;
}

export function defaultRoundMode(): RoundMode {
	return currentContext().roundMode;
}

export function defaultQuantizeMode(): RoundMode {
	return currentContext().quantizeMode;
}

export function defaultMaxDigits(): number {
	return currentContext().maxDigits;
}

export function defaultMaxExponent(): number {
	return currentContext().maxExponent;
}

export function defaultMaxScale(): number {
	return currentContext().maxScale;
}

/**
 * Validate the whole context when it is set. A mode was stored unchecked and
 * only failed later, inside an unrelated `sqrt` or `Money` constructor.
 */
function normalizeContext(context: AtomContext): AtomContext {
	assertContextPrecision(context.precision);
	assertContextMaxDigits(context.maxDigits);
	assertContextBound("maxExponent", context.maxExponent, MAX_SCALE);
	assertContextBound("maxScale", context.maxScale, MAX_SCALE);
	// A default precision past the scale bound would make every `div` without
	// an explicit precision fail, far from where the context was set.
	if (context.precision > context.maxScale) {
		throw new E_ATOM_INVALID_CONTEXT(["precision", context.precision]);
	}
	assertContextMode("roundMode", context.roundMode);
	assertContextMode("quantizeMode", context.quantizeMode);
	return Object.freeze({ ...context });
}

function assertContextMode(name: string, mode: unknown): void {
	if (!isRoundMode(mode)) {
		throw new E_ATOM_INVALID_CONTEXT([name, String(mode)]);
	}
}

function assertContextPrecision(precision: number): void {
	if (!Number.isInteger(precision) || precision < 0 || precision > 10_000) {
		throw new E_ATOM_INVALID_CONTEXT(["precision", precision]);
	}
}

function assertContextMaxDigits(maxDigits: number): void {
	if (
		!Number.isInteger(maxDigits) ||
		maxDigits < 1 ||
		maxDigits > MAX_DIGITS_CEILING
	) {
		throw new E_ATOM_INVALID_CONTEXT(["maxDigits", maxDigits]);
	}
}

function assertContextBound(
	name: string,
	value: number,
	ceiling: number,
): void {
	if (!Number.isInteger(value) || value < 0 || value > ceiling) {
		throw new E_ATOM_INVALID_CONTEXT([name, value]);
	}
}
