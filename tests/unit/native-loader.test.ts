/**
 * Where atom finds its Node engine: the local build first, then the platform
 * package `@c9up/atom-<suffix>` that an install of atom carries.
 *
 * `require` is replaced by a stand-in that records every id asked for, so each
 * case runs on any host and never touches a real binary.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const HOST = { platform: "linux", arch: "x64", suffix: "linux-x64-gnu" };
const PLATFORM_PACKAGE = `@c9up/atom-${HOST.suffix}`;

/** What `require` throws for a module that is not there. */
function notFound(id: string): Error {
	return Object.assign(new Error(`Cannot find module '${id}'`), {
		code: "MODULE_NOT_FOUND",
	});
}

/** A stand-in engine, told apart from any other by identity. */
const standIn = { add: () => "0" };

/** Import atom's loader with `require` running `load` for every id it asks for. */
async function withRequire(
	load: (id: string) => unknown,
	host: { platform: string; arch: string } = HOST,
) {
	vi.resetModules();
	vi.doMock("node:process", async (importOriginal) => ({
		...(await importOriginal<typeof import("node:process")>()),
		platform: host.platform,
		arch: host.arch,
	}));
	vi.doMock("node:module", async (importOriginal) => ({
		...(await importOriginal<typeof import("node:module")>()),
		createRequire: () => load,
	}));
	return import("../../src/native.js");
}

/** What `nativeAtom()` throws, or `undefined` when it returns. */
function refusalOf(native: typeof import("../../src/native.js")): unknown {
	try {
		native.nativeAtom();
		return undefined;
	} catch (error) {
		return error;
	}
}

afterEach(() => {
	vi.doUnmock("node:process");
	vi.doUnmock("node:module");
	vi.resetModules();
});

describe("atom > the Node engine comes from the local build or the platform package", () => {
	it("prefers the local build, and never asks for the package then", async () => {
		const asked: string[] = [];
		const native = await withRequire((id) => {
			asked.push(id);
			return standIn;
		});

		expect(native.tryNativeAtom()).toBe(standIn);
		expect(asked).toHaveLength(1);
		expect(asked[0]).toMatch(/[\\/]index\.linux-x64-gnu\.node$/);
	});

	it("loads the platform package when no local binary is built", async () => {
		const asked: string[] = [];
		const native = await withRequire((id) => {
			asked.push(id);
			if (id === PLATFORM_PACKAGE) return standIn;
			throw notFound(id);
		});

		expect(native.tryNativeAtom()).toBe(standIn);
		expect(native.isNativeAvailable()).toBe(true);
		expect(asked).toHaveLength(2);
		expect(asked[1]).toBe(PLATFORM_PACKAGE);
	});

	it("names the platform package to install when neither is there, with the load error as the cause", async () => {
		const native = await withRequire((id) => {
			throw notFound(id);
		});

		expect(native.isNativeAvailable()).toBe(false);
		const refusal = refusalOf(native);
		expect(refusal).toMatchObject({
			code: "E_ATOM_ENGINE_NOT_FOUND",
			cause: { code: "MODULE_NOT_FOUND" },
		});
		expect(String(refusal)).toContain(
			`Fix: install ${PLATFORM_PACKAGE} at the exact version of @c9up/atom`,
		);
		expect(String(refusal)).toContain("pnpm build:napi");
		expect(String(refusal)).not.toContain("Cannot find module");
	});

	it("reports a local build that fails to load, instead of falling back to the package", async () => {
		const asked: string[] = [];
		const native = await withRequire((id) => {
			asked.push(id);
			throw new Error("invalid ELF header");
		});

		const refusal = refusalOf(native);
		expect(asked).toHaveLength(1);
		expect(String(refusal)).toContain(
			"Fix: index.linux-x64-gnu.node failed to load. Rebuild it",
		);
		expect(refusal).toMatchObject({
			cause: { message: "invalid ELF header" },
		});
	});

	it("lists the supported targets on a host no binary is built for", async () => {
		const asked: string[] = [];
		const native = await withRequire(
			(id) => {
				asked.push(id);
				return standIn;
			},
			{ platform: "linux", arch: "riscv64" },
		);

		const refusal = refusalOf(native);
		expect(asked).toHaveLength(0);
		expect(String(refusal)).toContain(
			"Fix: no prebuilt binary for linux-riscv64; atom ships one for linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64.",
		);
		expect(refusal).toMatchObject({ cause: undefined });
	});
});
