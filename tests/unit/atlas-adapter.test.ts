/**
 * Unit tests for `decimalAtlasAdapter` exposed at `@c9up/atom/atlas`.
 *
 * Verifies the adapter's contract in isolation — no atlas dependency.
 * Mirrors Adonis Lucid's `@column.prepare` / `@column.consume` shape.
 *
 * @implements Story 35.10
 */
import { describe, expect, it } from "vitest";
import { decimalAtlasAdapter } from "../../src/atlas.js";
import { Decimal } from "../../src/Decimal.js";

describe("decimalAtlasAdapter", () => {
	describe("consume (DB → model)", () => {
		it("lifts a string into a Decimal instance", () => {
			const d = decimalAtlasAdapter.consume("1234.56");
			expect(d).toBeInstanceOf(Decimal);
			expect(d?.toString()).toBe("1234.56");
		});

		it("returns null for null input", () => {
			expect(decimalAtlasAdapter.consume(null)).toBeNull();
		});

		it("returns null for undefined input", () => {
			expect(decimalAtlasAdapter.consume(undefined)).toBeNull();
		});

		it("preserves an existing Decimal instance verbatim", () => {
			const original = new Decimal("42");
			const out = decimalAtlasAdapter.consume(original);
			expect(out).toBe(original);
		});

		it("accepts numeric inputs (driver returned a JS number)", () => {
			const d = decimalAtlasAdapter.consume(123);
			expect(d).toBeInstanceOf(Decimal);
			expect(d?.toString()).toBe("123");
		});

		it("accepts bigint inputs", () => {
			const d = decimalAtlasAdapter.consume(42n);
			expect(d).toBeInstanceOf(Decimal);
			expect(d?.toString()).toBe("42");
		});

		it("throws TypeError on unsupported inputs (boolean, object, array)", () => {
			expect(() => decimalAtlasAdapter.consume(true)).toThrow(TypeError);
			expect(() => decimalAtlasAdapter.consume({})).toThrow(TypeError);
			expect(() => decimalAtlasAdapter.consume([])).toThrow(TypeError);
		});

		it("preserves an 18-digit value (precision pressure point)", () => {
			const d = decimalAtlasAdapter.consume("1234567890123456.789");
			expect(d?.toString()).toBe("1234567890123456.789");
		});
	});

	describe("prepare (model → DB)", () => {
		it("emits the lossless string form of a Decimal", () => {
			expect(decimalAtlasAdapter.prepare(new Decimal("1.1"))).toBe("1.1");
		});

		it("preserves an 18-digit value through prepare (consume → prepare round-trip)", () => {
			const consumed = decimalAtlasAdapter.consume("1234567890123456.789");
			expect(consumed).not.toBeNull();
			if (!consumed) throw new Error("precondition: consumed must not be null");
			expect(decimalAtlasAdapter.prepare(consumed)).toBe(
				"1234567890123456.789",
			);
		});

		it("returns null for null / undefined input (symmetric with consume)", () => {
			expect(decimalAtlasAdapter.prepare(null)).toBeNull();
			expect(decimalAtlasAdapter.prepare(undefined)).toBeNull();
		});

		it("throws TypeError when called with a JS number", () => {
			expect(() => decimalAtlasAdapter.prepare(1.1)).toThrow(TypeError);
		});

		it("throws TypeError when called with a string", () => {
			expect(() => decimalAtlasAdapter.prepare("1.1")).toThrow(TypeError);
		});
	});

	describe("import surface", () => {
		it("decimalAtlasAdapter is NOT re-exported from the main @c9up/atom index", async () => {
			const main = await import("../../src/index.js");
			expect("decimalAtlasAdapter" in main).toBe(false);
		});

		it("the adapter is shaped { prepare, consume } and spreadable into @Column(...)", () => {
			expect(typeof decimalAtlasAdapter.prepare).toBe("function");
			expect(typeof decimalAtlasAdapter.consume).toBe("function");
			// Two and only two keys — keeps `@Column(decimalAtlasAdapter)` clean
			// against ColumnOptions field-leakage.
			expect(Object.keys(decimalAtlasAdapter).sort()).toEqual([
				"consume",
				"prepare",
			]);
		});
	});
});
