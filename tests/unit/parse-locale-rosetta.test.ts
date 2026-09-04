/**
 * Unit tests for the `Decimal.parseLocale` / `decimal.toLocale`
 * Rosetta overload.
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

/**
 * `Intl.NumberFormat` with the string-accepting overload ECMA-402 specifies
 * and TypeScript's lib omits — the same declaration the implementation uses to
 * keep a precise value out of a `number`.
 */
interface StringFormatter extends Intl.NumberFormat {
	format(value: number | bigint | string): string;
}

function formatterFor(
	locale: string,
	options?: Intl.NumberFormatOptions,
): StringFormatter {
	return new Intl.NumberFormat(locale, options);
}

/**
 * A `RosettaLike` for a real locale, built the way Rosetta builds one: the
 * separators off `formatToParts`, the formatting off `Intl.NumberFormat`'s
 * string overload. Only the two methods the structural interface declares.
 */
function rosettaFor(locale: string): RosettaLike {
	const parts = new Intl.NumberFormat(locale).formatToParts(-12345.6);
	const of = (type: string): string =>
		parts.find((part) => part.type === type)?.value ?? "";
	return {
		getNumberFormatData: () => ({
			decimal: of("decimal"),
			group: of("group"),
			minus: of("minusSign"),
			plusSign: "+",
		}),
		formatNumberString: (value, options) =>
			formatterFor(locale, options).format(value),
	};
}

describe("atom > the two ways of naming a locale agree", () => {
	/**
	 * The locales that separate the two paths: `hi-IN` and `bn-BD` group 3-2,
	 * and `ar-EG` and `bn-BD` write digits that are not ASCII. Reading the
	 * separators alone got none of that, so the Rosetta path refused what the
	 * `Intl` path accepted, for the same locale.
	 */
	const locales = ["en-US", "fr-FR", "de-DE", "hi-IN", "bn-BD", "ar-EG"];

	for (const locale of locales) {
		it(`parses ${locale} the same either way`, () => {
			const written = new Intl.NumberFormat(locale).format(1234567.89);
			const viaLocale = Decimal.parseLocale(written, locale);
			const viaRosetta = Decimal.parseLocale(written, rosettaFor(locale));
			expect(viaRosetta.toString()).toBe(viaLocale.toString());
			expect(viaRosetta.toString()).toBe("1234567.89");
		});
	}

	it("enforces the locale's own grouping through a Rosetta, not en-US's", () => {
		// `1,234,567` is well-formed in en-US and malformed in hi-IN, which
		// groups the crore and lakh in twos. Validated against 3-3 whatever the
		// locale, it passed here.
		expect(() => Decimal.parseLocale("1,234,567", rosettaFor("hi-IN"))).toThrow(
			/Invalid localized decimal/,
		);
		expect(
			Decimal.parseLocale("12,34,567", rosettaFor("hi-IN")).toString(),
		).toBe("1234567");
	});

	it("falls back to ASCII grouping when the Rosetta cannot format", () => {
		// The digits and the grouping are read by asking the Rosetta to format
		// something. One that refuses still has to parse an ASCII number.
		const refusing = makeStub(
			{ decimal: ".", group: ",", minus: "-", plusSign: "+" },
			() => {
				throw new Error("no formatter configured");
			},
		);
		expect(Decimal.parseLocale("1,234.56", refusing).toString()).toBe(
			"1234.56",
		);
	});
});
