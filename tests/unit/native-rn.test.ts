/**
 * The engine on a phone (src/native.rn.ts): the JSI module found through React
 * Native's own lookup, exposed as native.ts exposes the N-API binding, and
 * `Bulk#runAsync` handing a plan to the module's worker thread.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as napi from "../../src/native.js";

const engine = napi.nativeAtom();

/** The JSI module, played by the N-API binding — what NativeAtom.cpp calls into. */
function jsiModule(worker: string[]) {
	return {
		add: engine.add,
		sub: engine.sub,
		mul: engine.mul,
		div: engine.div,
		rem: engine.rem,
		pow: engine.pow,
		sqrt: engine.sqrt,
		sum: engine.sum,
		dot: engine.dot,
		cmp: engine.cmp,
		runBulk: engine.runBulk,
		runBulkAsync: async (
			values: BigInt64Array,
			rows: number,
			program: Int32Array,
		) => {
			worker.push("runBulkAsync");
			return engine.runBulk(values, rows, program);
		},
	};
}

async function loadRn(proxy: unknown) {
	vi.resetModules();
	Reflect.set(globalThis, "__turboModuleProxy", proxy);
	return import("../../src/native.rn.js");
}

afterEach(() => {
	Reflect.deleteProperty(globalThis, "__turboModuleProxy");
	Reflect.deleteProperty(globalThis, "nativeModuleProxy");
	vi.resetModules();
});

describe("atom on a phone", () => {
	it("exports what native.ts exports", async () => {
		const rn = await loadRn(undefined);
		expect(Object.keys(rn).sort()).toEqual(Object.keys(napi).sort());
	});

	it("uses the JSI module React Native's proxy hands back, with N-API's results", async () => {
		const asked: string[] = [];
		const rn = await loadRn((name: string) => {
			asked.push(name);
			return jsiModule([]);
		});
		expect(asked).toEqual(["NativeAtom"]);
		expect(rn.isNativeAvailable()).toBe(true);
		const native = rn.nativeAtom();
		expect(native.add("0.1", "0.2")).toBe(engine.add("0.1", "0.2"));
		expect(native.div("1", "3", 10, "half-even")).toBe(
			engine.div("1", "3", 10, "half-even"),
		);
		expect(native.sum(["1.5", "2.25"])).toBe("3.75");
		expect(native.cmp("2", "10")).toBe(-1);
	});

	it("hands every operation to the module, as N-API answers it", async () => {
		const rn = await loadRn(() => jsiModule([]));
		const native = rn.nativeAtom();
		expect(native.sub("0.3", "0.1")).toBe(engine.sub("0.3", "0.1"));
		expect(native.mul("1.5", "-2")).toBe(engine.mul("1.5", "-2"));
		expect(native.rem("10", "3")).toBe(engine.rem("10", "3"));
		expect(native.pow("1.1", 3, 10, "half-even")).toBe(
			engine.pow("1.1", 3, 10, "half-even"),
		);
		expect(native.sqrt("2", 12)).toBe(engine.sqrt("2", 12));
		expect(native.dot(["1.5", "2"], ["2", "3"])).toBe(
			engine.dot(["1.5", "2"], ["2", "3"]),
		);
	});

	it("lets a test stand in for the module, or take it away", async () => {
		const rn = await loadRn(() => jsiModule([]));
		rn.__overrideNativeForTesting(null);
		expect(rn.isNativeAvailable()).toBe(false);
		expect(rn.tryNativeAtom()).toBeUndefined();
		expect(rn.tryNativeAtomAsync()).toBeUndefined();
		expect(() => rn.nativeAtom()).toThrow(/ATOM_ENGINE_NOT_FOUND|override/);
		rn.__overrideNativeForTesting(engine);
		expect(rn.nativeAtom()).toBe(engine);
		expect(rn.tryNativeAtomAsync()).toBeUndefined();
		rn.__overrideNativeForTesting(undefined);
		expect(rn.tryNativeAtomAsync()).toBeDefined();
	});

	it("finds the module through nativeModuleProxy, as a bridgeless app has only that", async () => {
		vi.resetModules();
		Reflect.set(globalThis, "nativeModuleProxy", { NativeAtom: jsiModule([]) });
		const rn = await import("../../src/native.rn.js");
		expect(rn.isNativeAvailable()).toBe(true);
		expect(rn.nativeAtom().mul("1.5", "2")).toBe(engine.mul("1.5", "2"));
	});

	it("falls back to the TypeScript engine when the module is not linked", async () => {
		const rn = await loadRn(() => null);
		expect(rn.isNativeAvailable()).toBe(false);
		expect(rn.tryNativeAtom()).toBeUndefined();
		expect(() => rn.nativeAtom()).toThrow(
			expect.objectContaining({ code: "E_ATOM_ENGINE_NOT_FOUND" }),
		);
		const noProxy = await loadRn(undefined);
		expect(noProxy.tryNativeAtom()).toBeUndefined();
	});

	it("runs a bulk plan on the module's worker thread, with run()'s results", async () => {
		const worker: string[] = [];
		vi.resetModules();
		Reflect.set(globalThis, "__turboModuleProxy", () => jsiModule(worker));
		vi.doMock("../../src/native.js", () => import("../../src/native.rn.js"));
		const { Bulk } = await import("../../src/bulk.js");
		const plan = () => {
			const bulk = new Bulk();
			const prices = bulk.column(["10.50", "20.25", "3.10"]);
			const qty = bulk.column(["2", "1", "4"]);
			return {
				bulk,
				outputs: { total: prices.times(qty).sum(), top: prices.max() },
			};
		};
		const sync = (() => {
			const { bulk, outputs } = plan();
			return bulk.run(outputs);
		})();
		const { bulk, outputs } = plan();
		const result = await bulk.runAsync(outputs);
		expect(worker).toEqual(["runBulkAsync"]);
		expect(result.total.toString()).toBe(sync.total.toString());
		expect(result.top.toString()).toBe("20.25");
		vi.doUnmock("../../src/native.js");
	});

	it("answers runAsync with run() where no engine works off the thread", async () => {
		vi.resetModules();
		const { Bulk } = await import("../../src/bulk.js");
		const bulk = new Bulk();
		const column = bulk.column(["1", "2", "3"]);
		const result = await bulk.runAsync({ total: column.sum() });
		expect(result.total.toString()).toBe("6");
	});
});
