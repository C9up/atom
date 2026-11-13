/**
 * A panic inside the native bulk engine reaches JavaScript as a thrown
 * `Error`; it never unwinds into the N-API frame, which aborts the whole
 * process (exit 134, SIGABRT).
 *
 * The engine has no input left that panics, so the binding reads a test-only
 * switch, `ATOM_BULK_PANIC_PROBE=1`, and panics inside its guard. The call runs
 * in a child Node process loading the built `.node` binary, so the generated
 * wrapper and the process's exit are what is measured — not the Rust function
 * in isolation.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

const BINARY = readdirSync(ROOT).find((file) => /^index\..+\.node$/.test(file));

const CHILD = `
const atom = require(process.argv[1]);
const report = [];
for (let call = 0; call < 2; call++) {
	try {
		atom.runBulk(new BigInt64Array(0), 0, new Int32Array(0));
		report.push("returned");
	} catch (error) {
		report.push(error instanceof Error ? error.message : "non-error " + typeof error);
	}
}
process.stdout.write(JSON.stringify(report));
`;

function runChild(probe: boolean): {
	status: number | null;
	signal: NodeJS.Signals | null;
	report: unknown;
} {
	const env = { ...process.env };
	delete env.ATOM_BULK_PANIC_PROBE;
	if (probe) env.ATOM_BULK_PANIC_PROBE = "1";
	const child = spawnSync(
		process.execPath,
		["-e", CHILD, join(ROOT, BINARY ?? "missing.node")],
		{ env, encoding: "utf8", timeout: 15_000 },
	);
	let report: unknown;
	try {
		report = JSON.parse(child.stdout);
	} catch {
		report = { stdout: child.stdout, stderr: child.stderr };
	}
	return { status: child.status, signal: child.signal, report };
}

describe("runBulk across the N-API boundary", () => {
	it("finds the built binary", () => {
		expect(BINARY).toBeDefined();
	});

	it("turns a forced panic into a thrown Error and the process lives on", () => {
		const { status, signal, report } = runChild(true);
		expect({ status, signal }).toEqual({ status: 0, signal: null });
		expect(report).toEqual([
			"[ATOM_BULK_PANIC] Internal panic in the bulk engine",
			"[ATOM_BULK_PANIC] Internal panic in the bulk engine",
		]);
	});

	it("runs normally without the switch", () => {
		const { status, signal, report } = runChild(false);
		expect({ status, signal }).toEqual({ status: 0, signal: null });
		expect(report).toEqual(["returned", "returned"]);
	});
});
