/**
 * The examples atom publishes — the README and the JSDoc in `src/` — never
 * teach the non-null assertion on a field (`id!: number`). The house shape
 * for a decorated column is `declare id: number`; an example with `!` is
 * copied into apps whose lint refuses it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

/** A class field declared with a definite assignment assertion: `name!:`. */
const DEFINITE_ASSIGNMENT = /\b[A-Za-z_$][\w$]*!:/g;

function publishedFiles(): string[] {
	const sources = readdirSync(join(ROOT, "src"), { recursive: true })
		.map(String)
		.filter((file) => file.endsWith(".ts"))
		.map((file) => join("src", file));
	return ["README.md", ...sources];
}

describe("published examples", () => {
	it("covers the README and the sources", () => {
		const files = publishedFiles();
		expect(files).toContain("README.md");
		expect(files).toContain(join("src", "atlas.ts"));
	});

	it.each(publishedFiles())("%s declares no field with `!:`", (file) => {
		const text = readFileSync(join(ROOT, file), "utf8");
		expect(text.match(DEFINITE_ASSIGNMENT) ?? []).toEqual([]);
	});

	it("the pattern catches the shape it guards against", () => {
		expect("@PrimaryKey() id!: number".match(DEFINITE_ASSIGNMENT)).toEqual([
			"id!:",
		]);
		expect("@PrimaryKey() declare id: number".match(DEFINITE_ASSIGNMENT)).toBe(
			null,
		);
	});
});
