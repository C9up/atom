/**
 * Atom's errors, one per code: `E_ATOM_` for decimals, money and the Atlas
 * adapter, `E_ATOM_BULK_` for the bulk planner. The Rust engine and the
 * TypeScript one raise the same errors (see `engineErrors.ts`), so a caller
 * branches on `error.code` or on `error instanceof errors.E_ATOM_*` whichever
 * engine ran.
 *
 * A message too irregular for one template takes `%s`, with the text built
 * where the error is thrown.
 */

import { createError } from "@c9up/flare";

/** A value of a type no decimal can be built from. */
export const E_ATOM_INVALID_INPUT = createError<[message: string]>(
	"%s",
	"E_ATOM_INVALID_INPUT",
);

/** A failure atom does not expect: an engine panic, a lost value. */
export const E_ATOM_INTERNAL = createError<[message: string]>(
	"%s",
	"E_ATOM_INTERNAL",
);

/** Two batches of different lengths where pairs were expected. */
export const E_ATOM_LENGTH_MISMATCH = createError<
	[left: number, right: number]
>("Mismatched batch lengths: %d and %d", "E_ATOM_LENGTH_MISMATCH");

/** A `clamp` or `between` range whose minimum is above its maximum. */
export const E_ATOM_INVALID_RANGE = createError<[operation: string]>(
	"Invalid %s range: min is greater than max",
	"E_ATOM_INVALID_RANGE",
);

/** A `quantize` step that is zero or negative. */
export const E_ATOM_INVALID_STEP = createError(
	"Quantize step must be greater than zero",
	"E_ATOM_INVALID_STEP",
);

/** A conversion to minor units that would drop digits. */
export const E_ATOM_PRECISION_LOSS = createError<
	[value: string, scale: number]
>(
	"Cannot convert %s to minor units at scale %d without precision loss",
	"E_ATOM_PRECISION_LOSS",
);

/** `allocate` ratios that cannot split anything. */
export const E_ATOM_INVALID_RATIOS = createError<[message: string]>(
	"%s",
	"E_ATOM_INVALID_RATIOS",
);

/** A string that is not a decimal, plain or localized. */
export const E_ATOM_INVALID_DECIMAL = createError<[message: string]>(
	"%s",
	"E_ATOM_INVALID_DECIMAL",
);

/** A JavaScript number past `Number.MAX_SAFE_INTEGER`, which is no longer exact. */
export const E_ATOM_UNSAFE_INTEGER = createError<[message: string]>(
	"%s",
	"E_ATOM_UNSAFE_INTEGER",
);

/** Minor units that are not an integer. */
export const E_ATOM_INVALID_INTEGER = createError<[value: unknown]>(
	"Invalid integer: %s",
	"E_ATOM_INVALID_INTEGER",
);

/** A scale or a precision that is not a whole number within bounds. */
export const E_ATOM_INVALID_SCALE = createError<[scale: unknown]>(
	"Invalid scale: %s",
	"E_ATOM_INVALID_SCALE",
);

/** A `pow` exponent that is not a whole number within bounds. */
export const E_ATOM_INVALID_EXPONENT = createError<[exponent: unknown]>(
	"Invalid exponent: %s",
	"E_ATOM_INVALID_EXPONENT",
);

/** A rounding mode atom does not know. */
export const E_ATOM_INVALID_ROUNDING_MODE = createError<[mode: string]>(
	"Unknown rounding mode: %s",
	"E_ATOM_INVALID_ROUNDING_MODE",
);

/**
 * A value or a result past the bound of significant digits: the configured
 * one (`configureAtomContext({ maxDigits })`), or the Rust engine's own; or a
 * scientific literal whose exponent is past `maxExponent`.
 */
export const E_ATOM_DECIMAL_TOO_LARGE = createError<[message: string]>(
	"%s",
	"E_ATOM_DECIMAL_TOO_LARGE",
);

/** A division or a remainder by zero. */
export const E_ATOM_DIVISION_BY_ZERO = createError(
	"Division by zero",
	"E_ATOM_DIVISION_BY_ZERO",
);

/** The square root of a negative value. */
export const E_ATOM_NEGATIVE_SQRT = createError(
	"Cannot compute sqrt of a negative decimal",
	"E_ATOM_NEGATIVE_SQRT",
);

/** Two amounts of different currencies, or scales, in one operation. */
export const E_ATOM_CURRENCY_MISMATCH = createError<
	[currency: string, scale: number, otherCurrency: string, otherScale: number]
>("Currency mismatch: %s/%d !== %s/%d", "E_ATOM_CURRENCY_MISMATCH");

/** A currency code that is not three letters. */
export const E_ATOM_INVALID_CURRENCY = createError<[currency: string]>(
	"Invalid currency code: %s",
	"E_ATOM_INVALID_CURRENCY",
);

/** A context setting (rounding mode, precision, digit bound) that is not one. */
export const E_ATOM_INVALID_CONTEXT = createError<
	[setting: string, value: unknown]
>("Invalid Atom context %s: %s", "E_ATOM_INVALID_CONTEXT");

/** An aggregate over no value. */
export const E_ATOM_EMPTY_INPUT = createError<[aggregate: string]>(
	"Atom.%s requires at least one value",
	"E_ATOM_EMPTY_INPUT",
);

/** A sample standard deviation over fewer than two values. */
export const E_ATOM_TOO_FEW_VALUES = createError(
	"Atom.stddev sample mode requires at least two values",
	"E_ATOM_TOO_FEW_VALUES",
);

/** The engine was switched off by a test override and asked for anyway. */
export const E_ATOM_NAPI_DISABLED = createError(
	"Native engine is disabled (test override)",
	"E_ATOM_NAPI_DISABLED",
);

/** No engine loaded where one was required; the message says how to build it. */
export const E_ATOM_ENGINE_NOT_FOUND = createError<[message: string]>(
	"%s",
	"E_ATOM_ENGINE_NOT_FOUND",
);

/** The Atlas adapter received a column value of a type it cannot store or read. */
export const E_ATOM_INVALID_COLUMN_VALUE = createError<[message: string]>(
	"%s",
	"E_ATOM_INVALID_COLUMN_VALUE",
);

/** A non-nullable decimal column received `null`. */
export const E_ATOM_NULL_COLUMN_VALUE = createError<[operation: string]>(
	"decimalColumn.%s: non-nullable column got null",
	"E_ATOM_NULL_COLUMN_VALUE",
);

/** `run()` was given something other than a value planned on this `Bulk`. */
export const E_ATOM_BULK_BAD_OUTPUT = createError<[message: string]>(
	"%s",
	"E_ATOM_BULK_BAD_OUTPUT",
);

/** A planned value read as a decimal before `run()` computed it. */
export const E_ATOM_BULK_NOT_RUN = createError(
	"This value has been planned, not computed. Pass it to run() to get a Decimal.",
	"E_ATOM_BULK_NOT_RUN",
);

/** A bulk precision that is not a whole number within bounds. */
export const E_ATOM_BULK_BAD_PRECISION = createError<
	[max: number, precision: unknown]
>(
	"Expected a whole precision between 0 and %d, got %s",
	"E_ATOM_BULK_BAD_PRECISION",
);

/** A compiled bulk program the executor cannot run: a planner bug. */
export const E_ATOM_BULK_BAD_PROGRAM = createError<[message: string]>(
	"%s",
	"E_ATOM_BULK_BAD_PROGRAM",
);

/** A bulk exponent that is not a whole number within bounds. */
export const E_ATOM_BULK_BAD_EXPONENT = createError<
	[max: number, exponent: unknown]
>(
	"Expected a whole exponent of at most %d either way, got %s",
	"E_ATOM_BULK_BAD_EXPONENT",
);

/** An index outside a column. */
export const E_ATOM_BULK_BAD_INDEX = createError<[message: string]>(
	"%s",
	"E_ATOM_BULK_BAD_INDEX",
);

/** A percentile that is not a fraction between 0 and 1. */
export const E_ATOM_BULK_BAD_PERCENTILE = createError<[fraction: unknown]>(
	"Expected a fraction between 0 and 1, got %s",
	"E_ATOM_BULK_BAD_PERCENTILE",
);

/** A sample standard deviation over a column of fewer than two values. */
export const E_ATOM_BULK_TOO_SHORT = createError(
	"A sample standard deviation needs at least two values",
	"E_ATOM_BULK_TOO_SHORT",
);

/** A column with no source to take its length from. */
export const E_ATOM_BULK_NO_LENGTH = createError(
	"A column with no source",
	"E_ATOM_BULK_NO_LENGTH",
);

/** Minor units that are not whole, or not exact. */
export const E_ATOM_BULK_NOT_MINOR_UNITS = createError<[message: string]>(
	"%s",
	"E_ATOM_BULK_NOT_MINOR_UNITS",
);

/** A column scale that is not a whole number within bounds. */
export const E_ATOM_BULK_BAD_SCALE = createError<[scale: unknown]>(
	"Invalid scale: %s",
	"E_ATOM_BULK_BAD_SCALE",
);

/** A column whose length differs from the plan's. */
export const E_ATOM_BULK_LENGTH_MISMATCH = createError<
	[rows: number, length: number]
>(
	"This plan holds columns of %d values; got %d",
	"E_ATOM_BULK_LENGTH_MISMATCH",
);

/**
 * A planned value that reads a column another `Bulk` loaded. Each plan lays
 * out only its own columns, at its own length, so the two executors would
 * answer a mixed plan with two different wrong figures.
 */
export const E_ATOM_BULK_FOREIGN_COLUMN = createError(
	"A planned value reads a column of another plan; load the column on the plan that runs it",
	"E_ATOM_BULK_FOREIGN_COLUMN",
);

/** A column with no value. */
export const E_ATOM_BULK_EMPTY_COLUMN = createError(
	"A column needs a value",
	"E_ATOM_BULK_EMPTY_COLUMN",
);

/** `run()` with nothing to compute. */
export const E_ATOM_BULK_NO_OUTPUT = createError(
	"run() needs a value to compute",
	"E_ATOM_BULK_NO_OUTPUT",
);

/** A run that came back without one of the values it was asked for. */
export const E_ATOM_BULK_LOST_OUTPUT = createError(
	"The run lost a value",
	"E_ATOM_BULK_LOST_OUTPUT",
);
