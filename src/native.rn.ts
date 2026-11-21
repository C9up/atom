/**
 * The engine on a phone: atom's Rust engine through its JSI module
 * (android/src/main/cpp/NativeAtom.cpp, specs/NativeAtom.ts), which
 * `ream android:*` links into the app from atom's `reamNative` declaration.
 *
 * React Native's bundler takes this file in place of native.ts (the
 * `react-native` field of package.json): no top-level await and no `node:`
 * import, which Hermes cannot load. Without the module (an app that did not
 * link it, Expo Go), the Decimal facade falls back to the TypeScript engine,
 * as everywhere else. It exports what native.ts exports.
 */
import type { NativeAtom, NativeAtomAsync } from "./native.js";

export type { NativeAtom, NativeAtomAsync } from "./native.js";

/** The JSI module, as specs/NativeAtom.ts declares it. */
interface JsiAtom {
	add(a: string, b: string): string;
	sub(a: string, b: string): string;
	mul(a: string, b: string): string;
	div(a: string, b: string, precision: number, mode: string): string;
	rem(a: string, b: string): string;
	pow(a: string, exp: number, precision: number, mode: string): string;
	sqrt(a: string, precision: number): string;
	sum(values: readonly string[]): string;
	dot(a: readonly string[], b: readonly string[]): string;
	cmp(a: string, b: string): number;
	runBulk(values: object, rows: number, program: object): readonly string[];
	runBulkAsync(
		values: object,
		rows: number,
		program: object,
	): Promise<readonly string[]>;
}

const METHODS = [
	"add",
	"sub",
	"mul",
	"div",
	"rem",
	"pow",
	"sqrt",
	"sum",
	"dot",
	"cmp",
	"runBulk",
	"runBulkAsync",
] as const;

function isJsiAtom(value: unknown): value is JsiAtom {
	return (
		typeof value === "object" &&
		value !== null &&
		METHODS.every((name) => typeof Reflect.get(value, name) === "function")
	);
}

/**
 * NativeAtom, by React Native's own lookup (TurboModuleRegistry's): the
 * TurboModule proxy, then `nativeModuleProxy` — the only one a bridgeless
 * app (the default since 0.76) installs.
 */
function lookup(): JsiAtom | undefined {
	const proxy: unknown = Reflect.get(globalThis, "__turboModuleProxy");
	if (typeof proxy === "function") {
		const module: unknown = Reflect.apply(proxy, undefined, ["NativeAtom"]);
		if (isJsiAtom(module)) return module;
	}
	const modules: unknown = Reflect.get(globalThis, "nativeModuleProxy");
	if (typeof modules === "object" && modules !== null) {
		const module: unknown = Reflect.get(modules, "NativeAtom");
		if (isJsiAtom(module)) return module;
	}
	return undefined;
}

const jsi = lookup();

const native: NativeAtom | undefined =
	jsi === undefined
		? undefined
		: {
				add: (a, b) => jsi.add(a, b),
				sub: (a, b) => jsi.sub(a, b),
				mul: (a, b) => jsi.mul(a, b),
				div: (a, b, precision, mode) => jsi.div(a, b, precision, mode),
				rem: (a, b) => jsi.rem(a, b),
				pow: (a, exp, precision, mode) => jsi.pow(a, exp, precision, mode),
				sqrt: (a, precision) => jsi.sqrt(a, precision),
				sum: (values) => jsi.sum(values),
				dot: (a, b) => jsi.dot(a, b),
				cmp: (a, b) => jsi.cmp(a, b),
				runBulk: (values, rows, program) => [
					...jsi.runBulk(values, rows, program),
				],
			};

const nativeAsync: NativeAtomAsync | undefined =
	jsi === undefined
		? undefined
		: {
				runBulk: async (values, rows, program) => [
					...(await jsi.runBulkAsync(values, rows, program)),
				],
			};

/** Whether the native engine (the JSI module) is linked into the app. */
export function isNativeAvailable(): boolean {
	if (overrideNative === null) return false;
	if (overrideNative !== undefined) return true;
	return native !== undefined;
}

export function nativeAtom(): NativeAtom {
	if (overrideNative !== undefined) {
		if (overrideNative === null) {
			throw new Error(
				"[ATOM_NAPI_DISABLED] Native engine is disabled (test override)",
			);
		}
		return overrideNative;
	}
	if (!native) {
		throw new Error(
			"[ATOM_ENGINE_NOT_FOUND] Decimal engine not available.\n" +
				"  Environment: React Native\n" +
				"  Reason: the NativeAtom JSI module is not linked into the app\n" +
				"  Fix: build the app with `ream android:*`, which links it from atom's reamNative",
		);
	}
	return native;
}

export function tryNativeAtom(): NativeAtom | undefined {
	if (overrideNative !== undefined) {
		return overrideNative ?? undefined;
	}
	return native;
}

export function tryNativeAtomAsync(): NativeAtomAsync | undefined {
	if (overrideNative !== undefined) return undefined;
	return nativeAsync;
}

let overrideNative: NativeAtom | null | undefined;

export function __overrideNativeForTesting(
	impl: NativeAtom | null | undefined,
): void {
	overrideNative = impl;
}
