/**
 * Unit tests for `Decimal.parseLocale` / `decimal.toLocale`
 * Rosetta-overload — Story 35.8.
 *
 * Atom must NOT import `@c9up/rosetta`; the integration is
 * duck-typed through the `RosettaLike` structural interface.
 */

import { describe, expect, it } from "vitest";
import type {
	RosettaLike,
	RosettaNumberFormatData,
} from "../../src/Decimal.js";
import { Decimal } from "../../src/Decimal.js";

/** Hand-rolled `RosettaLike` — proves the duck-typing contract. */
function makeStub(
	data: RosettaNumberFormatData,
	formatter: (v: string, o?: Intl.NumberFormatOptions) => string,
): RosettaLike {
	return {
		getNumberFormatData: () => data,
		formatNumberString: formatter,
	};
}

describe("Decimal.parseLocale (Rosetta path)", () => {
	it("honors a hand-rolled RosettaLike with custom separators", () => {
		const stub = makeStub(
			{ decimal: ",", group: " ", minus: "-", plusSign: "+" },
			() => "",
		);
		const d = Decimal.parseLocale("1 234,56", stub);
		expect(d.toString()).toBe("1234.56");
	});

	it("uses the Rosetta data path when separators differ from Intl", () => {
		// A custom locale where the decimal separator is `;` and the group
		// separator is `_` — impossible to express via `Intl.LocalesArgument`.
		const stub = makeStub(
			{ decimal: ";", group: "_", minus: "-", plusSign: "+" },
			() => "",
		);
		const d = Decimal.parseLocale("1_234;56", stub);
		expect(d.toString()).toBe("1234.56");
	});

	it("throws on empty input via the Rosetta path", () => {
		const stub = makeStub(
			{ decimal: ",", group: ".", minus: "-", plusSign: "+" },
			() => "",
		);
		expect(() => Decimal.parseLocale("", stub)).toThrow(/empty string/);
	});

	it("throws on malformed input via the Rosetta path", () => {
		const stub = makeStub(
			{ decimal: ",", group: ".", minus: "-", plusSign: "+" },
			() => "",
		);
		expect(() => Decimal.parseLocale("abc", stub)).toThrow(
			/Invalid localized decimal/,
		);
	});

	it("continues to accept Intl.LocalesArgument (back-compat)", () => {
		expect(Decimal.parseLocale("1 234,56", "fr-FR").toString()).toBe("1234.56");
		expect(Decimal.parseLocale("1,234.56", "en-US").toString()).toBe("1234.56");
	});
});

describe("decimal.toLocale (Rosetta path)", () => {
	it("routes the string value to formatNumberString — preserves precision", () => {
		let receivedValue = "";
		let receivedOptions: Intl.NumberFormatOptions | undefined;
		const stub = makeStub(
			{ decimal: ",", group: " ", minus: "-", plusSign: "+" },
			(v, o) => {
				receivedValue = v;
				receivedOptions = o;
				return `formatted(${v})`;
			},
		);
		const d = new Decimal("1234567890123456.789");
		const out = d.toLocale(stub, { style: "currency", currency: "EUR" });
		// The Decimal's exact 18-digit string MUST reach the formatter
		// without intermediate `Number()` truncation.
		expect(receivedValue).toBe("1234567890123456.789");
		expect(receivedOptions).toEqual({ style: "currency", currency: "EUR" });
		expect(out).toBe("formatted(1234567890123456.789)");
	});

	it("continues to accept Intl.LocalesArgument (back-compat)", () => {
		const d = new Decimal("1234.56");
		const out = d.toLocale("fr-FR");
		// Escape the dot so it is not a regex wildcard; accept any
		// fr-FR group separator (ASCII space, NBSP U+00A0, narrow NBSP U+202F).
		expect(out).toMatch(/^1[   ]234,56$/);
	});

	it("falls through to Intl when arg is not RosettaLike", () => {
		const d = new Decimal("42");
		expect(d.toLocale(undefined)).toBe("42");
		expect(d.toLocale("en-US")).toBe("42");
	});
});
