import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";
import type { UnsafeObject } from "react-native/Libraries/Types/CodegenTypes";

/**
 * atom's Rust engine over JSI (android/src/main/cpp/NativeAtom.cpp): the
 * N-API binding's functions, plus `runBulkAsync`: a bulk program computed on
 * a worker thread, so the JS thread stays free (atom's `bulk.runAsync`).
 *
 * `runBulk` takes its typed arrays (BigInt64Array, Int32Array) as objects:
 * codegen has no typed-array type (`UnsafeObject` is its untyped object), and
 * the module reads their memory in place.
 */
export interface Spec extends TurboModule {
	readonly add: (a: string, b: string) => string;
	readonly sub: (a: string, b: string) => string;
	readonly mul: (a: string, b: string) => string;
	readonly div: (
		a: string,
		b: string,
		precision: number,
		mode: string,
	) => string;
	readonly rem: (a: string, b: string) => string;
	readonly pow: (
		a: string,
		exp: number,
		precision: number,
		mode: string,
	) => string;
	readonly sqrt: (a: string, precision: number) => string;
	readonly sum: (values: ReadonlyArray<string>) => string;
	readonly dot: (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => string;
	readonly cmp: (a: string, b: string) => number;
	readonly runBulk: (
		values: UnsafeObject,
		rows: number,
		program: UnsafeObject,
	) => ReadonlyArray<string>;
	readonly runBulkAsync: (
		values: UnsafeObject,
		rows: number,
		program: UnsafeObject,
	) => Promise<ReadonlyArray<string>>;
}

export default TurboModuleRegistry.getEnforcing<Spec>("NativeAtom");
