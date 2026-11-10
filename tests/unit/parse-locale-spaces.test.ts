import { describe, expect, it } from "vitest";
import { Decimal } from "../../src/index.js";

const parse = (value: string, locale: string): string =>
	Decimal.parseLocale(value, locale).toString();

describe("Decimal.parseLocale — whitespace", () => {
	it("refuses a space where the locale does not group with one", () => {
		const cases: readonly (readonly [string, string])[] = [
			["1 2 3", "en-US"],
			["1 234.5", "en-US"],
			["- 5", "en-US"],
			["1 0,5", "de-DE"],
			["12 34 567", "hi-IN"],
		];
		for (const [value, locale] of cases) {
			expect(() => Decimal.parseLocale(value, locale), value).toThrow(
				/Invalid localized decimal/,
			);
		}
	});

	it("holds a space-grouped locale to its group sizes", () => {
		for (const value of [
			"12 34 5,6",
			"1 23,45",
			"1  234,56",
			"1 234 ,56",
			"- 5",
			"1234 567,8",
		]) {
			expect(() => Decimal.parseLocale(value, "fr-FR"), value).toThrow(
				/Invalid localized decimal/,
			);
		}
	});

	it("takes any of the three spaces a space-grouped locale is typed with", () => {
		expect(parse("1 234,56", "fr-FR")).toBe("1234.56");
		expect(parse("1 234,56", "fr-FR")).toBe("1234.56");
		expect(parse("1 234,56", "fr-FR")).toBe("1234.56");
		expect(parse("-12 345 678,9", "fr-FR")).toBe("-12345678.9");
		expect(parse("  1 234,56\t", "fr-FR")).toBe("1234.56");
	});

	it("still trims around the value and reads the usual grouping", () => {
		expect(parse("  1,234.5  ", "en-US")).toBe("1234.5");
		expect(parse("12,34,567", "hi-IN")).toBe("1234567");
		expect(parse("1.234,5", "de-DE")).toBe("1234.5");
	});

	it("reads back what Intl writes, in every locale it is asked for", () => {
		const locales = Intl.NumberFormat.supportedLocalesOf([
			"en-US",
			"fr-FR",
			"fr-CH",
			"de-DE",
			"de-CH",
			"hi-IN",
			"bn-IN",
			"ar-EG",
			"fa-IR",
			"he-IL",
			"ur-PK",
			"ru-RU",
			"sv-SE",
			"nb-NO",
			"pl-PL",
			"cs-CZ",
			"es-ES",
			"pt-BR",
			"ja-JP",
			"th-TH-u-nu-thai",
		]);
		expect(locales.length).toBeGreaterThan(10);
		for (const locale of locales) {
			for (const value of ["1234567.891", "-1234567.891", "-0.5", "12.3"]) {
				const text = new Decimal(value).toLocale(locale, {
					maximumFractionDigits: 3,
				});
				expect(`${locale} ${text} -> ${parse(text, locale)}`).toBe(
					`${locale} ${text} -> ${value}`,
				);
			}
		}
	});
});
