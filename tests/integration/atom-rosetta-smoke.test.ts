/**
 * Cross-package smoke test — Story 35.8.
 *
 * Drives `Decimal.parseLocale` / `decimal.toLocale` through a
 * real `Rosetta` instance to verify the duck-typing contract
 * works end-to-end with the actual Rosetta exports.
 */

import { Rosetta } from "@c9up/rosetta";
import { describe, expect, it } from "vitest";
import { Decimal } from "../../src/Decimal.js";

describe("Atom + Rosetta smoke", () => {
	it('parseLocale via rosetta.locale("fr-FR") matches bare-Intl path', () => {
		const r = new Rosetta();
		const a = Decimal.parseLocale("1 234,56", r.locale("fr-FR"));
		const b = Decimal.parseLocale("1 234,56", "fr-FR");
		expect(a.toString()).toBe(b.toString());
		expect(a.toString()).toBe("1234.56");
	});

	it('parseLocale via rosetta.locale("de-DE") works for German formatting', () => {
		const r = new Rosetta();
		const d = Decimal.parseLocale("1.234,56", r.locale("de-DE"));
		expect(d.toString()).toBe("1234.56");
	});

	it('parseLocale via rosetta.locale("en-US") works for US formatting', () => {
		const r = new Rosetta();
		const d = Decimal.parseLocale("1,234.56", r.locale("en-US"));
		expect(d.toString()).toBe("1234.56");
	});

	it("honors fallbackLocales — eo-CUSTOM resolves through fr-FR", () => {
		const r = new Rosetta({
			fallbackLocales: { "eo-CUSTOM": "fr-FR" },
		});
		const d = Decimal.parseLocale("1 234,56", r.locale("eo-CUSTOM"));
		expect(d.toString()).toBe("1234.56");
	});

	it("toLocale routes through formatNumberString — preserves precision", () => {
		const r = new Rosetta();
		const big = new Decimal("1234567890123456.789");
		const out = big.toLocale(r.locale("en-US"));
		// Every digit must survive — the bare-Intl `Number()` cast
		// would have produced "1,234,567,890,123,457,000".
		expect(out.replace(/[^0-9]/g, "")).toBe("1234567890123456789");
	});

	it("round-trip: parseLocale → toLocale → parseLocale yields the same Decimal", () => {
		const r = new Rosetta();
		const fr = r.locale("fr-FR");
		const start = new Decimal("1234.56");
		const formatted = start.toLocale(fr);
		const reparsed = Decimal.parseLocale(formatted, fr);
		expect(reparsed.toString()).toBe(start.toString());
	});

	it("Rosetta is reachable via @c9up/rosetta — duck-typing precondition holds", () => {
		const r = new Rosetta();
		expect(typeof r.getNumberFormatData).toBe("function");
		expect(typeof r.formatNumberString).toBe("function");
		const fr = r.locale("fr-FR");
		expect(typeof fr.getNumberFormatData).toBe("function");
		expect(typeof fr.formatNumberString).toBe("function");
	});
});
