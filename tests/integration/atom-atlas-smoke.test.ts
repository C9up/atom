/**
 * Cross-package smoke test — Story 35.10.
 *
 * Wires the REAL `decimalAtlasAdapter` from `@c9up/atom/atlas` into a REAL
 * `BaseRepository` from `@c9up/atlas` via the Adonis-style
 * `@Column({ prepare, consume })` decorator pattern, and drives an
 * end-to-end INSERT → SELECT → UPDATE → SELECT round-trip. No global
 * registry, no boot-time wiring — the adapter is baked into the entity
 * class definition itself.
 *
 * Mirrors the layout of `tests/integration/atom-rosetta-smoke.test.ts`
 * (Story 35.8) — `@c9up/atlas` is a workspace devDep added strictly for
 * this smoke test, never imported from atom's `src/`.
 */
import {
	BaseEntity,
	BaseRepository,
	Column,
	Entity,
	PrimaryKey,
	setAtlasDialect,
} from "@c9up/atlas";
import { beforeEach, describe, expect, it } from "vitest";
import { decimalAtlasAdapter } from "../../src/atlas.js";
import { Decimal } from "../../src/Decimal.js";

@Entity("accounts")
class Account extends BaseEntity {
	@PrimaryKey() id!: number;
	@Column(decimalAtlasAdapter) balance!: Decimal | null;
	@Column() label!: string;
}

function syncSqliteMock() {
	type Row = Record<string, unknown>;
	const tables = new Map<string, Map<unknown, Row>>();
	const captured: { sql: string; params: unknown[] }[] = [];

	const tableOf = (sql: string): string | null => {
		const m = sql.match(/(?:INTO|FROM|UPDATE)\s+"(\w+)"/i);
		return m ? m[1] : null;
	};
	const whereCol = (sql: string): string | null => {
		const m = sql.match(/WHERE\s+"(\w+)"/i);
		return m ? m[1] : null;
	};

	// Audit 2026-05-22 F1: BaseRepository's contract is the
	// `DatabaseConnection { execute, query }` interface — async, with
	// `query` returning rows (sqlite/postgres `INSERT ... RETURNING`
	// path) and `execute` returning `{rowsAffected}` (MySQL path). The
	// previous shape of this mock exposed only the better-sqlite3-style
	// `prepare(sql).{run,get,all}` and let BaseRepository crash with
	// `this[#db].query is not a function` on every `repo.create()` that
	// went through the RETURNING branch. The `execute`/`query` adapter
	// below is the canonical mapping between the two shapes — extract
	// it here so the rest of the mock can stay in better-sqlite3 style.
	const conn = {
		async execute(
			sql: string,
			params?: unknown[],
		): Promise<{ rowsAffected: number }> {
			const stmt = mock.prepare(sql);
			const r = stmt.run(...(params ?? []));
			return { rowsAffected: r.changes ?? 0 };
		},
		async query<T = Row>(sql: string, params?: unknown[]): Promise<T[]> {
			const stmt = mock.prepare(sql);
			return stmt.all(...(params ?? [])) as T[];
		},
	};

	const mock = {
		captured,
		tables,
		// `DatabaseConnection`-compatible surface for BaseRepository.
		execute: conn.execute,
		query: conn.query,
		prepare(sql: string) {
			return {
				run: (...params: unknown[]) => {
					captured.push({ sql, params });
					const table = tableOf(sql);
					if (!table) return { changes: 0, lastInsertRowid: 0 };
					if (!tables.has(table)) tables.set(table, new Map());
					const t = tables.get(table) as Map<unknown, Row>;

					if (/^\s*INSERT/i.test(sql)) {
						const colMatch = sql.match(/\(([^)]+)\)\s*VALUES/i);
						if (!colMatch) return { changes: 0, lastInsertRowid: 0 };
						const cols = colMatch[1]
							.split(",")
							.map((c) => c.trim().replace(/"/g, ""));
						const row: Row = {};
						cols.forEach((c, i) => {
							row[c] = params[i];
						});
						const id = row.id;
						t.set(id, row);
						return {
							changes: 1,
							lastInsertRowid: typeof id === "number" ? id : 1,
						};
					}
					if (/^\s*UPDATE/i.test(sql)) {
						const setMatch = sql.match(/SET\s+(.+?)\s+WHERE/i);
						if (!setMatch) return { changes: 0, lastInsertRowid: 0 };
						const setCols = setMatch[1].split(",").map((s) =>
							s
								.trim()
								.split(/\s*=\s*/)[0]
								.replace(/"/g, ""),
						);
						const whereVal = params[params.length - 1];
						const row = t.get(whereVal);
						if (row) {
							setCols.forEach((c, i) => {
								row[c] = params[i];
							});
							return { changes: 1, lastInsertRowid: 0 };
						}
					}
					return { changes: 0, lastInsertRowid: 0 };
				},
				get: (...params: unknown[]) => {
					captured.push({ sql, params });
					const table = tableOf(sql);
					if (!table) return undefined;
					const t = tables.get(table);
					if (!t) return undefined;
					const wcol = whereCol(sql);
					if (!wcol) return [...t.values()][0];
					for (const row of t.values()) {
						if (row[wcol] === params[0]) return row;
					}
					return undefined;
				},
				all: (...params: unknown[]) => {
					captured.push({ sql, params });
					const table = tableOf(sql);
					if (!table) return [];
					if (!tables.has(table)) tables.set(table, new Map());
					const t = tables.get(table) as Map<unknown, Row>;
					// sqlite/postgres call `.all()` for `INSERT ... RETURNING`.
					// Mirror the side-effect of `.run()` so the repository sees
					// the freshly-written row and rehydrates auto-id / defaults.
					if (/^\s*INSERT/i.test(sql)) {
						const colMatch = sql.match(/\(([^)]+)\)\s*VALUES/i);
						if (!colMatch) return [];
						const cols = colMatch[1]
							.split(",")
							.map((c) => c.trim().replace(/"/g, ""));
						const row: Row = {};
						cols.forEach((c, i) => {
							row[c] = params[i];
						});
						const id = row.id ?? t.size + 1;
						t.set(id, row);
						return [row];
					}
					const wcol = whereCol(sql);
					if (!wcol) return [...t.values()];
					return [...t.values()].filter((r) => r[wcol] === params[0]);
				},
			};
		},
	};
	return mock;
}

describe("Atom + Atlas smoke (Decimal column via @Column(prepare/consume))", () => {
	let db: ReturnType<typeof syncSqliteMock>;

	beforeEach(() => {
		setAtlasDialect("sqlite");
		db = syncSqliteMock();
	});

	it("preserves an 18-digit Decimal across INSERT → SELECT", async () => {
		const repo = new BaseRepository(Account, db);
		await repo.create({
			id: 1,
			balance: new Decimal("1234567890123456.789"),
			label: "big",
		});

		const insert = db.captured.find((c) => /^\s*INSERT/i.test(c.sql));
		expect(insert?.params).toContain("1234567890123456.789");
		for (const p of insert?.params ?? []) {
			expect(p).not.toBeInstanceOf(Decimal);
		}

		const found = await repo.find(1);
		expect(found).not.toBeNull();
		expect(found?.balance).toBeInstanceOf(Decimal);
		expect(found?.balance?.toString()).toBe("1234567890123456.789");
	});

	it("null balance round-trips via the consume callback", async () => {
		const repo = new BaseRepository(Account, db);
		await repo.create({ id: 2, balance: null, label: "empty" });
		const found = await repo.find(2);
		expect(found?.balance).toBeNull();
	});

	it("UPDATE binds the lossless string and re-SELECT lands as Decimal", async () => {
		const repo = new BaseRepository(Account, db);
		await repo.create({
			id: 3,
			balance: new Decimal("1.0"),
			label: "starting",
		});

		const entity = await repo.find(3);
		if (!entity) throw new Error("precondition: row must exist");
		entity.balance = new Decimal("999999999999999.99");
		await repo.save(entity);

		const update = db.captured.find((c) => /^\s*UPDATE/i.test(c.sql));
		expect(update?.params).toContain("999999999999999.99");
		for (const p of update?.params ?? []) {
			expect(p).not.toBeInstanceOf(Decimal);
		}

		const stored = db.tables.get("accounts")?.get(3);
		expect(stored?.balance).toBe("999999999999999.99");

		const refreshed = await repo.find(3);
		expect(refreshed?.balance).toBeInstanceOf(Decimal);
		expect(refreshed?.balance?.toString()).toBe("999999999999999.99");
	});

	it("Adonis-style spread: @Column(decimalAtlasAdapter) is structurally accepted", () => {
		// Compile-time: the spread above on the Account class did not error.
		// Runtime: the adapter shape is { prepare, consume } and TypeScript's
		// structural compatibility carries the contract across packages.
		expect(typeof decimalAtlasAdapter.prepare).toBe("function");
		expect(typeof decimalAtlasAdapter.consume).toBe("function");
	});
});
