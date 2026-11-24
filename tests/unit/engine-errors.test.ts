/**
 * The Rust engine starts each refusal with its code (`E_ATOM_X: message`),
 * as `crates/atom-engine` writes it; atom must raise the same coded error the
 * TypeScript engine raises for that input, with the engine's error kept as
 * the cause.
 */
import { describe, expect, it } from "vitest";
import {
	engineError,
	fromEngine,
	splitEngineMessage,
} from "../../src/engineErrors.js";
import { errors } from "../../src/index.js";

const cases: readonly (readonly [
	message: string,
	code: string,
	raised: string,
])[] = [
	[
		"E_ATOM_DIVISION_BY_ZERO: Division by zero",
		"E_ATOM_DIVISION_BY_ZERO",
		"Division by zero",
	],
	[
		"E_ATOM_NEGATIVE_SQRT: Cannot compute sqrt of a negative decimal",
		"E_ATOM_NEGATIVE_SQRT",
		"Cannot compute sqrt of a negative decimal",
	],
	[
		"E_ATOM_INVALID_ROUNDING_MODE: sideways",
		"E_ATOM_INVALID_ROUNDING_MODE",
		"Unknown rounding mode: sideways",
	],
	[
		"E_ATOM_INVALID_SCALE: 10001",
		"E_ATOM_INVALID_SCALE",
		"Invalid scale: 10001",
	],
	[
		"E_ATOM_INVALID_SCALE: precision must be an integer in [0, 4294967295]",
		"E_ATOM_INVALID_SCALE",
		"Invalid scale: precision must be an integer in [0, 4294967295]",
	],
	[
		"E_ATOM_INVALID_EXPONENT: exp must be a 32-bit integer",
		"E_ATOM_INVALID_EXPONENT",
		"Invalid exponent: exp must be a 32-bit integer",
	],
	[
		"E_ATOM_BULK_BAD_PROGRAM: expected a BigInt64Array",
		"E_ATOM_BULK_BAD_PROGRAM",
		"expected a BigInt64Array",
	],
	[
		"E_ATOM_LENGTH_MISMATCH: 2 and 3",
		"E_ATOM_LENGTH_MISMATCH",
		"Mismatched batch lengths: 2 and 3",
	],
	[
		"E_ATOM_INVALID_DECIMAL: Invalid decimal: empty string",
		"E_ATOM_INVALID_DECIMAL",
		"Invalid decimal: empty string",
	],
	[
		"E_ATOM_DECIMAL_TOO_LARGE: A power past the bound of significant digits",
		"E_ATOM_DECIMAL_TOO_LARGE",
		"A power past the bound of significant digits",
	],
	[
		"E_ATOM_BULK_BAD_PROGRAM: unknown opcode 99",
		"E_ATOM_BULK_BAD_PROGRAM",
		"unknown opcode 99",
	],
	[
		"E_ATOM_INTERNAL: Internal panic in the bulk engine",
		"E_ATOM_INTERNAL",
		"Internal panic in the bulk engine",
	],
];

describe("atom > engine errors", () => {
	it.each(cases)(
		"raises %j as %s, the engine's error as its cause",
		(message, code, raised) => {
			const engine = new Error(message);
			const error = engineError(engine);
			expect(error).toMatchObject({ code, message: raised });
			expect(error.cause).toBe(engine);
		},
	);

	it("raises a message without a known code as E_ATOM_INTERNAL", () => {
		for (const message of [
			"Division by zero",
			"E_ATOM_BULK_OVERFLOW: value overflowed 128 bits in sum",
			"E_OTHER_THING: not atom's",
			": no code",
		]) {
			expect(engineError(new Error(message))).toMatchObject({
				code: "E_ATOM_INTERNAL",
				message,
			});
		}
	});

	it("splits a code off the message, and only a code", () => {
		expect(splitEngineMessage("E_ATOM_X: a: b")).toEqual({
			code: "E_ATOM_X",
			message: "a: b",
		});
		expect(splitEngineMessage("Invalid decimal: x")).toBeUndefined();
		expect(splitEngineMessage("no separator")).toBeUndefined();
	});

	it("passes one of atom's own errors through unchanged", () => {
		const own = new errors.E_ATOM_DIVISION_BY_ZERO();
		expect(engineError(own)).toBe(own);
	});

	it("codes a value thrown that is not an Error", () => {
		expect(engineError("boom")).toMatchObject({
			code: "E_ATOM_INTERNAL",
			cause: "boom",
		});
	});

	it("rethrows a refusal from a call into the engine as atom's error", () => {
		expect(() =>
			fromEngine(() => {
				throw new Error("E_ATOM_DIVISION_BY_ZERO: Division by zero");
			}),
		).toThrow(errors.E_ATOM_DIVISION_BY_ZERO);
		expect(fromEngine(() => 42)).toBe(42);
	});
});
