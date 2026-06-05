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

// Real-Rosetta unit tests — spec T5 mandates BOTH stub and real
// instance coverage. These exercise the same paths as the smoke
// suite but live at the unit-test level so they fail fast on
// dispatch-level regressions.
describe("Decimal.parseLocale + toLocale (real Rosetta instance)", () => {
	it("parseLocale via rosetta.locale('eo-CUSTOM') honors fallbackLocales", async () => {
		const { Rosetta } = await import("@c9up/rosetta");
		const r = new Rosetta({
			fallbackLocales: { "eo-CUSTOM": "fr-FR" },
		});
		const d = Decimal.parseLocale("1 234,56", r.locale("eo-CUSTOM"));
		expect(d.toString()).toBe("1234.56");
	});

	it("parseLocale via rosetta.locale('fr-FR') matches the baseline", async () => {
		const { Rosetta } = await import("@c9up/rosetta");
		const r = new Rosetta();
		const d = Decimal.parseLocale("1 234,56", r.locale("fr-FR"));
		expect(d.toString()).toBe("1234.56");
	});

	it("toLocale via rosetta.locale('fr-FR') with currency style preserves the 16-digit integer part", async () => {
		const { Rosetta } = await import("@c9up/rosetta");
		const r = new Rosetta();
		const big = new Decimal("1234567890123456.789");
		const out = big.toLocale(r.locale("fr-FR"), {
			style: "currency",
			currency: "EUR",
		});
		// Currency style applies `maximumFractionDigits: 2` per ECMA-402,
		// so .789 rounds to .79. The integer part (16 digits) MUST
		// survive byte-for-byte — that is the no-Number-coercion guarantee.
		expect(out).toMatch(/1[   ]234[   ]567[   ]890[   ]123[   ]456/);
		expect(out).toMatch(/79/);
		expect(out).toMatch(/€|EUR/);
	});

	it("toLocale via rosetta.locale('en-US') with default style preserves all 18 digits", async () => {
		const { Rosetta } = await import("@c9up/rosetta");
		const r = new Rosetta();
		const big = new Decimal("1234567890123456.789");
		const out = big.toLocale(r.locale("en-US"));
		// Default (decimal) style imposes no fractional cap, so every
		// digit survives.
		expect(out.replace(/[^0-9]/g, "")).toBe("1234567890123456789");
	});
});
