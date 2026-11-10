import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
	configureAtomContext,
	Decimal,
	getAtomContext,
	resetAtomContext,
	withAtomContext,
} from "../../src/index.js";

afterEach(() => {
	resetAtomContext();
});

const third = (): string => new Decimal("1").div("3").toString();

describe("withAtomContext — a scope that follows its async call", () => {
	it("keeps its precision after an await", async () => {
		const seen = await withAtomContext({ precision: 2 }, async () => {
			const before = third();
			await sleep(1);
			const after = third();
			return `${before} | ${after}`;
		});
		expect(seen).toBe("0.33 | 0.33");
		expect(third()).toBe("0.333333333333333333");
	});

	it("keeps two concurrent scopes apart", async () => {
		const scope = (precision: number, delay: number) =>
			withAtomContext({ precision }, async () => {
				const seen: string[] = [];
				for (let i = 0; i < 3; i++) {
					await sleep(delay);
					seen.push(third());
				}
				return seen;
			});
		const [two, four] = await Promise.all([scope(2, 3), scope(4, 2)]);
		expect(two).toEqual(["0.33", "0.33", "0.33"]);
		expect(four).toEqual(["0.3333", "0.3333", "0.3333"]);
		expect(third()).toBe("0.333333333333333333");
	});

	it("is not seen by work that started outside it", async () => {
		const outside = (async () => {
			await sleep(3);
			return third();
		})();
		await withAtomContext({ precision: 1 }, async () => {
			await sleep(5);
		});
		expect(await outside).toBe("0.333333333333333333");
	});

	it("keeps a configuration made inside it to itself", async () => {
		await withAtomContext({ precision: 2 }, async () => {
			configureAtomContext({ precision: 5 });
			await sleep(1);
			expect(third()).toBe("0.33333");
			expect(getAtomContext().precision).toBe(5);
		});
		withAtomContext({}, () => {
			configureAtomContext({ precision: 6 });
			expect(third()).toBe("0.333333");
		});
		expect(getAtomContext().precision).toBe(18);
	});

	it("nests, the inner scope starting from the outer one", async () => {
		await withAtomContext({ precision: 2, roundMode: "trunc" }, async () => {
			await withAtomContext({ precision: 3 }, async () => {
				await sleep(1);
				expect(new Decimal("2").div("3").toString()).toBe("0.666");
			});
			expect(new Decimal("2").div("3").toString()).toBe("0.66");
		});
	});
});

describe("Atom context — refused when it is set", () => {
	it("refuses a rounding mode it does not know", () => {
		const configure = (options: unknown): unknown =>
			Reflect.apply(configureAtomContext, undefined, [options]);
		const scoped = (options: unknown): unknown =>
			Reflect.apply(withAtomContext, undefined, [options, () => 0]);
		for (const options of [
			{ roundMode: "bogus" },
			{ quantizeMode: "nearest" },
			{ roundMode: undefined },
			{ quantizeMode: 4 },
		]) {
			expect(() => configure(options)).toThrow(/Invalid Atom context/);
			expect(() => scoped(options)).toThrow(/Invalid Atom context/);
		}
		expect(getAtomContext().roundMode).toBe("half-up");
	});
});
