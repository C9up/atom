/**
 * The Rust engine reports a refusal as a plain `Error` carrying only its
 * message. Each message below is one `crates/atom-engine` emits; atom must
 * raise the same coded error the TypeScript engine raises for that input,
 * with the engine's error kept as the cause.
 */
import { describe, expect, it } from "vitest";
import { engineError, fromEngine } from "../../src/engineErrors.js";
import { errors } from "../../src/index.js";

const cases: readonly (readonly [message: string, code: string])[] = [
	["Division by zero", "E_ATOM_DIVISION_BY_ZERO"],
	["bulk: division by zero", "E_ATOM_DIVISION_BY_ZERO"],
	["Cannot compute sqrt of a negative decimal", "E_ATOM_NEGATIVE_SQRT"],
	["Unknown rounding mode: sideways", "E_ATOM_INVALID_ROUNDING_MODE"],
	["Invalid scale: 3.5", "E_ATOM_INVALID_SCALE"],
	["Mismatched batch lengths: 2 and 3", "E_ATOM_LENGTH_MISMATCH"],
	["Invalid decimal: empty string", "E_ATOM_INVALID_DECIMAL"],
	["A power past the bound of significant digits", "E_ATOM_DECIMAL_TOO_LARGE"],
	["bulk: value overflowed 128 bits in sum", "E_ATOM_BULK_BAD_PROGRAM"],
	["[ATOM_BULK_PANIC] Internal panic in the bulk engine", "E_ATOM_INTERNAL"],
	["Internal panic in atom engine", "E_ATOM_INTERNAL"],
];

describe("atom > engine errors", () => {
	it.each(cases)(
		"raises %j as %s, the engine's error as its cause",
		(message, code) => {
			const engine = new Error(message);
			const raised = engineError(engine);
			expect(raised).toMatchObject({ code });
			expect(raised.cause).toBe(engine);
		},
	);

	it("keeps the values the engine named in the message", () => {
		expect(
			engineError(new Error("Mismatched batch lengths: 2 and 3")).message,
		).toContain("2");
		expect(
			engineError(new Error("Unknown rounding mode: sideways")).message,
		).toContain("sideways");
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
				throw new Error("Division by zero");
			}),
		).toThrow(errors.E_ATOM_DIVISION_BY_ZERO);
		expect(fromEngine(() => 42)).toBe(42);
	});
});
