/**
 * Bulk — plan a computation in JavaScript, execute it in one crossing.
 *
 * The cost of arithmetic through N-API is not the arithmetic. A crossing costs
 * about 200 ns whatever it carries, and a `Vec<String>` argument costs the same
 * again for every element in it, so a caller that walks a schedule one
 * operation at a time spends nearly all of its time on the boundary. Bulk
 * crosses once: the values go over as a typed array, which is a pointer rather
 * than a walk, and the operations go over beside them as bytecode.
 *
 * What that buys, measured on a 360-row schedule of six operations each: 0.012 ms
 * against 0.806 ms for one native call per operation, and 2.363 ms for the same
 * work through {@link Decimal}.
 *
 * What it does not buy is worth saying as plainly. Below roughly three
 * operations per element, a plain loop over a `BigInt64Array` beats anything
 * that crosses at all. Bulk is for chains of dependent operations — a schedule,
 * a rate solver, a statistic over a column — and not for a lone sum.
 *
 * @example
 *   const { net, biggest } = Atom.bulk((b) => {
 *     const gross = b.column(quantities).times(b.column(prices))
 *     return { net: gross.sum().minus(gross.sum().times('0.0025')), biggest: gross.max() }
 *   })
 */

import { defaultPrecision } from "./context.js";
import { Decimal, type DecimalInput } from "./Decimal.js";
import type { ParsedDecimal } from "./math.js";
import {
	addTs,
	cmpTs,
	divTs,
	formatDecimal,
	mulTs,
	parseDecimal,
	powTs,
	sqrtTs,
	subTs,
} from "./math.js";
import { tryNativeAtom } from "./native.js";

const INSTRUCTION_WIDTH = 6;
const COLUMN_REGISTERS = 16;
const SCALAR_REGISTERS = 32;

/** Kept in step with `crates/atom-engine/src/bulk.rs`. */
const Op = {
	LoadColumn: 0,
	LoadScalar: 1,
	AddColumns: 10,
	SubColumns: 11,
	MulColumns: 12,
	AddColumnScalar: 13,
	SubColumnScalar: 14,
	MulColumnScalar: 15,
	NegColumn: 16,
	AbsColumn: 17,
	SortColumn: 18,
	SumColumn: 20,
	MinColumn: 21,
	MaxColumn: 22,
	Dot: 23,
	SumSquaredDeviations: 24,
	AtColumn: 25,
	AddScalars: 30,
	SubScalars: 31,
	MulScalars: 32,
	DivScalars: 33,
	NegScalar: 34,
	AbsScalar: 35,
	MinScalars: 36,
	MaxScalars: 37,
	PowScalar: 38,
	SqrtScalar: 39,
	Emit: 40,
} as const;

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

/**
 * One planned operation.
 *
 * The graph this forms is the program. It is compiled to bytecode for the Rust
 * engine, and it is also what the TypeScript executor walks directly — so the
 * two executors share a description rather than each holding an opinion.
 */
interface PlanNode {
	readonly shape: "column" | "scalar";
	readonly code: number;
	readonly inputs: readonly PlanNode[];
	readonly imm0: number;
	/**
	 * Present only on loads: the values this node puts into the buffer, in the
	 * one form both executors can start from.
	 *
	 * Parsed once, when the load is made. Keeping the original strings beside
	 * this was how it worked first, and it cost twice: every value was
	 * normalised on the way in and parsed again while laying out the buffer.
	 * It also left two descriptions of one column free to disagree.
	 */
	readonly parsed?: readonly ParsedDecimal[];
	/**
	 * Compiler scratch: which compilation last touched this node, and the
	 * position it was given in that one. Kept on the node because the
	 * alternative — a `Map` keyed by node — was measured as the whole remaining
	 * cost of compiling a long chain.
	 */
	stamp: number;
	slot: number;
}

/** Distinguishes one compilation's marks from the last one's. */
let compilation = 0;

/** Reads the node behind a public handle. Only this module may. */
let nodeOf: (value: BulkValue) => PlanNode;

/**
 * A value that has been planned but not computed.
 *
 * It carries {@link Decimal}'s method names, deliberately: moving a hot path
 * into bulk should be a change of where the value comes from and nothing else.
 */
abstract class BulkValue {
	readonly #node: PlanNode;

	protected constructor(node: PlanNode) {
		this.#node = node;
	}

	static {
		nodeOf = (value: BulkValue) => value.#node;
	}

	/**
	 * Refused on purpose.
	 *
	 * Without this, `` `${total}` `` yields "[object Object]" and `total + 1`
	 * yields a string — silently, inside a financial calculation. A planned
	 * value has no string form until it has been run.
	 */
	toString(): never {
		throw new Error(
			"[ATOM_BULK_NOT_RUN] This value has been planned, not computed. Pass it to run() to get a Decimal.",
		);
	}

	/** Refused for the same reason as {@link toString}. */
	valueOf(): never {
		throw new Error(
			"[ATOM_BULK_NOT_RUN] This value has been planned, not computed. Pass it to run() to get a Decimal.",
		);
	}

	toJSON(): never {
		return this.toString();
	}
}

function scalar(
	code: number,
	inputs: readonly PlanNode[],
	imm0 = 0,
): BulkScalar {
	return new BulkScalar({
		shape: "scalar",
		code,
		inputs,
		imm0,
		stamp: 0,
		slot: -1,
	});
}

function column(
	code: number,
	inputs: readonly PlanNode[],
	imm0 = 0,
): BulkColumn {
	return new BulkColumn({
		shape: "column",
		code,
		inputs,
		imm0,
		stamp: 0,
		slot: -1,
	});
}

/** Options accepted wherever a planned division happens. */
export interface BulkDivOptions {
	precision?: number;
}

/** Options for {@link BulkColumn.stddev}. */
export interface BulkStddevOptions extends BulkDivOptions {
	sample?: boolean;
}

/** A single planned value. */
export class BulkScalar extends BulkValue {
	constructor(node: PlanNode) {
		super(node);
	}

	plus(other: BulkScalar): BulkScalar {
		return scalar(Op.AddScalars, [nodeOf(this), nodeOf(other)]);
	}

	minus(other: BulkScalar): BulkScalar {
		return scalar(Op.SubScalars, [nodeOf(this), nodeOf(other)]);
	}

	times(other: BulkScalar): BulkScalar {
		return scalar(Op.MulScalars, [nodeOf(this), nodeOf(other)]);
	}

	div(other: BulkScalar, options: BulkDivOptions = {}): BulkScalar {
		return scalar(
			Op.DivScalars,
			[nodeOf(this), nodeOf(other)],
			options.precision ?? defaultPrecision(),
		);
	}

	neg(): BulkScalar {
		return scalar(Op.NegScalar, [nodeOf(this)]);
	}

	abs(): BulkScalar {
		return scalar(Op.AbsScalar, [nodeOf(this)]);
	}

	min(other: BulkScalar): BulkScalar {
		return scalar(Op.MinScalars, [nodeOf(this), nodeOf(other)]);
	}

	max(other: BulkScalar): BulkScalar {
		return scalar(Op.MaxScalars, [nodeOf(this), nodeOf(other)]);
	}

	/**
	 * `this ** exp` for a whole `exp`.
	 *
	 * A non-negative exponent is exact — scale accumulates and nothing is
	 * dropped. A negative exponent has to divide, so it follows the same
	 * truncate-toward-zero contract as {@link div} at `precision` digits.
	 */
	pow(exp: number, options: BulkDivOptions = {}): BulkScalar {
		if (!Number.isSafeInteger(exp)) {
			throw new Error(`[ATOM_BULK_BAD_EXPONENT] Not a whole exponent: ${exp}`);
		}
		if (exp >= 0) {
			return scalar(Op.PowScalar, [nodeOf(this)], exp);
		}
		// A negative exponent has to divide, so it is compiled as one: the
		// engine's power opcode stays exact by refusing to round.
		const precision = options.precision ?? defaultPrecision();
		return literalScalar("1").div(scalar(Op.PowScalar, [nodeOf(this)], -exp), {
			precision,
		});
	}

	sqrt(options: BulkDivOptions = {}): BulkScalar {
		return scalar(
			Op.SqrtScalar,
			[nodeOf(this)],
			options.precision ?? defaultPrecision(),
		);
	}
}

/** A planned column of values, all of one length. */
export class BulkColumn extends BulkValue {
	constructor(node: PlanNode) {
		super(node);
	}

	plus(other: BulkColumn | BulkScalar): BulkColumn {
		return other instanceof BulkColumn
			? column(Op.AddColumns, [nodeOf(this), nodeOf(other)])
			: column(Op.AddColumnScalar, [nodeOf(this), nodeOf(other)]);
	}

	minus(other: BulkColumn | BulkScalar): BulkColumn {
		return other instanceof BulkColumn
			? column(Op.SubColumns, [nodeOf(this), nodeOf(other)])
			: column(Op.SubColumnScalar, [nodeOf(this), nodeOf(other)]);
	}

	times(other: BulkColumn | BulkScalar): BulkColumn {
		return other instanceof BulkColumn
			? column(Op.MulColumns, [nodeOf(this), nodeOf(other)])
			: column(Op.MulColumnScalar, [nodeOf(this), nodeOf(other)]);
	}

	neg(): BulkColumn {
		return column(Op.NegColumn, [nodeOf(this)]);
	}

	abs(): BulkColumn {
		return column(Op.AbsColumn, [nodeOf(this)]);
	}

	sorted(): BulkColumn {
		return column(Op.SortColumn, [nodeOf(this)]);
	}

	sum(): BulkScalar {
		return scalar(Op.SumColumn, [nodeOf(this)]);
	}

	min(): BulkScalar {
		return scalar(Op.MinColumn, [nodeOf(this)]);
	}

	max(): BulkScalar {
		return scalar(Op.MaxColumn, [nodeOf(this)]);
	}

	/**
	 * `Σ aᵢ·bᵢ` in one pass.
	 *
	 * Fused rather than composed from {@link times} and {@link sum}: the
	 * products are never materialised, which measured about four times faster
	 * than allocating the intermediate column.
	 */
	dot(other: BulkColumn): BulkScalar {
		return scalar(Op.Dot, [nodeOf(this), nodeOf(other)]);
	}

	at(index: number): BulkScalar {
		// Checked here rather than left to the engine: the length is known while
		// the plan is being written, and the two executors would otherwise
		// refuse the same mistake with two different messages.
		const length = this.#length();
		if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
			throw new Error(
				`[ATOM_BULK_BAD_INDEX] Index ${index} is outside a column of ${length}`,
			);
		}
		return scalar(Op.AtColumn, [nodeOf(this)], index);
	}

	avg(options: BulkDivOptions = {}): BulkScalar {
		return this.sum().div(literalScalar(String(this.#length())), options);
	}

	median(options: BulkDivOptions = {}): BulkScalar {
		const length = this.#length();
		const sorted = this.sorted();
		const middle = Math.floor(length / 2);
		if (length % 2 === 1) return sorted.at(middle);
		return sorted
			.at(middle - 1)
			.plus(sorted.at(middle))
			.div(literalScalar("2"), options);
	}

	/**
	 * The value below which `fraction` of the column falls, by nearest rank.
	 */
	percentile(fraction: number): BulkScalar {
		if (!(fraction >= 0 && fraction <= 1)) {
			throw new Error(
				`[ATOM_BULK_BAD_PERCENTILE] Expected a fraction between 0 and 1, got ${fraction}`,
			);
		}
		const length = this.#length();
		const rank = Math.min(length - 1, Math.ceil(fraction * length) - 1);
		return this.sorted().at(Math.max(0, rank));
	}

	stddev(options: BulkStddevOptions = {}): BulkScalar {
		const length = this.#length();
		const divisor = options.sample === true ? length - 1 : length;
		if (divisor <= 0) {
			throw new Error(
				"[ATOM_BULK_TOO_SHORT] A sample standard deviation needs at least two values",
			);
		}
		const precision = options.precision ?? defaultPrecision();
		const mean = this.avg({ precision: precision + 8 });
		const squares = scalar(Op.SumSquaredDeviations, [
			nodeOf(this),
			nodeOf(mean),
		]);
		const variance = squares.div(literalScalar(String(divisor)), {
			precision: precision + 8,
		});
		return variance.sqrt({ precision });
	}

	/** Every column in one program shares a length; loads carry it. */
	#length(): number {
		const seen = (node: PlanNode): number => {
			if (node.parsed !== undefined) return node.parsed.length;
			for (const input of node.inputs) {
				if (input.shape === "column") return seen(input);
			}
			throw new Error("[ATOM_BULK_NO_LENGTH] A column with no source");
		};
		return seen(nodeOf(this));
	}
}

/**
 * A value on its way into a column, in the one form the plan keeps.
 *
 * A whole number skips the decimal machinery entirely: routing it through a
 * `Decimal` and back out as a string, only to parse that string again, made an
 * integer column twice as expensive as the same column written as text — the
 * opposite of what a caller holding integers has any reason to expect.
 */
function parseInput(value: DecimalInput): ParsedDecimal {
	if (typeof value === "bigint") return { int: value, scale: 0 };
	if (typeof value === "number" && Number.isSafeInteger(value)) {
		return { int: BigInt(value), scale: 0 };
	}
	if (typeof value === "string") return parseDecimal(value);
	return parseDecimal(Decimal.from(value).toString());
}

/** A whole number, however it was written. */
function toInteger(value: string | number | bigint): bigint {
	if (typeof value === "bigint") return value;
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value)) {
			throw new Error(
				`[ATOM_BULK_NOT_MINOR_UNITS] Minor units must be whole and exact, got ${value}`,
			);
		}
		return BigInt(value);
	}
	const parsed = parseDecimal(value);
	if (parsed.scale !== 0) {
		throw new Error(
			`[ATOM_BULK_NOT_MINOR_UNITS] Minor units must be whole, got ${value}`,
		);
	}
	return parsed.int;
}

function literalScalar(value: string): BulkScalar {
	return new BulkScalar({
		shape: "scalar",
		code: Op.LoadScalar,
		inputs: [],
		imm0: 0,
		parsed: [parseDecimal(value)],
		stamp: 0,
		slot: -1,
	});
}

/**
 * A planned computation.
 *
 * Holds the values it was given as a typed array and the operations as a graph.
 * Nothing is computed until {@link run}, and a `Bulk` can be run more than once:
 * the buffer is built once and re-passed, which costs nothing, because handing a
 * typed array across the boundary is a pointer rather than a walk.
 */
export class Bulk {
	readonly #columns: ParsedDecimal[][] = [];
	#rows: number | undefined;

	/**
	 * Take a column of values into the plan.
	 *
	 * Every column in one plan has to be the same length: a program over columns
	 * of different lengths is a caller's bug, and computing over the shorter one
	 * would return a plausible figure for data nobody has.
	 */
	column(values: Iterable<DecimalInput>): BulkColumn {
		return this.#load([...values].map(parseInput));
	}

	/**
	 * Take a column that is already held as minor units.
	 *
	 * The counterpart of {@link Decimal.fromMinorUnits}, and the fast lane into
	 * a plan: `minorUnits([1234n, 99n], 2)` is 12.34 and 0.99. An integer needs
	 * no parsing and no normalising, so a column of them reaches the engine at
	 * about a sixteenth of what the same column costs as decimal strings —
	 * which is the shape money is usually stored in anyway.
	 */
	minorUnits(
		values: Iterable<string | number | bigint>,
		scale: number,
	): BulkColumn {
		// Mirrors Decimal's own bound, which is not exported.
		if (!Number.isInteger(scale) || scale < 0 || scale > 10_000) {
			throw new Error(`[ATOM_BULK_BAD_SCALE] Invalid scale: ${scale}`);
		}
		return this.#load(
			[...values].map((value) => ({ int: toInteger(value), scale })),
		);
	}

	#load(parsed: ParsedDecimal[]): BulkColumn {
		if (this.#rows === undefined) {
			this.#rows = parsed.length;
		} else if (this.#rows !== parsed.length) {
			throw new Error(
				`[ATOM_BULK_LENGTH_MISMATCH] This plan holds columns of ${this.#rows} values; got ${parsed.length}`,
			);
		}
		if (parsed.length === 0) {
			throw new Error("[ATOM_BULK_EMPTY_COLUMN] A column needs a value");
		}
		this.#columns.push(parsed);
		return new BulkColumn({
			shape: "column",
			code: Op.LoadColumn,
			inputs: [],
			imm0: 0,
			parsed,
			stamp: 0,
			slot: -1,
		});
	}

	/** Take a single value into the plan. */
	of(value: DecimalInput): BulkScalar {
		return literalScalar(Decimal.from(value).toString());
	}

	/**
	 * Compute the requested values.
	 *
	 * Runs on the Rust engine when one is loaded and every value fits its 128-bit
	 * working width; otherwise, and on an overflow reported mid-run, the same
	 * plan is evaluated on the BigInt executor, which has no ceiling. The fast
	 * path is allowed to be too narrow. It is never allowed to be wrong.
	 */
	run<T extends Readonly<Record<string, BulkScalar>>>(
		outputs: T,
	): { [K in keyof T]: Decimal } {
		const keys = Object.keys(outputs);
		if (keys.length === 0) {
			throw new Error("[ATOM_BULK_NO_OUTPUT] run() needs a value to compute");
		}
		const roots = keys.map((key) => {
			const value = outputs[key];
			if (!(value instanceof BulkScalar)) {
				throw new Error(
					`[ATOM_BULK_BAD_OUTPUT] "${key}" is not a planned value`,
				);
			}
			return nodeOf(value);
		});

		const results = this.#execute(roots);
		const out: Record<string, Decimal> = {};
		keys.forEach((key, index) => {
			const value = results[index];
			if (value === undefined) {
				throw new Error("[ATOM_BULK_LOST_OUTPUT] The run lost a value");
			}
			out[key] = new Decimal(value);
		});
		return out as { [K in keyof T]: Decimal };
	}

	#execute(roots: readonly PlanNode[]): string[] {
		const native = tryNativeAtom();
		if (native !== undefined) {
			// A plan with no column has no rows, and is still a plan: a chain of
			// scalar steps is what bulk is best at, so it must not be the one
			// shape that never crosses.
			const rows = this.#rows ?? 0;
			const compiled = compile(roots, rows);
			if (compiled !== undefined) {
				try {
					return native.runBulk(compiled.values, rows, compiled.program);
				} catch (error) {
					if (!isOverflow(error)) throw error;
				}
			}
		}
		return roots.map((root) => evaluateScalar(root, new Map()));
	}
}

function isOverflow(error: unknown): boolean {
	return (
		error instanceof Error && error.message.includes("[ATOM_BULK_OVERFLOW]")
	);
}

interface Compiled {
	readonly values: BigInt64Array;
	readonly program: Int32Array;
}

/**
 * Lay the plan out as a buffer and a program.
 *
 * Returns `undefined` when a value will not fit the engine's 64-bit transport
 * width, which is the signal to take the BigInt executor instead. Deciding it
 * here, before the crossing, keeps the decision cheap and keeps the engine from
 * having to guess what the caller wanted.
 *
 * This runs once per call to `run`, over every operation in the plan, so its
 * own cost is part of what bulk costs. Measured on a 2 160 step schedule, a
 * first version built on four `Map`s and a recursive walk took 1.34 ms — a
 * hundred times the engine it was feeding. Hence the shape here: one `Map` to
 * number the nodes, typed arrays for everything indexed by that number, and an
 * explicit stack, which also removes a recursion that would have overflowed on
 * a long enough chain.
 */
function compile(
	roots: readonly PlanNode[],
	rows: number,
): Compiled | undefined {
	// Topological order, iteratively: a node is emitted once every input of it
	// has been. `stamp` says whether a node was placed by THIS compilation, so
	// a plan can be compiled again without clearing anything first.
	compilation += 1;
	const mark = compilation;
	const placed = (node: PlanNode): boolean => node.stamp === mark;
	const order: PlanNode[] = [];
	const stack: PlanNode[] = [];
	for (let i = roots.length - 1; i >= 0; i--) {
		const root = roots[i];
		if (root !== undefined) stack.push(root);
	}
	while (stack.length > 0) {
		const node = stack.pop();
		if (node === undefined || placed(node)) continue;
		let ready = true;
		for (const input of node.inputs) {
			if (!placed(input)) {
				ready = false;
				break;
			}
		}
		if (ready) {
			node.stamp = mark;
			node.slot = order.length;
			order.push(node);
			continue;
		}
		stack.push(node);
		for (const input of node.inputs) {
			if (!placed(input)) stack.push(input);
		}
	}

	// How many times each result is still needed. A register goes back on the
	// free list the moment its last reader has been emitted.
	const remaining = new Int32Array(order.length);
	for (const node of order) {
		for (const input of node.inputs) {
			remaining[input.slot] = (remaining[input.slot] ?? 0) + 1;
		}
	}
	for (const root of roots) {
		remaining[root.slot] = (remaining[root.slot] ?? 0) + 1;
	}

	// Columns first and contiguous, literals after: the engine addresses a
	// column by its ordinal and a literal by its absolute index.
	const columnLoads: PlanNode[] = [];
	const scalarLoads: PlanNode[] = [];
	for (const node of order) {
		if (node.parsed === undefined) continue;
		if (node.code === Op.LoadColumn) columnLoads.push(node);
		else if (node.code === Op.LoadScalar) scalarLoads.push(node);
	}

	const addresses = new Int32Array(order.length);
	const loadScales = new Int32Array(order.length);
	const buffer = new BigInt64Array(
		columnLoads.length * rows + scalarLoads.length,
	);
	let cursor = 0;
	for (const load of columnLoads) {
		const next = fill(load, buffer, cursor, addresses, loadScales);
		if (next === undefined) return undefined;
		// A column is addressed by its ordinal, not by its offset.
		addresses[load.slot] = cursor / rows;
		cursor = next;
	}
	for (const load of scalarLoads) {
		const next = fill(load, buffer, cursor, addresses, loadScales);
		if (next === undefined) return undefined;
		cursor = next;
	}

	const program = new Int32Array(
		(order.length + roots.length) * INSTRUCTION_WIDTH,
	);
	const columnRegisters = new FreeList(COLUMN_REGISTERS);
	const scalarRegisters = new FreeList(SCALAR_REGISTERS);
	const assigned = new Int32Array(order.length);
	let write = 0;

	for (let position = 0; position < order.length; position += 1) {
		const node = order[position];
		if (node === undefined) return undefined;
		const first = node.inputs[0];
		const second = node.inputs[1];
		const firstSlot = first === undefined ? -1 : first.slot;
		const secondSlot = second === undefined ? -1 : second.slot;
		const a = firstSlot < 0 ? 0 : assigned[firstSlot];
		const b = secondSlot < 0 ? 0 : assigned[secondSlot];

		// Inputs are read before the destination is written, so a register this
		// instruction frees can be the one it writes to.
		if (firstSlot >= 0)
			release(
				firstSlot,
				order,
				remaining,
				assigned,
				columnRegisters,
				scalarRegisters,
			);
		if (secondSlot >= 0)
			release(
				secondSlot,
				order,
				remaining,
				assigned,
				columnRegisters,
				scalarRegisters,
			);

		const list = node.shape === "column" ? columnRegisters : scalarRegisters;
		const destination = list.take();
		if (destination === undefined) return undefined;
		assigned[position] = destination;

		const isLoad = node.code === Op.LoadColumn || node.code === Op.LoadScalar;
		program[write] = node.code;
		program[write + 1] = destination;
		program[write + 2] = isLoad ? (addresses[position] ?? 0) : (a ?? 0);
		program[write + 3] = isLoad ? 0 : (b ?? 0);
		program[write + 4] = isLoad ? (loadScales[position] ?? 0) : node.imm0;
		program[write + 5] = 0;
		write += INSTRUCTION_WIDTH;
	}

	for (const root of roots) {
		program[write] = Op.Emit;
		program[write + 2] = assigned[root.slot] ?? 0;
		write += INSTRUCTION_WIDTH;
	}

	return { values: buffer, program };
}

/**
 * Put one load's values into the buffer at their common scale.
 *
 * The scale factor is computed per distinct scale rather than per value: a
 * `10n ** BigInt(n)` for every element of a large column is most of what
 * laying out the buffer costs.
 */
function fill(
	load: PlanNode,
	buffer: BigInt64Array,
	start: number,
	addresses: Int32Array,
	scales: Int32Array,
): number | undefined {
	const parsed = load.parsed ?? [];
	let scale = 0;
	for (const value of parsed) scale = Math.max(scale, value.scale);
	scales[load.slot] = scale;
	addresses[load.slot] = start;

	let cursor = start;

	// A column whose values all share one scale — every column out of
	// `minorUnits`, and most out of a database — needs no lifting at all. Worth
	// the branch: the general path costs a map lookup and a bigint multiply on
	// every value, to multiply by one.
	let uniform = true;
	for (const value of parsed) {
		if (value.scale !== scale) {
			uniform = false;
			break;
		}
	}
	if (uniform) {
		for (const value of parsed) {
			if (value.int < I64_MIN || value.int > I64_MAX) return undefined;
			buffer[cursor] = value.int;
			cursor += 1;
		}
		return cursor;
	}

	const factors = new Map<number, bigint>();
	for (const value of parsed) {
		const shift = scale - value.scale;
		let factor = factors.get(shift);
		if (factor === undefined) {
			factor = 10n ** BigInt(shift);
			factors.set(shift, factor);
		}
		const lifted = value.int * factor;
		if (lifted < I64_MIN || lifted > I64_MAX) return undefined;
		buffer[cursor] = lifted;
		cursor += 1;
	}
	return cursor;
}

function release(
	slot: number,
	order: readonly PlanNode[],
	remaining: Int32Array,
	assigned: Int32Array,
	columns: FreeList,
	scalars: FreeList,
): void {
	const left = (remaining[slot] ?? 0) - 1;
	remaining[slot] = left;
	if (left > 0) return;
	const node = order[slot];
	const register = assigned[slot];
	if (node === undefined || register === undefined) return;
	(node.shape === "column" ? columns : scalars).give(register);
}

/** Hands out registers and takes them back. Order does not matter, so it is a stack. */
class FreeList {
	readonly #free: number[];

	constructor(size: number) {
		this.#free = Array.from({ length: size }, (_, position) => position);
	}

	take(): number | undefined {
		return this.#free.pop();
	}

	give(register: number): void {
		this.#free.push(register);
	}
}

/**
 * The BigInt executor.
 *
 * Walks the same graph the compiler lays out, using the same helpers
 * {@link Decimal} uses, so the two executors agree by sharing their arithmetic
 * rather than by each restating it. It has no width limit, which is what makes
 * it the answer to an overflow rather than a second opinion.
 */
function evaluateScalar(node: PlanNode, memo: Map<PlanNode, unknown>): string {
	const cached = memo.get(node);
	if (typeof cached === "string") return cached;
	const value = computeScalar(node, memo);
	memo.set(node, value);
	return value;
}

function evaluateColumn(
	node: PlanNode,
	memo: Map<PlanNode, unknown>,
): string[] {
	const cached = memo.get(node);
	if (Array.isArray(cached)) return cached;
	const value = computeColumn(node, memo);
	memo.set(node, value);
	return value;
}

function computeScalar(node: PlanNode, memo: Map<PlanNode, unknown>): string {
	const scalarAt = (index: number): string => {
		const input = node.inputs[index];
		if (input === undefined) {
			throw new Error("[ATOM_BULK_BAD_PROGRAM] A missing operand");
		}
		return evaluateScalar(input, memo);
	};
	const columnAt = (index: number): string[] => {
		const input = node.inputs[index];
		if (input === undefined) {
			throw new Error("[ATOM_BULK_BAD_PROGRAM] A missing operand");
		}
		return evaluateColumn(input, memo);
	};

	switch (node.code) {
		case Op.LoadScalar: {
			const value = node.parsed?.[0];
			if (value === undefined) {
				throw new Error("[ATOM_BULK_BAD_PROGRAM] A load with no value");
			}
			return formatDecimal(value.int, value.scale);
		}
		case Op.AddScalars:
			return addTs(scalarAt(0), scalarAt(1));
		case Op.SubScalars:
			return subTs(scalarAt(0), scalarAt(1));
		case Op.MulScalars:
			return mulTs(scalarAt(0), scalarAt(1));
		case Op.DivScalars:
			return divTs(scalarAt(0), scalarAt(1), node.imm0);
		case Op.NegScalar:
			return subTs("0", scalarAt(0));
		case Op.AbsScalar: {
			const value = scalarAt(0);
			return cmpTs(value, "0") < 0 ? subTs("0", value) : value;
		}
		case Op.MinScalars: {
			const [left, right] = [scalarAt(0), scalarAt(1)];
			return cmpTs(left, right) <= 0 ? left : right;
		}
		case Op.MaxScalars: {
			const [left, right] = [scalarAt(0), scalarAt(1)];
			return cmpTs(left, right) >= 0 ? left : right;
		}
		case Op.PowScalar:
			return powTs(scalarAt(0), node.imm0, 0);
		case Op.SqrtScalar:
			return sqrtTs(scalarAt(0), node.imm0);
		case Op.SumColumn:
			return columnAt(0).reduce((total, value) => addTs(total, value), "0");
		case Op.MinColumn:
			return columnAt(0).reduce((best, value) =>
				cmpTs(value, best) < 0 ? value : best,
			);
		case Op.MaxColumn:
			return columnAt(0).reduce((best, value) =>
				cmpTs(value, best) > 0 ? value : best,
			);
		case Op.Dot: {
			const [left, right] = [columnAt(0), columnAt(1)];
			return left.reduce(
				(total, value, index) =>
					addTs(total, mulTs(value, right[index] ?? "0")),
				"0",
			);
		}
		case Op.SumSquaredDeviations: {
			const values = columnAt(0);
			const mean = scalarAt(1);
			return values.reduce((total, value) => {
				const deviation = subTs(value, mean);
				return addTs(total, mulTs(deviation, deviation));
			}, "0");
		}
		case Op.AtColumn: {
			const value = columnAt(0)[node.imm0];
			if (value === undefined) {
				throw new Error(
					`[ATOM_BULK_BAD_INDEX] Index ${node.imm0} is outside the column`,
				);
			}
			return value;
		}
		default:
			throw new Error(
				`[ATOM_BULK_BAD_PROGRAM] Opcode ${node.code} does not produce a value`,
			);
	}
}

function computeColumn(node: PlanNode, memo: Map<PlanNode, unknown>): string[] {
	const columnAt = (index: number): string[] => {
		const input = node.inputs[index];
		if (input === undefined) {
			throw new Error("[ATOM_BULK_BAD_PROGRAM] A missing operand");
		}
		return evaluateColumn(input, memo);
	};
	const scalarAt = (index: number): string => {
		const input = node.inputs[index];
		if (input === undefined) {
			throw new Error("[ATOM_BULK_BAD_PROGRAM] A missing operand");
		}
		return evaluateScalar(input, memo);
	};

	switch (node.code) {
		case Op.LoadColumn:
			// Rendered here rather than kept alongside: this executor is the
			// path not taken, and a column of strings nobody reads is a column
			// of strings nobody should have built.
			return (node.parsed ?? []).map((value) =>
				formatDecimal(value.int, value.scale),
			);
		case Op.AddColumns: {
			const right = columnAt(1);
			return columnAt(0).map((value, index) =>
				addTs(value, right[index] ?? "0"),
			);
		}
		case Op.SubColumns: {
			const right = columnAt(1);
			return columnAt(0).map((value, index) =>
				subTs(value, right[index] ?? "0"),
			);
		}
		case Op.MulColumns: {
			const right = columnAt(1);
			return columnAt(0).map((value, index) =>
				mulTs(value, right[index] ?? "0"),
			);
		}
		case Op.AddColumnScalar: {
			const other = scalarAt(1);
			return columnAt(0).map((value) => addTs(value, other));
		}
		case Op.SubColumnScalar: {
			const other = scalarAt(1);
			return columnAt(0).map((value) => subTs(value, other));
		}
		case Op.MulColumnScalar: {
			const other = scalarAt(1);
			return columnAt(0).map((value) => mulTs(value, other));
		}
		case Op.NegColumn:
			return columnAt(0).map((value) => subTs("0", value));
		case Op.AbsColumn:
			return columnAt(0).map((value) =>
				cmpTs(value, "0") < 0 ? subTs("0", value) : value,
			);
		case Op.SortColumn:
			return [...columnAt(0)].sort((a, b) => cmpTs(a, b));
		default:
			throw new Error(
				`[ATOM_BULK_BAD_PROGRAM] Opcode ${node.code} does not produce a column`,
			);
	}
}

/**
 * Plan a computation and run it.
 *
 * The callback form runs once and hands back the results. Call it without a
 * callback to keep the plan and run it more than once — the values are taken in
 * once and re-passed at no cost.
 */
export function bulk<T extends Readonly<Record<string, BulkScalar>>>(
	build: (b: Bulk) => T,
): { [K in keyof T]: Decimal };
export function bulk(): Bulk;
export function bulk<T extends Readonly<Record<string, BulkScalar>>>(
	build?: (b: Bulk) => T,
): Bulk | { [K in keyof T]: Decimal } {
	const plan = new Bulk();
	if (build === undefined) return plan;
	return plan.run(build(plan));
}
