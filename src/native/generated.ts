// GENERATED FROM THE RUST — do not edit.
//
// Produced by scripts/generate-napi-types.mjs from napi-derive's type-def
// output. Editing this file by hand puts it back where it started: a
// description that can disagree with the code it describes.

/**
 * Run a bulk program over a resident column buffer.
 *
 * `values` holds every column laid end to end, `rows` values each, followed by
 * the scalar literals the program refers to by absolute index. `program` is
 * six-word bytecode. Returns the scalars the program emitted, in order.
 *
 * An overflow of the 128-bit working width is reported with a message opening
 * `[ATOM_BULK_OVERFLOW]`, which is the caller's signal to re-run the same
 * program on the BigInt executor rather than to give up: the fast path is
 * allowed to be too narrow, never to be wrong.
 */

export declare function runBulk(
	values: BigInt64Array,
	rows: number,
	program: Int32Array,
): Array<string>;

export declare function add(a: string, b: string): string;

export declare function sub(a: string, b: string): string;

export declare function mul(a: string, b: string): string;

export declare function div(a: string, b: string, precision: number): string;

export declare function rem(a: string, b: string): string;

export declare function pow(a: string, exp: number, precision: number): string;

export declare function sqrt(a: string, precision: number): string;

/**
 * Batch addition — one crossing for the whole list.
 *
 * `Vec<String>` rather than a stream of calls, because the crossing IS the
 * cost: parsing and formatting a decimal is cheap, and doing it once per
 * pair from JavaScript is what makes a long fold expensive.
 */

export declare function sum(values: Array<string>): string;

/** Batch `Σ aᵢ·bᵢ` — the shape of every valuation, in one crossing. */

export declare function dot(a: Array<string>, b: Array<string>): string;

export declare function cmp(a: string, b: string): number;
