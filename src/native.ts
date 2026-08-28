/**
 * Universal engine loader — auto-detects Node (NAPI) vs Browser (WASM).
 *
 * - **Node**: loads the prebuilt `.node` binary via `createRequire` (sync, fast)
 * - **Browser**: loads the `.wasm` binary via the wasm-pack JS glue (async init on
 *   first module import via top-level await, then sync function calls)
 *
 * The Decimal facade prefers this engine when available and falls back to the
 * pure TypeScript BigInt implementation when unavailable.
 */

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

let native: NativeAtom | undefined;
let loadError: unknown;

const isNode =
	typeof globalThis.process !== "undefined" &&
	typeof globalThis.process.versions?.node === "string";

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
		if (suffix) {
			native = nodeRequire(join(currentDir, `../index.${suffix}.node`));
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
			throw new Error(
				"[ATOM_NAPI_DISABLED] Native engine is disabled (test override)",
			);
		}
		return overrideNative;
	}
	if (!native) {
		throw new Error(
			`[ATOM_ENGINE_NOT_FOUND] Decimal engine not available.\n` +
				`  Environment: ${isNode ? "Node" : "Browser"}\n` +
				`  Reason: ${loadError ?? "binary not found"}\n` +
				`  Fix (Node): cd packages/atom && pnpm build:napi\n` +
				`  Fix (Browser): cd packages/atom && pnpm build:wasm`,
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

// Test override (unchanged from before)
let overrideNative: NativeAtom | null | undefined;

export function __overrideNativeForTesting(
	impl: NativeAtom | null | undefined,
): void {
	overrideNative = impl;
}
