/**
 * The Rust engine's refusals, raised as the errors the TypeScript engine
 * raises for the same input.
 *
 * The engine (N-API, WASM or the phone's JSI module) reports a refusal as a
 * plain `Error` whose message is all it says: "Division by zero",
 * "Invalid scale: 3.5", "[ATOM_BULK_PANIC] Internal panic in the bulk
 * engine". Every call into it goes through {@link fromEngine}, which reads
 * that message and throws the matching `errors.E_ATOM_*`, the engine's error
 * as its `cause`. A message no rule knows becomes `E_ATOM_INTERNAL`, so no
 * engine failure leaves atom without a code.
 */

import { Exception } from "@c9up/flare";
import {
	E_ATOM_BULK_BAD_PROGRAM,
	E_ATOM_DECIMAL_TOO_LARGE,
	E_ATOM_DIVISION_BY_ZERO,
	E_ATOM_INTERNAL,
	E_ATOM_INVALID_DECIMAL,
	E_ATOM_INVALID_ROUNDING_MODE,
	E_ATOM_INVALID_SCALE,
	E_ATOM_LENGTH_MISMATCH,
	E_ATOM_NEGATIVE_SQRT,
} from "./errors.js";

type Rule = readonly [
	pattern: RegExp,
	raise: (match: RegExpExecArray, options: ErrorOptions) => Exception,
];

/** The engine's messages, from `crates/atom-engine` and its bindings. */
const RULES: readonly Rule[] = [
	[
		/^(?:bulk: )?division by zero$/i,
		(_match, options) => new E_ATOM_DIVISION_BY_ZERO([], options),
	],
	[
		/^Cannot compute sqrt of a negative decimal$/,
		(_match, options) => new E_ATOM_NEGATIVE_SQRT([], options),
	],
	[
		/^Unknown rounding mode: (.*)$/s,
		(match, options) =>
			new E_ATOM_INVALID_ROUNDING_MODE([match[1] ?? ""], options),
	],
	[
		/^Invalid scale: (.*)$/s,
		(match, options) => new E_ATOM_INVALID_SCALE([match[1] ?? ""], options),
	],
	[
		/^Mismatched batch lengths: (\d+) and (\d+)$/,
		(match, options) =>
			new E_ATOM_LENGTH_MISMATCH([Number(match[1]), Number(match[2])], options),
	],
	[
		/^Invalid decimal: /,
		(match, options) => new E_ATOM_INVALID_DECIMAL([match.input], options),
	],
	[
		/ past the bound of significant digits$/,
		(match, options) => new E_ATOM_DECIMAL_TOO_LARGE([match.input], options),
	],
	[
		/^bulk: (.*)$/s,
		(match, options) => new E_ATOM_BULK_BAD_PROGRAM([match[1] ?? ""], options),
	],
];

/** The `errors.E_ATOM_*` matching what the engine threw. */
export function engineError(error: unknown): Exception {
	// Already one of atom's: thrown on the TypeScript side of the call.
	if (error instanceof Exception && error.code?.startsWith("E_ATOM_")) {
		return error;
	}
	const message = error instanceof Error ? error.message : String(error);
	const options = { cause: error };
	for (const [pattern, raise] of RULES) {
		const match = pattern.exec(message);
		if (match !== null) return raise(match, options);
	}
	// "Internal panic in atom engine", "[ATOM_BULK_PANIC] ...", and anything
	// a binding adds later.
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
