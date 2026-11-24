/**
 * Universal engine loader — auto-detects Node (NAPI) vs Browser (WASM).
 *
 * - **Node**: loads the prebuilt `.node` binary via `createRequire` (sync, fast):
 *   the local build at the package root first (`pnpm build:napi` in a
 *   checkout), then the platform package `@c9up/atom-<suffix>` that an install
 *   of atom carries as an optional dependency
 * - **Browser**: loads the `.wasm` binary via the wasm-bindgen JS glue (async init on
 *   first module import via top-level await, then sync function calls)
 *
 * The Decimal facade prefers this engine when available and falls back to the
 * pure TypeScript BigInt implementation when unavailable.
 */

import { E_ATOM_ENGINE_NOT_FOUND, E_ATOM_NAPI_DISABLED } from "./errors.js";

/**
 * The engine's surface, as the Rust declares it.
 *
 * Derived from `./native/generated.js` — written by `pnpm build:napi-types`
 * from napi-derive's own `type-def` output — rather than restated here, where
 * nothing would notice a `pub fn` gaining a parameter or changing its return.
 *
 * The WASM build is held to the same shape below, so the two engines cannot
 * quietly diverge either: the browser glue has to export what the Rust does.
 */
export type NativeAtom = typeof import("./native/generated.js");

/**
 * The npm name the platform packages derive from: `@c9up/atom-<suffix>`, one
 * per target, each an optional dependency pinned to this version.
 */
const PACKAGE_NAME = "@c9up/atom";

let native: NativeAtom | undefined;
let loadError: unknown;
/** What to do about a missing Node engine, once the load has been tried. */
let nodeFix = "cd packages/atom && pnpm build:napi";

const isNode =
	typeof globalThis.process !== "undefined" &&
	typeof globalThis.process.versions?.node === "string";

/** Whether `cause` is Node's "no such module" (and not a module that failed to load). */
function isModuleNotFound(cause: unknown): boolean {
	return (
		cause instanceof Error && Reflect.get(cause, "code") === "MODULE_NOT_FOUND"
	);
}

if (isNode) {
	// Node path: load NAPI binary (sync).
	try {
		const { createRequire } = await import("node:module");
		const { dirname, join } = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const { arch, platform } = await import("node:process");

		const nodeRequire = createRequire(import.meta.url);
		const currentDir = dirname(fileURLToPath(import.meta.url));

		const platformMap: Record<string, string> = {
			"linux-x64": "linux-x64-gnu",
			"linux-arm64": "linux-arm64-gnu",
			"darwin-x64": "darwin-x64",
			"darwin-arm64": "darwin-arm64",
			"win32-x64": "win32-x64-msvc",
		};

		const suffix = platformMap[`${platform}-${arch}`];
		if (suffix === undefined) {
			nodeFix = `no prebuilt binary for ${platform}-${arch}; atom ships one for ${Object.keys(platformMap).join(", ")}.`;
		} else {
			try {
				native = nodeRequire(join(currentDir, `../index.${suffix}.node`));
			} catch (local) {
				// A local build that exists but fails to load is a broken build,
				// reported as is rather than papered over by the package.
				if (!isModuleNotFound(local)) {
					nodeFix = `index.${suffix}.node failed to load. Rebuild it: cd packages/atom && pnpm build:napi`;
					throw local;
				}
				const platformPackage = `${PACKAGE_NAME}-${suffix}`;
				nodeFix =
					`install ${platformPackage} at the exact version of ${PACKAGE_NAME}: it is the optional dependency that carries the ${suffix} binary, ` +
					"and an install that omits optional dependencies skips it. " +
					"In a checkout of atom, build it instead: pnpm build:napi.";
				native = nodeRequire(platformPackage);
			}
		}
	} catch (e) {
		loadError = e;
	}
} else {
	// Browser path: load WASM (async init, then sync calls).
	try {
		const wasm: { default: () => Promise<unknown> } & NativeAtom = await import(
			"../wasm/atom_engine_wasm.js"
		);
		await wasm.default();
		native = wasm;
	} catch (e) {
		loadError = e;
	}
}

/** Whether the native engine (NAPI or WASM) loaded successfully. */
export function isNativeAvailable(): boolean {
	if (overrideNative === null) return false;
	if (overrideNative !== undefined) return true;
	return native !== undefined;
}

export function nativeAtom(): NativeAtom {
	if (overrideNative !== undefined) {
		if (overrideNative === null) {
			throw new E_ATOM_NAPI_DISABLED();
		}
		return overrideNative;
	}
	if (!native) {
		// The load error names paths on the host: it travels as the `cause`.
		throw new E_ATOM_ENGINE_NOT_FOUND(
			[
				`Decimal engine not available.\n` +
					`  Environment: ${isNode ? "Node" : "Browser"}\n` +
					(isNode
						? `  Fix: ${nodeFix}`
						: "  Fix: cd packages/atom && pnpm build:wasm"),
			],
			{ cause: loadError },
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

/**
 * The engine's asynchronous variants, computed off the JS thread. Only the
 * phone's JSI module has them (native.rn.ts); N-API and WASM do not.
 */
export interface NativeAtomAsync {
	runBulk(
		values: BigInt64Array,
		rows: number,
		program: Int32Array,
	): Promise<string[]>;
}

export function tryNativeAtomAsync(): NativeAtomAsync | undefined {
	return undefined;
}

// Test override (unchanged from before)
let overrideNative: NativeAtom | null | undefined;

export function __overrideNativeForTesting(
	impl: NativeAtom | null | undefined,
): void {
	overrideNative = impl;
}
