import { describe, expect, it } from "vitest";
import {
	Atom,
	avg,
	Bulk,
	type BulkScalar,
	bulk,
	Decimal,
	isNativeAvailable,
	max,
	median,
	stddev,
	sum,
} from "../../src/index.js";
import { __overrideNativeForTesting, nativeAtom } from "../../src/native.js";

/** What a plan of `T` gives back once it has been run. */
type Results<T> = { [K in keyof T]: Decimal };

/**
 * Run the same plan on both executors.
 *
 * Every behavioural claim in this file is checked twice, because bulk's whole
 * safety argument is that the narrow fast path and the unbounded BigInt path
 * give one answer. A test that only ran the engine that happened to be loaded
 * would check half of that.
 */
function onBothEngines<T extends Readonly<Record<string, BulkScalar>>>(
	build: (b: Bulk) => T,
): [Results<T>, Results<T>] {
	const engines: readonly (undefined | null)[] = [undefined, null];
	const results: Results<T>[] = [];
	for (const engine of engines) {
		__overrideNativeForTesting(engine);
		try {
			const plan = new Bulk();
			results.push(plan.run(build(plan)));
		} finally {
			__overrideNativeForTesting(undefined);
		}
	}
	const [native, fallback] = results;
	if (native === undefined || fallback === undefined) {
		throw new Error("a run produced nothing");
	}
	return [native, fallback];
}

function agree<T extends Readonly<Record<string, BulkScalar>>>(
	build: (b: Bulk) => T,
): Results<T> {
	const [native, fallback] = onBothEngines(build);
	const left: Record<string, Decimal> = native;
	const right: Record<string, Decimal> = fallback;
	for (const [key, value] of Object.entries(left)) {
		const other = right[key];
		expect(other).toBeDefined();
		expect(`${key}=${value.toString()}`).toBe(
			`${key}=${other?.toString() ?? "missing"}`,
		);
	}
	return native;
}

/** Reads a fixture value without pretending the compiler knows it is there. */
function at(values: readonly string[], index: number): string {
	const value = values[index];
	if (value === undefined) {
		throw new Error(`the fixture has no value at ${index}`);
	}
	return value;
}

const QUANTITIES = ["1.5", "2.25", "10", "0.125", "7"];
const PRICES = ["10.00", "4.20", "0.99", "1000", "3.3333"];

describe("Atom.bulk", () => {
	it("values a portfolio exactly as Decimal does", () => {
		// The spike's workload, kept as a regression guard: this is the shape
		// that justified building any of this.
		const { net, biggest } = agree((b) => {
			const gross = b.column(QUANTITIES).times(b.column(PRICES));
			const total = gross.sum();
			return {
				net: total.minus(total.times(b.of("0.0025"))),
				biggest: gross.max(),
			};
		});

		let expectedTotal = Decimal.zero();
		let expectedBiggest = new Decimal(at(QUANTITIES, 0)).times(at(PRICES, 0));
		for (let i = 0; i < QUANTITIES.length; i++) {
			const line = new Decimal(at(QUANTITIES, i)).times(at(PRICES, i));
			expectedTotal = expectedTotal.plus(line);
			if (line.gt(expectedBiggest)) expectedBiggest = line;
		}
		const expectedNet = expectedTotal.minus(expectedTotal.times("0.0025"));

		expect(net.toString()).toBe(expectedNet.toString());
		expect(biggest.toString()).toBe(expectedBiggest.toString());
	});

	it("fuses a dot product to the same value as multiplying then summing", () => {
		const { fused, composed } = agree((b) => {
			const quantities = b.column(QUANTITIES);
			const prices = b.column(PRICES);
			return {
				fused: quantities.dot(prices),
				composed: quantities.times(prices).sum(),
			};
		});
		expect(fused.toString()).toBe(composed.toString());
		expect(fused.eq(Decimal.dot(QUANTITIES, PRICES))).toBe(true);
	});

	it("agrees with the functional aggregates", () => {
		const values = ["3", "1.5", "4.25", "1", "5.5", "9", "2.6", "5"];
		const { total, mean, middle, spread, largest } = agree((b) => {
			const column = b.column(values);
			return {
				total: column.sum(),
				mean: column.avg(),
				middle: column.median(),
				spread: column.stddev(),
				largest: column.max(),
			};
		});
		expect(total.eq(sum(values))).toBe(true);
		expect(mean.eq(avg(values))).toBe(true);
		expect(middle.eq(median(values))).toBe(true);
		expect(largest.eq(max(values))).toBe(true);
		expect(spread.eq(stddev(values))).toBe(true);
	});

	it("takes a sample standard deviation the way the functional API does", () => {
		const values = ["10", "12", "23", "23", "16", "23", "21", "16"];
		const { spread } = agree((b) => ({
			spread: b.column(values).stddev({ sample: true }),
		}));
		expect(spread.eq(stddev(values, { sample: true }))).toBe(true);
	});

	it("runs a chain of dependent operations", () => {
		// The schedule shape: every step reads the step before it.
		const steps = 500;
		const { balance } = agree((b) => {
			let running = b.of("1000.00");
			const payment = b.of("12.50");
			for (let i = 0; i < steps; i++) running = running.plus(payment);
			return { balance: running };
		});

		let expected = new Decimal("1000.00");
		for (let i = 0; i < steps; i++) expected = expected.plus("12.50");
		expect(balance.toString()).toBe(expected.toString());
	});

	it("divides and takes roots the way Decimal does", () => {
		const { third, root, inverse } = agree((b) => {
			const value = b.of("2");
			return {
				third: value.div(b.of("3"), { precision: 12 }),
				root: value.sqrt({ precision: 12 }),
				inverse: value.pow(-3, { precision: 12 }),
			};
		});
		expect(third.toString()).toBe(
			new Decimal("2").div("3", { precision: 12 }).toString(),
		);
		expect(root.toString()).toBe(
			new Decimal("2").sqrt({ precision: 12 }).toString(),
		);
		expect(inverse.toString()).toBe(
			new Decimal("1")
				.div(new Decimal("2").pow(3), { precision: 12 })
				.toString(),
		);
	});

	it("reuses one plan across several runs", () => {
		const plan = new Bulk();
		const column = plan.column(QUANTITIES);
		const first = plan.run({ total: column.sum() });
		const second = plan.run({ largest: column.max() });
		expect(first.total.eq(sum(QUANTITIES))).toBe(true);
		expect(second.largest.eq(max(QUANTITIES))).toBe(true);
	});

	it("stays exact when a value is too wide for the fast path", () => {
		// Beyond 64 bits, so the plan cannot be laid out as i64 and the BigInt
		// executor has to take it. The answer must not change.
		const huge = ["92233720368547758080", "1"];
		const { total } = agree((b) => ({ total: b.column(huge).sum() }));
		expect(total.toString()).toBe("92233720368547758081");
	});

	it("stays exact when the fast path overflows mid-run", () => {
		// Each value fits i64, their repeated product does not fit i128 — the
		// engine reports it and the same plan is re-run without a width limit.
		const { power } = agree((b) => ({
			power: b.of("9223372036854775807").pow(4),
		}));
		expect(power.toString()).toBe(
			new Decimal("9223372036854775807").pow(4).toString(),
		);
	});

	it("gives the same answer whichever engine ran it", () => {
		const [native, fallback] = onBothEngines((b) => {
			const column = b.column(["1.005", "2.5", "-3.25", "0.001"]);
			return {
				total: column.sum(),
				mean: column.avg({ precision: 20 }),
				spread: column.stddev({ precision: 10 }),
			};
		});
		expect(Object.keys(native)).toEqual(Object.keys(fallback));
		expect(native.total.toString()).toBe(fallback.total.toString());
		expect(native.mean.toString()).toBe(fallback.mean.toString());
		expect(native.spread.toString()).toBe(fallback.spread.toString());
	});

	it("refuses to be read before it has been run", () => {
		const plan = new Bulk();
		const total = plan.column(QUANTITIES).sum();
		expect(() => `${total}`).toThrow(/ATOM_BULK_NOT_RUN/);
		expect(() => JSON.stringify(total)).toThrow(/ATOM_BULK_NOT_RUN/);
		expect(() => Number(total)).toThrow(/ATOM_BULK_NOT_RUN/);
	});

	it("refuses columns of different lengths", () => {
		const plan = new Bulk();
		plan.column(["1", "2", "3"]);
		expect(() => plan.column(["1", "2"])).toThrow(/ATOM_BULK_LENGTH_MISMATCH/);
	});

	it("refuses an empty column and an empty run", () => {
		const plan = new Bulk();
		expect(() => plan.column([])).toThrow(/ATOM_BULK_EMPTY_COLUMN/);
		expect(() => plan.run({})).toThrow(/ATOM_BULK_NO_OUTPUT/);
	});

	it("refuses a percentile outside the unit interval", () => {
		const plan = new Bulk();
		const column = plan.column(QUANTITIES);
		expect(() => column.percentile(1.5)).toThrow(/ATOM_BULK_BAD_PERCENTILE/);
	});

	it("takes a percentile by nearest rank", () => {
		const values = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
		const { p50, p90, p100 } = agree((b) => {
			const column = b.column(values);
			return {
				p50: column.percentile(0.5),
				p90: column.percentile(0.9),
				p100: column.percentile(1),
			};
		});
		expect(p50.toString()).toBe("5");
		expect(p90.toString()).toBe("9");
		expect(p100.toString()).toBe("10");
	});

	it("is reachable from the Atom namespace in one call", () => {
		const { total } = Atom.bulk((b) => ({
			total: b.column(QUANTITIES).dot(b.column(PRICES)),
		}));
		expect(total.eq(Decimal.dot(QUANTITIES, PRICES))).toBe(true);
	});

	it("runs on whichever engine this build has", () => {
		expect(typeof isNativeAvailable()).toBe("boolean");
	});

	it.skipIf(!isNativeAvailable())(
		"really hands the plan to the engine rather than quietly falling back",
		() => {
			// Without this, every test above would still pass if the compiler
			// gave up on every plan and the BigInt executor answered all of
			// them. The fast path has to be shown to run, not assumed.
			const engine = nativeAtom();
			let crossings = 0;
			__overrideNativeForTesting({
				...engine,
				runBulk: (values, rows, program) => {
					crossings += 1;
					return engine.runBulk(values, rows, program);
				},
			});
			try {
				const plan = new Bulk();
				const gross = plan.column(QUANTITIES).times(plan.column(PRICES));
				const { net } = plan.run({
					net: gross.sum().minus(gross.sum().times(plan.of("0.0025"))),
				});
				expect(crossings).toBe(1);
				expect(net.toString()).toBe(
					Decimal.dot(QUANTITIES, PRICES)
						.minus(Decimal.dot(QUANTITIES, PRICES).times("0.0025"))
						.toString(),
				);

				// A 500-step chain is still one crossing. That is the whole point.
				const chain = new Bulk();
				let running = chain.of("1000.00");
				const payment = chain.of("12.50");
				for (let i = 0; i < 500; i++) running = running.plus(payment);
				chain.run({ balance: running });
				expect(crossings).toBe(2);
			} finally {
				__overrideNativeForTesting(undefined);
			}
		},
	);
});

describe("Atom.bulk — every operation against Decimal", () => {
	const A = ["3.5", "-1.25", "10", "0.004"];
	const B = ["2", "4.5", "-0.5", "1000"];

	it("does elementwise arithmetic against another column", () => {
		const { added, subtracted, multiplied } = agree((b) => {
			const left = b.column(A);
			const right = b.column(B);
			return {
				added: left.plus(right).sum(),
				subtracted: left.minus(right).sum(),
				multiplied: left.times(right).sum(),
			};
		});
		const expect3 = (pick: (x: Decimal, y: Decimal) => Decimal): string => {
			let total = Decimal.zero();
			for (let i = 0; i < A.length; i++) {
				total = total.plus(pick(new Decimal(at(A, i)), new Decimal(at(B, i))));
			}
			return total.toString();
		};
		expect(added.toString()).toBe(expect3((x, y) => x.plus(y)));
		expect(subtracted.toString()).toBe(expect3((x, y) => x.minus(y)));
		expect(multiplied.toString()).toBe(expect3((x, y) => x.times(y)));
	});

	it("does elementwise arithmetic against one value", () => {
		const { added, subtracted, multiplied } = agree((b) => {
			const column = b.column(A);
			const rate = b.of("1.075");
			return {
				added: column.plus(rate).sum(),
				subtracted: column.minus(rate).sum(),
				multiplied: column.times(rate).sum(),
			};
		});
		const fold = (pick: (x: Decimal) => Decimal): string => {
			let total = Decimal.zero();
			for (const value of A) total = total.plus(pick(new Decimal(value)));
			return total.toString();
		};
		expect(added.toString()).toBe(fold((x) => x.plus("1.075")));
		expect(subtracted.toString()).toBe(fold((x) => x.minus("1.075")));
		expect(multiplied.toString()).toBe(fold((x) => x.times("1.075")));
	});

	it("negates and takes absolute values, by column and by value", () => {
		const { negated, absolute, valueNegated, valueAbsolute } = agree((b) => {
			const column = b.column(A);
			const value = b.of("-7.25");
			return {
				negated: column.neg().sum(),
				absolute: column.abs().sum(),
				valueNegated: value.neg(),
				valueAbsolute: value.abs(),
			};
		});
		let negatedTotal = Decimal.zero();
		let absoluteTotal = Decimal.zero();
		for (const value of A) {
			negatedTotal = negatedTotal.plus(new Decimal(value).neg());
			absoluteTotal = absoluteTotal.plus(new Decimal(value).abs());
		}
		expect(negated.toString()).toBe(negatedTotal.toString());
		expect(absolute.toString()).toBe(absoluteTotal.toString());
		expect(valueNegated.toString()).toBe("7.25");
		expect(valueAbsolute.toString()).toBe("7.25");
	});

	it("sorts a column and reads a position in it", () => {
		const { smallest, largest, lowest } = agree((b) => {
			const column = b.column(A);
			const sorted = column.sorted();
			return {
				smallest: sorted.at(0),
				largest: sorted.at(A.length - 1),
				lowest: column.min(),
			};
		});
		expect(smallest.toString()).toBe("-1.25");
		expect(largest.toString()).toBe("10");
		expect(lowest.toString()).toBe("-1.25");
	});

	it("picks the smaller and the larger of two values", () => {
		const { smaller, larger } = agree((b) => {
			const left = b.of("2.50");
			const right = b.of("2.5001");
			return { smaller: left.min(right), larger: left.max(right) };
		});
		expect(smaller.toString()).toBe("2.5");
		expect(larger.toString()).toBe("2.5001");
	});

	it("raises a value to a whole power", () => {
		const { cubed, zeroth } = agree((b) => {
			const value = b.of("1.05");
			return { cubed: value.pow(3), zeroth: value.pow(0) };
		});
		expect(cubed.toString()).toBe(new Decimal("1.05").pow(3).toString());
		expect(zeroth.toString()).toBe("1");
	});

	it("keeps a plan usable without the callback form", () => {
		const plan = bulk();
		expect(plan).toBeInstanceOf(Bulk);
		const { total } = plan.run({ total: plan.column(A).sum() });
		expect(total.eq(sum(A))).toBe(true);
	});

	it("refuses the mistakes a plan can catch before it runs", () => {
		const plan = new Bulk();
		const column = plan.column(A);
		expect(() => column.at(A.length)).toThrow(/ATOM_BULK_BAD_INDEX/);
		expect(() => column.at(-1)).toThrow(/ATOM_BULK_BAD_INDEX/);
		expect(() => plan.of("2").pow(1.5)).toThrow(/ATOM_BULK_BAD_EXPONENT/);
		expect(() => plan.column(["1"])).toThrow(/ATOM_BULK_LENGTH_MISMATCH/);
	});

	it("refuses a sample deviation of a single value", () => {
		const plan = new Bulk();
		const single = plan.column(["42"]);
		expect(() => single.stddev({ sample: true })).toThrow(
			/ATOM_BULK_TOO_SHORT/,
		);
	});
});

describe("Atom.bulk — the edges of the plan", () => {
	it("takes the middle of an odd-length column without averaging", () => {
		const values = ["5", "1", "9", "3", "7"];
		const { middle } = agree((b) => ({ middle: b.column(values).median() }));
		expect(middle.toString()).toBe("5");
		expect(middle.eq(median(values))).toBe(true);
	});

	it("takes numbers, bigints and Decimals into a column", () => {
		const { total } = agree((b) => ({
			total: b.column([1.5, 2n, new Decimal("0.25"), "3"]).sum(),
		}));
		expect(total.toString()).toBe("6.75");
	});

	it("falls back on the context precision when none is given", () => {
		const { root, inverse } = agree((b) => {
			const value = b.of("2");
			return { root: value.sqrt(), inverse: value.pow(-2) };
		});
		expect(root.toString()).toBe(new Decimal("2").sqrt().toString());
		expect(inverse.toString()).toBe(
			new Decimal("1").div(new Decimal("2").pow(2)).toString(),
		);
	});

	it("lets a real engine error through instead of quietly retrying", () => {
		// Only an overflow means "too narrow, try the wide executor". Anything
		// else is a genuine refusal and has to reach the caller, on whichever
		// engine produced it.
		for (const engine of [undefined, null] as const) {
			__overrideNativeForTesting(engine);
			try {
				const plan = new Bulk();
				const divided = plan.of("1").div(plan.of("0"));
				expect(() => plan.run({ divided })).toThrow();
			} finally {
				__overrideNativeForTesting(undefined);
			}
		}
	});
});

describe("Atom.bulk — columns already held as minor units", () => {
	it("means the same thing as the decimal strings it stands for", () => {
		// 1234 at scale 2 is 12.34 — the counterpart of Decimal.fromMinorUnits,
		// and the shape a money column is usually stored in.
		const minor = [1234n, 99n, -50n, 1000000n];
		const decimals = ["12.34", "0.99", "-0.50", "10000.00"];

		const viaMinor = agree((b) => ({ total: b.minorUnits(minor, 2).sum() }));
		const viaStrings = agree((b) => ({ total: b.column(decimals).sum() }));

		expect(viaMinor.total.toString()).toBe(viaStrings.total.toString());
		expect(viaMinor.total.eq(sum(decimals))).toBe(true);
		expect(
			viaMinor.total.eq(
				Decimal.fromMinorUnits(1234n + 99n - 50n + 1000000n, 2),
			),
		).toBe(true);
	});

	it("takes its whole numbers as bigints, numbers or strings", () => {
		const { fromBigints, fromNumbers, fromStrings } = agree((b) => ({
			fromBigints: b.minorUnits([1234n, 99n], 2).sum(),
			fromNumbers: b.minorUnits([1234, 99], 2).sum(),
			fromStrings: b.minorUnits(["1234", "99"], 2).sum(),
		}));
		expect(fromBigints.toString()).toBe("13.33");
		expect(fromNumbers.toString()).toBe("13.33");
		expect(fromStrings.toString()).toBe("13.33");
	});

	it("mixes with decimal columns at another scale", () => {
		// Quantities as plain decimals, prices as minor units: the scales differ
		// and the product has to come out exact anyway.
		const { valued } = agree((b) => ({
			valued: b.column(["1.5", "2"]).dot(b.minorUnits([1050n, 99n], 2)),
		}));
		expect(valued.eq(Decimal.dot(["1.5", "2"], ["10.50", "0.99"]))).toBe(true);
		expect(valued.toString()).toBe("17.73");
	});

	it("refuses anything that is not a whole number of minor units", () => {
		const plan = new Bulk();
		expect(() => plan.minorUnits([1.5], 2)).toThrow(
			/ATOM_BULK_NOT_MINOR_UNITS/,
		);
		expect(() => plan.minorUnits(["12.34"], 2)).toThrow(
			/ATOM_BULK_NOT_MINOR_UNITS/,
		);
		expect(() => plan.minorUnits([Number.MAX_SAFE_INTEGER + 2], 2)).toThrow(
			/ATOM_BULK_NOT_MINOR_UNITS/,
		);
	});

	it("refuses a scale that is not one", () => {
		const plan = new Bulk();
		expect(() => plan.minorUnits([1n], -1)).toThrow(/ATOM_BULK_BAD_SCALE/);
		expect(() => plan.minorUnits([1n], 1.5)).toThrow(/ATOM_BULK_BAD_SCALE/);
		expect(() => plan.minorUnits([1n], 10_001)).toThrow(/ATOM_BULK_BAD_SCALE/);
	});

	it("counts toward the plan's one column length", () => {
		const plan = new Bulk();
		plan.minorUnits([1n, 2n, 3n], 2);
		expect(() => plan.column(["1", "2"])).toThrow(/ATOM_BULK_LENGTH_MISMATCH/);
	});
});
