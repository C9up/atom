/**
 * The Rust engine's refusals, raised as the errors the TypeScript engine
 * raises for the same input.
 *
 * The engine (N-API, WASM or the phone's JSI module) cannot throw a
 * JavaScript class, so it starts its message with the code:
 * `E_ATOM_DIVISION_BY_ZERO: Division by zero`. Every call into it goes through
 * {@link fromEngine}, which reads that code and throws the matching
 * `errors.E_ATOM_*`, the engine's error as its `cause`. A code whose class
 * takes values (a rounding mode, a scale, two lengths) carries those values
 * as its message. A message without a known code becomes `E_ATOM_INTERNAL`,
 * so no engine failure leaves atom without a code.
 */

import { Exception } from "@c9up/flare";
import {
	E_ATOM_BULK_BAD_PROGRAM,
	E_ATOM_DECIMAL_TOO_LARGE,
	E_ATOM_DIVISION_BY_ZERO,
	E_ATOM_INTERNAL,
	E_ATOM_INVALID_DECIMAL,
	E_ATOM_INVALID_EXPONENT,
	E_ATOM_INVALID_ROUNDING_MODE,
	E_ATOM_INVALID_SCALE,
	E_ATOM_LENGTH_MISMATCH,
	E_ATOM_NEGATIVE_SQRT,
} from "./errors.js";

type Raise = (message: string, options: ErrorOptions) => Exception;

/**
 * Every code the engine refuses under, from `crates/atom-engine` and the
 * phone's JSI module (`android/src/main/cpp/NativeAtom.cpp`).
 */
const ENGINE_ERRORS = new Map<string, Raise>([
	["E_ATOM_DIVISION_BY_ZERO", (_m, o) => new E_ATOM_DIVISION_BY_ZERO([], o)],
	["E_ATOM_NEGATIVE_SQRT", (_m, o) => new E_ATOM_NEGATIVE_SQRT([], o)],
	[
		"E_ATOM_INVALID_ROUNDING_MODE",
		(m, o) => new E_ATOM_INVALID_ROUNDING_MODE([m], o),
	],
	["E_ATOM_INVALID_SCALE", (m, o) => new E_ATOM_INVALID_SCALE([m], o)],
	// Sent by the phone's JSI module, which checks the exponent itself.
	["E_ATOM_INVALID_EXPONENT", (m, o) => new E_ATOM_INVALID_EXPONENT([m], o)],
	[
		"E_ATOM_LENGTH_MISMATCH",
		(m, o) => {
			// The two lengths, as `<left> and <right>`.
			const [left = Number.NaN, right = Number.NaN] = m
				.split(" and ")
				.map(Number);
			return new E_ATOM_LENGTH_MISMATCH([left, right], o);
		},
	],
	["E_ATOM_INVALID_DECIMAL", (m, o) => new E_ATOM_INVALID_DECIMAL([m], o)],
	["E_ATOM_DECIMAL_TOO_LARGE", (m, o) => new E_ATOM_DECIMAL_TOO_LARGE([m], o)],
	["E_ATOM_BULK_BAD_PROGRAM", (m, o) => new E_ATOM_BULK_BAD_PROGRAM([m], o)],
	["E_ATOM_INTERNAL", (m, o) => new E_ATOM_INTERNAL([m], o)],
]);

/** The code the engine put at the start of `message`, and the rest. */
export function splitEngineMessage(
	message: string,
): { code: string; message: string } | undefined {
	const separator = message.indexOf(": ");
	if (separator <= 0) return undefined;
	const code = message.slice(0, separator);
	if (!/^E_ATOM_[A-Z0-9_]+$/.test(code)) return undefined;
	return { code, message: message.slice(separator + 2) };
}

/** The `errors.E_ATOM_*` matching what the engine threw. */
export function engineError(error: unknown): Exception {
	// Already one of atom's: thrown on the TypeScript side of the call.
	if (error instanceof Exception && error.code?.startsWith("E_ATOM_")) {
		return error;
	}
	const message = error instanceof Error ? error.message : String(error);
	const options = { cause: error };
	const coded = splitEngineMessage(message);
	const raise = coded === undefined ? undefined : ENGINE_ERRORS.get(coded.code);
	if (coded !== undefined && raise !== undefined) {
		return raise(coded.message, options);
	}
	// A message with no code, or one no binding should send here.
	return new E_ATOM_INTERNAL([message], options);
}

/** `run()`, a call into the engine, with its refusals raised as atom's errors. */
export function fromEngine<T>(run: () => T): T {
	try {
		return run();
	} catch (error) {
		throw engineError(error);
	}
}
