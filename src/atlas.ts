/**
 * `@c9up/atom/atlas` — Atlas column-type adapter for {@link Decimal}.
 *
 * Wires `Atom.Decimal` into Atlas's `@Column({ prepare, consume })` opt-in
 * column pipeline. Lives on a sub-export so the default `@c9up/atom` import
 * surface stays adapter-free.
 *
 * The callbacks are baked into the entity definition: no global registry, no
 * boot-time wiring, nothing to import in a provider.
 *
 * Usage:
 *
 *     import { Column, Entity, BaseEntity, PrimaryKey } from '@c9up/atlas'
 *     import { decimalAtlasAdapter } from '@c9up/atom/atlas'
 *
 *     @Entity('accounts')
 *     class Account extends BaseEntity {
 *       @PrimaryKey() id!: number
 *       @Column(decimalAtlasAdapter) balance!: Decimal | null
 *     }
 */

import { Decimal, type RoundMode } from "./Decimal.js";

export interface DecimalColumnOptions {
	scale?: number;
	exact?: boolean;
	mode?: RoundMode;
	nullable?: boolean;
	columnType?: "decimal" | "numeric";
}

export interface DecimalAtlasAdapter {
	consume(raw: unknown): Decimal | null;
	prepare(value: unknown): string | null;
}

export interface DecimalAtlasColumn extends DecimalAtlasAdapter {
	meta: {
		atomDecimal: true;
		columnType: "decimal" | "numeric";
		scale?: number;
		nullable: boolean;
	};
}

/**
 * Atlas adapter for postgres `numeric` / `decimal` (and equivalent on mysql /
 * sqlite) columns. `consume` lifts string/number/bigint DB values into a
 * {@link Decimal}; `prepare` lowers a `Decimal` back to its lossless string
 * form for the SQL bind parameter.
 *
 * - `consume(null)` / `consume(undefined)` returns `null` so nullable columns
 *   keep their semantics through the adapter pipeline.
 * - `prepare(null)` / `prepare(undefined)` returns `null` symmetrically.
 * - `prepare` rejects anything that is not a `Decimal` — protects against the
 *   common "I forgot to wrap" footgun where a JS number would otherwise
 *   silently coerce via `String(x)` and lose precision.
 *
 * **Driver requirement:** configure your DB driver to return `numeric` /
 * `decimal` columns as `string` (postgres-js does this by default; mysql2
 * needs `decimalNumbers: false`; better-sqlite3 returns whatever the bound
 * type was). If the driver returns numeric values as JS `number`, precision
 * is already lost before `consume` is called — `9007199254740993` (one beyond
 * `Number.MAX_SAFE_INTEGER`) arrives as `9007199254740992` and the adapter
 * faithfully wraps the rounded value. The "lossless" round-trip claim only
 * holds when DB → driver → adapter stays in the string/bigint domain.
 *
 * The shape `{ prepare, consume }` is spreadable directly into `@Column(...)`:
 * `@Column(decimalAtlasAdapter)` is identical to
 * `@Column({ prepare: decimalAtlasAdapter.prepare, consume: decimalAtlasAdapter.consume })`.
 *
 * The exported object is `Object.freeze`d so a stray test setup file or
 * plugin cannot monkey-patch `prepare` / `consume` at runtime and silently
 * corrupt every repository sharing this import.
 */
export const decimalAtlasAdapter: DecimalAtlasAdapter = Object.freeze({
	consume(raw: unknown): Decimal | null {
		if (raw === null || raw === undefined) return null;
		if (raw instanceof Decimal) return raw;
		if (
			typeof raw === "string" ||
			typeof raw === "number" ||
			typeof raw === "bigint"
		) {
			return new Decimal(raw);
		}
		throw new TypeError(
			`decimalAtlasAdapter.consume: expected string | number | bigint | Decimal | null, got ${typeof raw}`,
		);
	},
	prepare(value: unknown): string | null {
		if (value === null || value === undefined) return null;
		if (!(value instanceof Decimal)) {
			throw new TypeError(
				`decimalAtlasAdapter.prepare: expected a Decimal instance, got ${typeof value === "object" ? Object.prototype.toString.call(value) : typeof value}. ` +
					"Wrap the value with `new Decimal(...)` before assigning to a column tagged with this adapter.",
			);
		}
		return value.toString();
	},
});

export function decimalColumn(
	options: DecimalColumnOptions = {},
): DecimalAtlasColumn {
	const columnType = options.columnType ?? "decimal";
	const nullable = options.nullable ?? true;
	const adapter: DecimalAtlasColumn = {
		meta: {
			atomDecimal: true,
			columnType,
			scale: options.scale,
			nullable,
		},
		consume(raw: unknown): Decimal | null {
			const value = decimalAtlasAdapter.consume(raw);
			if (value === null) {
				if (!nullable) {
					throw new TypeError(
						"decimalColumn.consume: non-nullable column got null",
					);
				}
				return null;
			}
			return normalizeColumnDecimal(value, options);
		},
		prepare(value: unknown): string | null {
			const prepared = decimalAtlasAdapter.prepare(value);
			if (prepared === null) {
				if (!nullable) {
					throw new TypeError(
						"decimalColumn.prepare: non-nullable column got null",
					);
				}
				return null;
			}
			return normalizeColumnDecimal(new Decimal(prepared), options).toString();
		},
	};
	return Object.freeze(adapter);
}

function normalizeColumnDecimal(
	value: Decimal,
	options: DecimalColumnOptions,
): Decimal {
	if (options.scale === undefined) return value;
	if (options.exact ?? true) {
		return Decimal.fromMinorUnits(
			value.toMinorUnits(options.scale),
			options.scale,
		);
	}
	return value.toScale(options.scale, options.mode ?? "half-up");
}
