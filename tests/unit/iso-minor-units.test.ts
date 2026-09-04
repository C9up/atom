/**
 * The scale a currency gets when nobody names one.
 *
 * `Money` reads its scale from a table of ISO 4217 minor units. A table
 * holding only some of them does not fail — it answers two for the rest, which
 * is a plausible number for every currency and the right one for most, so the
 * ones it is wrong about are wrong quietly.
 */
import { describe, expect, it } from "vitest";
import { money } from "../../src/index.js";

/**
 * ISO 4217, restated here rather than read out of the implementation: a test
 * that asks the table what the table says cannot notice a missing row.
 */
const ISO_EXCEPTIONS: Record<string, number> = {
	BHD: 3,
	BIF: 0,
	CLF: 4,
	CLP: 0,
	DJF: 0,
	GNF: 0,
	IQD: 3,
	ISK: 0,
	JOD: 3,
	JPY: 0,
	KMF: 0,
	KRW: 0,
	KWD: 3,
	LYD: 3,
	OMR: 3,
	PYG: 0,
	RWF: 0,
	TND: 3,
	UGX: 0,
	UYI: 0,
	UYW: 4,
	VND: 0,
	VUV: 0,
	XAF: 0,
	XOF: 0,
	XPF: 0,
};

/**
 * ISO gives the Iraqi dinar 1000 fils; CLDR, which is what `Intl` prints from,
 * gives it none. The table follows ISO, so this is the one entry the runtime
 * cannot be used to check.
 */
const ISO_CLDR_DISAGREE = new Set(["IQD"]);

describe("atom > the minor units a currency gets by default", () => {
	it("gives every ISO 4217 exception the scale ISO gives it", () => {
		const wrong = Object.entries(ISO_EXCEPTIONS)
			.filter(([code, units]) => money("1", code).scale !== units)
			.map(([code, units]) => `${code}: expected ${units}`);
		expect(wrong).toEqual([]);
	});

	it("agrees with the runtime's own currency data", () => {
		// An independent oracle: CLDR ships with the platform and knows the same
		// answer, so a typo in the table shows up here without anyone updating a
		// second list by hand.
		const disagreements = Object.keys(ISO_EXCEPTIONS)
			.filter((code) => !ISO_CLDR_DISAGREE.has(code))
			.map((code) => ({
				code,
				atom: money("1", code).scale,
				cldr: new Intl.NumberFormat("en", {
					style: "currency",
					currency: code,
				}).resolvedOptions().maximumFractionDigits,
			}))
			.filter((row) => row.atom !== row.cldr);
		expect(disagreements).toEqual([]);
	});

	it("holds a króna at no decimals, the way it holds a yen", () => {
		const isk = money("1234", "ISK");
		expect(isk.scale).toBe(0);
		// A hundredfold error on the way into an integer column: the amount
		// came back as 123400 while the table read two decimals for a currency
		// that has none.
		expect(isk.toMinorUnits()).toBe(1234n);
		expect(isk.toString()).toBe("1234 ISK");
		expect(isk.format({ locale: "en-US" })).not.toMatch(/\./);
	});

	it("keeps the three fils of a dinar instead of refusing them", () => {
		const jod = money("10.505", "JOD");
		expect(jod.scale).toBe(3);
		expect(jod.toMinorUnits()).toBe(10505n);
		expect(jod.toString()).toBe("10.505 JOD");
	});

	it("still answers two for a currency that is not an exception", () => {
		expect(money("1", "EUR").scale).toBe(2);
		expect(money("1", "USD").scale).toBe(2);
		// Not in ISO's numbered list either — two is the fallback, not a lookup.
		expect(money("1", "XAU").scale).toBe(2);
	});

	it("still lets an explicit scale override the table", () => {
		expect(money("1.00", "ISK", { scale: 2 }).scale).toBe(2);
	});
});
