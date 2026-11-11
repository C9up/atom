//! Bulk — a program is planned in JavaScript and executed here in one crossing.
//!
//! The reason this exists is measured, not assumed. Calling across N-API costs
//! roughly 200 ns whatever it carries, and a `Vec<String>` argument costs the
//! same again for every element it holds. A caller that walks a schedule one
//! operation at a time therefore spends almost all of its time on the boundary
//! rather than on arithmetic. A bulk program crosses once: the values go over as
//! a typed array — a pointer, no per-element cost — and the operations go over
//! as fixed-width bytecode beside them.
//!
//! Two things follow from that, and both shape what is here:
//!
//! - **Reductions are fused.** Multiplying two columns and then summing the
//!   result allocates an intermediate column nobody asked for; measured, that
//!   allocation costs about four times the arithmetic. `Dot` and `SumSqDev` do
//!   the whole reduction in one pass, which is why they exist as opcodes rather
//!   than as a pair the caller composes.
//! - **Cheap work stays in JavaScript.** Below roughly three operations per
//!   element, a plain loop over a `BigInt64Array` beats anything that crosses,
//!   and no opcode here changes that. Bulk earns its keep on chains of
//!   dependent operations — a schedule, a rate solver — not on a lone sum.
//!
//! ## Width
//!
//! Registers hold `i128`. That is wide enough for a product of two 64-bit
//! columns, which `i64` is not, and it keeps every operation a machine
//! instruction. It is not wide enough for everything: a long chain at high
//! precision will overflow it. Every arithmetic step is therefore checked, and
//! an overflow stops the run with [`BulkError::Overflow`] instead of wrapping.
//! The caller answers that by re-running the same program on the BigInt
//! executor, which has no ceiling — so the fast path is never the reason an
//! answer is wrong, only the reason it was quick.

use crate::engine::{format_decimal, RoundMode, MAX_SCALE};
use num_bigint::BigInt;
use std::cmp::Ordering;

/// Fixed instruction width, in `i32` words: `[opcode, dst, a, b, imm0, imm1]`.
///
/// Fixed rather than packed because the decoder is not the cost — a 2 160
/// instruction schedule is 52 KB of program against milliseconds of arithmetic,
/// and a uniform stride keeps the decoder branch-free.
pub const INSTRUCTION_WIDTH: usize = 6;

const COLUMN_REGISTERS: usize = 16;
const SCALAR_REGISTERS: usize = 32;

// A working scale past `MAX_SCALE` is handed to the BigInt executor, which
// applies the same bound with its own message, and it keeps `format_decimal`
// from padding millions of zeros.

/// Why a bulk run stopped.
///
/// [`BulkError::Overflow`] is the one the caller is expected to recover from,
/// by re-running on an executor with no width limit. The rest are programming
/// errors in the compiler that emitted the bytecode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BulkError {
    Overflow(&'static str),
    DivisionByZero,
    BadProgram(String),
}

impl BulkError {
    pub fn message(&self) -> String {
        match self {
            Self::Overflow(where_) => format!("bulk: value overflowed 128 bits in {where_}"),
            Self::DivisionByZero => "bulk: division by zero".to_string(),
            Self::BadProgram(why) => format!("bulk: {why}"),
        }
    }

    /// Whether re-running on the BigInt executor would help.
    pub fn is_recoverable(&self) -> bool {
        matches!(self, Self::Overflow(_))
    }
}

type Outcome<T> = Result<T, BulkError>;

// Loads
const LOAD_C: i32 = 0;
const LOAD_S: i32 = 1;
// Column -> column
const ADD_CC: i32 = 10;
const SUB_CC: i32 = 11;
const MUL_CC: i32 = 12;
const ADD_CS: i32 = 13;
const SUB_CS: i32 = 14;
const MUL_CS: i32 = 15;
const NEG_C: i32 = 16;
const ABS_C: i32 = 17;
const SORT_C: i32 = 18;
// Column -> scalar
const SUM_C: i32 = 20;
const MIN_C: i32 = 21;
const MAX_C: i32 = 22;
const DOT_CC: i32 = 23;
const SSD_CS: i32 = 24;
const AT_C: i32 = 25;
// Scalar -> scalar
const ADD_SS: i32 = 30;
const SUB_SS: i32 = 31;
const MUL_SS: i32 = 32;
const DIV_SS: i32 = 33;
const NEG_S: i32 = 34;
const ABS_S: i32 = 35;
const MIN_SS: i32 = 36;
const MAX_SS: i32 = 37;
const POW_S: i32 = 38;
const SQRT_S: i32 = 39;
// Output
const OUT_S: i32 = 40;

/// A value and the scale it is expressed at: `value * 10^-scale`.
#[derive(Clone, Copy, Default)]
struct Scalar {
    value: i128,
    scale: u32,
}

#[derive(Clone, Default)]
struct Column {
    values: Vec<i128>,
    scale: u32,
}

fn ten_pow(exp: u32) -> Outcome<i128> {
    10i128
        .checked_pow(exp)
        .ok_or(BulkError::Overflow("a scale factor"))
}

/// Raise both operands to a common scale without rounding either.
///
/// Raising rather than rounding is what keeps addition exact: every value keeps
/// every digit it arrived with.
fn align(a: Scalar, b: Scalar) -> Outcome<(i128, i128, u32)> {
    if a.scale == b.scale {
        return Ok((a.value, b.value, a.scale));
    }
    let scale = a.scale.max(b.scale);
    let lift = |s: Scalar| -> Outcome<i128> {
        s.value
            .checked_mul(ten_pow(scale - s.scale)?)
            .ok_or(BulkError::Overflow("scale alignment"))
    };
    Ok((lift(a)?, lift(b)?, scale))
}

/// The sum of two scales, or an overflow when it passes [`MAX_SCALE`].
fn add_scales(a: u32, b: u32) -> Outcome<u32> {
    a.checked_add(b)
        .filter(|scale| *scale <= MAX_SCALE)
        .ok_or(BulkError::Overflow("a scale"))
}

/// A load's scale immediate. Negative is a compiler bug; past [`MAX_SCALE`]
/// is the BigInt executor's to refuse.
fn load_scale(imm0: i32) -> Outcome<u32> {
    let scale =
        u32::try_from(imm0).map_err(|_| BulkError::BadProgram(format!("negative scale {imm0}")))?;
    if scale > MAX_SCALE {
        return Err(BulkError::Overflow("a scale"));
    }
    Ok(scale)
}

/// A division or root's rounding immediate, in the compiler's numbering.
fn mode_of(imm1: i32) -> Outcome<RoundMode> {
    match imm1 {
        0 => Ok(RoundMode::Trunc),
        1 => Ok(RoundMode::Floor),
        2 => Ok(RoundMode::Ceil),
        3 => Ok(RoundMode::HalfUp),
        4 => Ok(RoundMode::HalfEven),
        _ => Err(BulkError::BadProgram(format!(
            "unknown rounding mode {imm1}"
        ))),
    }
}

/// A division or root's precision immediate, which the compiler validates
/// against the same bound before emitting it.
fn precision_of(imm0: i32) -> Outcome<u32> {
    u32::try_from(imm0)
        .ok()
        .filter(|precision| *precision <= MAX_SCALE)
        .ok_or_else(|| BulkError::BadProgram(format!("invalid precision {imm0}")))
}

/// Integer square root, truncated toward zero; `0` for a negative value,
/// which the callers never pass.
fn isqrt(value: i128) -> i128 {
    value.checked_isqrt().unwrap_or(0)
}

/// `√source` at `precision` digits, rounded in `mode` — what `Decimal.sqrt`
/// computes, on an i128.
fn rounded_root(source: Scalar, precision: u32, mode: RoundMode) -> Outcome<i128> {
    // The radicand at scale 2p is R = v · 10^(2p − s), and ⌊√R⌋ is the
    // truncated root. Below half the operand's scale R is not whole: it is
    // floored, as engine::sqrt does — ⌊√⌊R⌋⌋ = ⌊√R⌋ — and the exact R is kept
    // for the comparisons rounding needs. Both terms are at most MAX_SCALE, so
    // the sum cannot overflow.
    let shift = precision + precision;
    let lifted = if shift >= source.scale {
        Some(
            source
                .value
                .checked_mul(ten_pow(shift - source.scale)?)
                .ok_or(BulkError::Overflow("a square root operand"))?,
        )
    } else {
        None
    };
    let floored = match lifted {
        Some(exact) => exact,
        // A divisor past 10^38 leaves nothing of an i128.
        None => ten_pow(source.scale - shift).map_or(0, |divisor| source.value / divisor),
    };
    let root = isqrt(floored);

    // How `x` compares with `times · R`, exactly.
    let against_radicand = |x: i128, times: i128| -> Outcome<Ordering> {
        match lifted {
            Some(exact) => {
                let right = exact
                    .checked_mul(times)
                    .ok_or(BulkError::Overflow("a square root comparison"))?;
                Ok(x.cmp(&right))
            }
            None => {
                // x · 10^(s − 2p) against times · v. Past i128 a positive left
                // side is certainly the larger: the right one fits.
                let right = source
                    .value
                    .checked_mul(times)
                    .ok_or(BulkError::Overflow("a square root comparison"))?;
                if x == 0 {
                    return Ok(0.cmp(&right));
                }
                Ok(ten_pow(source.scale - shift)
                    .ok()
                    .and_then(|factor| x.checked_mul(factor))
                    .map_or(Ordering::Greater, |left| left.cmp(&right)))
            }
        }
    };

    if matches!(mode, RoundMode::Trunc | RoundMode::Floor) {
        return Ok(root);
    }
    // root² ≤ ⌊R⌋ fits.
    if against_radicand(root * root, 1)? == Ordering::Equal {
        return Ok(root);
    }
    let half = if matches!(mode, RoundMode::Ceil) {
        Ordering::Greater
    } else {
        // √R against root + ½, as 4R against (2·root + 1)².
        let twice = root
            .checked_mul(2)
            .and_then(|value| value.checked_add(1))
            .and_then(|value| value.checked_mul(value))
            .ok_or(BulkError::Overflow("a square root comparison"))?;
        against_radicand(twice, 4)?.reverse()
    };
    if mode.steps_away(false, half, root % 2 != 0) {
        root.checked_add(1)
            .ok_or(BulkError::Overflow("a rounded square root"))
    } else {
        Ok(root)
    }
}

struct Machine<'a> {
    values: &'a [i64],
    rows: usize,
    columns: Vec<Column>,
    scalars: Vec<Scalar>,
    out: Vec<String>,
}

impl<'a> Machine<'a> {
    fn column(&self, index: i32) -> Outcome<&Column> {
        self.columns
            .get(index as usize)
            .filter(|_| index >= 0)
            .ok_or_else(|| BulkError::BadProgram(format!("column register {index} out of range")))
    }

    fn scalar(&self, index: i32) -> Outcome<Scalar> {
        if index < 0 {
            return Err(BulkError::BadProgram(format!(
                "scalar register {index} out of range"
            )));
        }
        self.scalars
            .get(index as usize)
            .copied()
            .ok_or_else(|| BulkError::BadProgram(format!("scalar register {index} out of range")))
    }

    fn put_column(&mut self, index: i32, column: Column) -> Outcome<()> {
        let slot = self
            .columns
            .get_mut(index as usize)
            .filter(|_| index >= 0)
            .ok_or_else(|| {
                BulkError::BadProgram(format!("column register {index} out of range"))
            })?;
        *slot = column;
        Ok(())
    }

    fn put_scalar(&mut self, index: i32, scalar: Scalar) -> Outcome<()> {
        let slot = self
            .scalars
            .get_mut(index as usize)
            .filter(|_| index >= 0)
            .ok_or_else(|| {
                BulkError::BadProgram(format!("scalar register {index} out of range"))
            })?;
        *slot = scalar;
        Ok(())
    }

    /// Elementwise over two columns, aligned to a common scale.
    fn zip(&self, a: i32, b: i32, op: fn(i128, i128) -> Option<i128>) -> Outcome<Column> {
        let left = self.column(a)?;
        let right = self.column(b)?;
        if left.values.len() != right.values.len() {
            return Err(BulkError::BadProgram(format!(
                "column lengths differ: {} and {}",
                left.values.len(),
                right.values.len()
            )));
        }
        let scale = left.scale.max(right.scale);
        let left_factor = ten_pow(scale - left.scale)?;
        let right_factor = ten_pow(scale - right.scale)?;
        let mut values = Vec::with_capacity(left.values.len());
        for (x, y) in left.values.iter().zip(right.values.iter()) {
            let x = x
                .checked_mul(left_factor)
                .ok_or(BulkError::Overflow("an elementwise operand"))?;
            let y = y
                .checked_mul(right_factor)
                .ok_or(BulkError::Overflow("an elementwise operand"))?;
            values.push(op(x, y).ok_or(BulkError::Overflow("an elementwise operation"))?);
        }
        Ok(Column { values, scale })
    }

    /// Elementwise against one scalar, aligned to a common scale.
    fn map(&self, a: i32, b: i32, op: fn(i128, i128) -> Option<i128>) -> Outcome<Column> {
        let column = self.column(a)?;
        let scalar = self.scalar(b)?;
        let scale = column.scale.max(scalar.scale);
        let column_factor = ten_pow(scale - column.scale)?;
        let lifted = scalar
            .value
            .checked_mul(ten_pow(scale - scalar.scale)?)
            .ok_or(BulkError::Overflow("scale alignment"))?;
        let mut values = Vec::with_capacity(column.values.len());
        for x in &column.values {
            let x = x
                .checked_mul(column_factor)
                .ok_or(BulkError::Overflow("an elementwise operand"))?;
            values.push(op(x, lifted).ok_or(BulkError::Overflow("an elementwise operation"))?);
        }
        Ok(Column { values, scale })
    }

    fn divide(&self, a: Scalar, b: Scalar, precision: u32, mode: RoundMode) -> Outcome<Scalar> {
        if b.value == 0 {
            return Err(BulkError::DivisionByZero);
        }
        // (a / 10^sa) / (b / 10^sb) at `precision` digits
        //   = (a * 10^(precision + sb)) / (b * 10^sa)
        let numerator = a
            .value
            .checked_mul(ten_pow(add_scales(precision, b.scale)?)?)
            .ok_or(BulkError::Overflow("a division numerator"))?;
        let denominator = b
            .value
            .checked_mul(ten_pow(a.scale)?)
            .ok_or(BulkError::Overflow("a division denominator"))?;
        // Truncated first, then moved one step away from zero when the mode
        // asks, as engine::div does. `i128::MIN / -1` is the one quotient
        // that does not fit.
        let quotient = numerator
            .checked_div(denominator)
            .ok_or(BulkError::Overflow("a quotient"))?;
        let remainder = numerator
            .checked_rem(denominator)
            .ok_or(BulkError::Overflow("a quotient"))?;
        let mut value = quotient;
        if remainder != 0 {
            let negative = (numerator < 0) != (denominator < 0);
            // 2|r| against |d|, as |r| against |d| − |r|: no doubling to overflow.
            let (rest, whole) = (remainder.unsigned_abs(), denominator.unsigned_abs());
            let half = rest.cmp(&(whole - rest));
            if mode.steps_away(negative, half, quotient % 2 != 0) {
                value = if negative {
                    quotient.checked_sub(1)
                } else {
                    quotient.checked_add(1)
                }
                .ok_or(BulkError::Overflow("a rounded quotient"))?;
            }
        }
        Ok(Scalar {
            value,
            scale: precision,
        })
    }

    /// One instruction.
    ///
    /// A fixed-size array rather than a slice: the six reads below are then
    /// bounds-check-free, and this is the loop every bulk program runs once
    /// per instruction.
    fn step(&mut self, word: &[i32; INSTRUCTION_WIDTH]) -> Outcome<()> {
        // `imm1` is the rounding mode of a division or a root; every other
        // opcode ignores it.
        let (op, dst, a, b, imm0, imm1) = (word[0], word[1], word[2], word[3], word[4], word[5]);
        match op {
            LOAD_C => {
                if a < 0 {
                    return Err(BulkError::BadProgram("negative column index".to_string()));
                }
                let offset = (a as usize)
                    .checked_mul(self.rows)
                    .ok_or_else(|| BulkError::BadProgram("column offset overflow".to_string()))?;
                let end = offset
                    .checked_add(self.rows)
                    .ok_or_else(|| BulkError::BadProgram("column offset overflow".to_string()))?;
                let slice = self
                    .values
                    .get(offset..end)
                    .ok_or_else(|| BulkError::BadProgram("column out of bounds".to_string()))?;
                self.put_column(
                    dst,
                    Column {
                        values: slice.iter().map(|v| *v as i128).collect(),
                        scale: load_scale(imm0)?,
                    },
                )
            }
            LOAD_S => {
                let value = *self
                    .values
                    .get(a as usize)
                    .filter(|_| a >= 0)
                    .ok_or_else(|| BulkError::BadProgram("scalar out of bounds".to_string()))?;
                self.put_scalar(
                    dst,
                    Scalar {
                        value: value as i128,
                        scale: load_scale(imm0)?,
                    },
                )
            }

            ADD_CC => {
                let c = self.zip(a, b, i128::checked_add)?;
                self.put_column(dst, c)
            }
            SUB_CC => {
                let c = self.zip(a, b, i128::checked_sub)?;
                self.put_column(dst, c)
            }
            MUL_CC => {
                // Products do not align: scales add, exactly.
                let left = self.column(a)?;
                let right = self.column(b)?;
                if left.values.len() != right.values.len() {
                    return Err(BulkError::BadProgram(format!(
                        "column lengths differ: {} and {}",
                        left.values.len(),
                        right.values.len()
                    )));
                }
                let scale = add_scales(left.scale, right.scale)?;
                let mut values = Vec::with_capacity(left.values.len());
                for (x, y) in left.values.iter().zip(right.values.iter()) {
                    values.push(
                        x.checked_mul(*y)
                            .ok_or(BulkError::Overflow("a column product"))?,
                    );
                }
                self.put_column(dst, Column { values, scale })
            }
            ADD_CS => {
                let c = self.map(a, b, i128::checked_add)?;
                self.put_column(dst, c)
            }
            SUB_CS => {
                let c = self.map(a, b, i128::checked_sub)?;
                self.put_column(dst, c)
            }
            MUL_CS => {
                let column = self.column(a)?;
                let scalar = self.scalar(b)?;
                let scale = add_scales(column.scale, scalar.scale)?;
                let mut values = Vec::with_capacity(column.values.len());
                for x in &column.values {
                    values.push(
                        x.checked_mul(scalar.value)
                            .ok_or(BulkError::Overflow("a column product"))?,
                    );
                }
                self.put_column(dst, Column { values, scale })
            }
            NEG_C => {
                let source = self.column(a)?;
                let column = Column {
                    values: source
                        .values
                        .iter()
                        .map(|v| v.checked_neg().ok_or(BulkError::Overflow("a negation")))
                        .collect::<Outcome<Vec<i128>>>()?,
                    scale: source.scale,
                };
                self.put_column(dst, column)
            }
            ABS_C => {
                let source = self.column(a)?;
                let column = Column {
                    values: source
                        .values
                        .iter()
                        .map(|v| {
                            v.checked_abs()
                                .ok_or(BulkError::Overflow("an absolute value"))
                        })
                        .collect::<Outcome<Vec<i128>>>()?,
                    scale: source.scale,
                };
                self.put_column(dst, column)
            }
            SORT_C => {
                let source = self.column(a)?;
                let mut values = source.values.clone();
                // Every value in a column shares one scale, so the integers
                // order exactly as the decimals do.
                values.sort_unstable();
                let scale = source.scale;
                self.put_column(dst, Column { values, scale })
            }

            SUM_C => {
                let column = self.column(a)?;
                let mut total: i128 = 0;
                for value in &column.values {
                    total = total
                        .checked_add(*value)
                        .ok_or(BulkError::Overflow("a column sum"))?;
                }
                let scale = column.scale;
                self.put_scalar(
                    dst,
                    Scalar {
                        value: total,
                        scale,
                    },
                )
            }
            MIN_C | MAX_C => {
                let column = self.column(a)?;
                let picked = if op == MIN_C {
                    column.values.iter().copied().min()
                } else {
                    column.values.iter().copied().max()
                }
                .ok_or_else(|| {
                    BulkError::BadProgram("reduction over an empty column".to_string())
                })?;
                let scale = column.scale;
                self.put_scalar(
                    dst,
                    Scalar {
                        value: picked,
                        scale,
                    },
                )
            }
            DOT_CC => {
                // Fused on purpose: the products are never materialised.
                let left = self.column(a)?;
                let right = self.column(b)?;
                if left.values.len() != right.values.len() {
                    return Err(BulkError::BadProgram(format!(
                        "column lengths differ: {} and {}",
                        left.values.len(),
                        right.values.len()
                    )));
                }
                let mut total: i128 = 0;
                for (x, y) in left.values.iter().zip(right.values.iter()) {
                    let product = x
                        .checked_mul(*y)
                        .ok_or(BulkError::Overflow("a dot product term"))?;
                    total = total
                        .checked_add(product)
                        .ok_or(BulkError::Overflow("a dot product"))?;
                }
                let scale = add_scales(left.scale, right.scale)?;
                self.put_scalar(
                    dst,
                    Scalar {
                        value: total,
                        scale,
                    },
                )
            }
            SSD_CS => {
                // Σ(xᵢ − μ)², fused: the deviations are never materialised.
                let column = self.column(a)?;
                let mean = self.scalar(b)?;
                let scale = column.scale.max(mean.scale);
                let column_factor = ten_pow(scale - column.scale)?;
                let mean_value = mean
                    .value
                    .checked_mul(ten_pow(scale - mean.scale)?)
                    .ok_or(BulkError::Overflow("scale alignment"))?;
                let mut total: i128 = 0;
                for x in &column.values {
                    let lifted = x
                        .checked_mul(column_factor)
                        .ok_or(BulkError::Overflow("a deviation operand"))?;
                    let deviation = lifted
                        .checked_sub(mean_value)
                        .ok_or(BulkError::Overflow("a deviation"))?;
                    let square = deviation
                        .checked_mul(deviation)
                        .ok_or(BulkError::Overflow("a squared deviation"))?;
                    total = total
                        .checked_add(square)
                        .ok_or(BulkError::Overflow("a sum of squared deviations"))?;
                }
                self.put_scalar(
                    dst,
                    Scalar {
                        value: total,
                        scale: add_scales(scale, scale)?,
                    },
                )
            }
            AT_C => {
                let column = self.column(a)?;
                let index = imm0 as usize;
                let value = *column
                    .values
                    .get(index)
                    .filter(|_| imm0 >= 0)
                    .ok_or_else(|| {
                        BulkError::BadProgram(format!("index {imm0} outside the column"))
                    })?;
                let scale = column.scale;
                self.put_scalar(dst, Scalar { value, scale })
            }

            ADD_SS | SUB_SS => {
                let (left, right, scale) = align(self.scalar(a)?, self.scalar(b)?)?;
                let value = if op == ADD_SS {
                    left.checked_add(right)
                } else {
                    left.checked_sub(right)
                }
                .ok_or(BulkError::Overflow("a scalar addition"))?;
                self.put_scalar(dst, Scalar { value, scale })
            }
            MUL_SS => {
                let (left, right) = (self.scalar(a)?, self.scalar(b)?);
                let value = left
                    .value
                    .checked_mul(right.value)
                    .ok_or(BulkError::Overflow("a scalar product"))?;
                let scale = add_scales(left.scale, right.scale)?;
                self.put_scalar(dst, Scalar { value, scale })
            }
            DIV_SS => {
                let quotient = self.divide(
                    self.scalar(a)?,
                    self.scalar(b)?,
                    precision_of(imm0)?,
                    mode_of(imm1)?,
                )?;
                self.put_scalar(dst, quotient)
            }
            NEG_S => {
                let s = self.scalar(a)?;
                let value = s
                    .value
                    .checked_neg()
                    .ok_or(BulkError::Overflow("a negation"))?;
                self.put_scalar(
                    dst,
                    Scalar {
                        value,
                        scale: s.scale,
                    },
                )
            }
            ABS_S => {
                let s = self.scalar(a)?;
                let value = s
                    .value
                    .checked_abs()
                    .ok_or(BulkError::Overflow("an absolute value"))?;
                self.put_scalar(
                    dst,
                    Scalar {
                        value,
                        scale: s.scale,
                    },
                )
            }
            MIN_SS | MAX_SS => {
                let (left, right, scale) = align(self.scalar(a)?, self.scalar(b)?)?;
                let value = if op == MIN_SS {
                    left.min(right)
                } else {
                    left.max(right)
                };
                self.put_scalar(dst, Scalar { value, scale })
            }
            POW_S => {
                // Non-negative exponents only: scale accumulates exactly, so
                // this stays lossless. A negative exponent is compiled as a
                // division by the positive power.
                let Ok(exponent) = u32::try_from(imm0) else {
                    return Err(BulkError::BadProgram(
                        "negative exponent must be compiled as a division".to_string(),
                    ));
                };
                let base = self.scalar(a)?;
                let scale = base
                    .scale
                    .checked_mul(exponent)
                    .filter(|scale| *scale <= MAX_SCALE)
                    .ok_or(BulkError::Overflow("a power's scale"))?;
                // Square-and-multiply, like `engine::pow`. The base is squared
                // only while bits remain, so a power that fits never fails on
                // a square it did not need.
                let mut value: i128 = 1;
                let mut square = base.value;
                let mut remaining = exponent;
                while remaining > 0 {
                    if remaining & 1 == 1 {
                        value = value
                            .checked_mul(square)
                            .ok_or(BulkError::Overflow("a power"))?;
                    }
                    remaining >>= 1;
                    if remaining > 0 {
                        square = square
                            .checked_mul(square)
                            .ok_or(BulkError::Overflow("a power"))?;
                    }
                }
                self.put_scalar(dst, Scalar { value, scale })
            }
            SQRT_S => {
                let source = self.scalar(a)?;
                if source.value < 0 {
                    return Err(BulkError::BadProgram(
                        "square root of a negative value".to_string(),
                    ));
                }
                let precision = precision_of(imm0)?;
                let mode = mode_of(imm1)?;
                let value = rounded_root(source, precision, mode)?;
                self.put_scalar(
                    dst,
                    Scalar {
                        value,
                        scale: precision,
                    },
                )
            }

            OUT_S => {
                let s = self.scalar(a)?;
                self.out
                    .push(format_decimal(BigInt::from(s.value), s.scale));
                Ok(())
            }
            _ => Err(BulkError::BadProgram(format!("unknown opcode {op}"))),
        }
    }
}

/// Execute a bulk program.
///
/// `values` holds every column laid end to end, `rows` values each, followed by
/// any scalar literals the program refers to by absolute index. `program` is
/// [`INSTRUCTION_WIDTH`]-word bytecode. The result is the emitted scalars, in
/// the order the program emitted them.
pub fn run(values: &[i64], rows: usize, program: &[i32]) -> Outcome<Vec<String>> {
    if !program.len().is_multiple_of(INSTRUCTION_WIDTH) {
        return Err(BulkError::BadProgram(format!(
            "program length {} is not a multiple of {INSTRUCTION_WIDTH}",
            program.len()
        )));
    }
    let mut machine = Machine {
        values,
        rows,
        columns: vec![Column::default(); COLUMN_REGISTERS],
        scalars: vec![Scalar::default(); SCALAR_REGISTERS],
        out: Vec::new(),
    };
    // `.0` alone: the length check above already rejected a remainder.
    for word in program.as_chunks::<INSTRUCTION_WIDTH>().0 {
        machine.step(word)?;
    }
    Ok(machine.out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::pow10;

    /// `[opcode, dst, a, b, imm0, imm1]`, flattened.
    fn program(words: &[[i32; INSTRUCTION_WIDTH]]) -> Vec<i32> {
        words.iter().flatten().copied().collect()
    }

    #[test]
    fn a_dot_product_matches_the_scalar_engine() {
        // quantities 1.50, 2.25 · prices 10.00, 4.00 = 15.0000 + 9.0000
        let values = [150i64, 225, 1000, 400];
        let out = run(
            &values,
            2,
            &program(&[
                [LOAD_C, 0, 0, 0, 2, 0],
                [LOAD_C, 1, 1, 0, 2, 0],
                [DOT_CC, 0, 0, 1, 0, 0],
                [OUT_S, 0, 0, 0, 0, 0],
            ]),
        )
        .unwrap();
        assert_eq!(out, vec!["24".to_string()]);
    }

    #[test]
    fn fusing_a_reduction_gives_what_composing_it_would() {
        let values = [150i64, 225, 1000, 400];
        let fused = run(
            &values,
            2,
            &program(&[
                [LOAD_C, 0, 0, 0, 2, 0],
                [LOAD_C, 1, 1, 0, 2, 0],
                [DOT_CC, 0, 0, 1, 0, 0],
                [OUT_S, 0, 0, 0, 0, 0],
            ]),
        )
        .unwrap();
        let composed = run(
            &values,
            2,
            &program(&[
                [LOAD_C, 0, 0, 0, 2, 0],
                [LOAD_C, 1, 1, 0, 2, 0],
                [MUL_CC, 2, 0, 1, 0, 0],
                [SUM_C, 0, 2, 0, 0, 0],
                [OUT_S, 0, 0, 0, 0, 0],
            ]),
        )
        .unwrap();
        assert_eq!(fused, composed);
    }

    #[test]
    fn addition_raises_scales_instead_of_rounding_them() {
        // 1.5 + 0.001 must be 1.501, not 1.5
        let values = [15i64, 1];
        let out = run(
            &values,
            1,
            &program(&[
                [LOAD_S, 0, 0, 0, 1, 0],
                [LOAD_S, 1, 1, 0, 3, 0],
                [ADD_SS, 2, 0, 1, 0, 0],
                [OUT_S, 0, 2, 0, 0, 0],
            ]),
        )
        .unwrap();
        assert_eq!(out, vec!["1.501".to_string()]);
    }

    #[test]
    fn division_truncates_toward_zero_like_the_scalar_engine() {
        // -1 / 3 at 5 digits → -0.33333, not -0.33334
        let values = [-1i64, 3];
        let out = run(
            &values,
            1,
            &program(&[
                [LOAD_S, 0, 0, 0, 0, 0],
                [LOAD_S, 1, 1, 0, 0, 0],
                [DIV_SS, 2, 0, 1, 5, 0],
                [OUT_S, 0, 2, 0, 0, 0],
            ]),
        )
        .unwrap();
        assert_eq!(out, vec!["-0.33333".to_string()]);
    }

    #[test]
    fn a_square_root_truncates_at_the_precision_asked_for() {
        // √2 at 6 digits
        let values = [2i64];
        let out = run(
            &values,
            1,
            &program(&[
                [LOAD_S, 0, 0, 0, 0, 0],
                [SQRT_S, 1, 0, 0, 6, 0],
                [OUT_S, 0, 1, 0, 0, 0],
            ]),
        )
        .unwrap();
        assert_eq!(out, vec!["1.414213".to_string()]);
    }

    #[test]
    fn sorting_orders_the_decimals_not_just_the_integers() {
        let values = [500i64, -25, 1000, 3];
        let out = run(
            &values,
            4,
            &program(&[
                [LOAD_C, 0, 0, 0, 2, 0],
                [SORT_C, 1, 0, 0, 0, 0],
                [AT_C, 0, 1, 0, 0, 0],
                [AT_C, 1, 1, 0, 3, 0],
                [OUT_S, 0, 0, 0, 0, 0],
                [OUT_S, 0, 1, 0, 0, 0],
            ]),
        )
        .unwrap();
        assert_eq!(out, vec!["-0.25".to_string(), "10".to_string()]);
    }

    #[test]
    fn an_overflow_is_recoverable_rather_than_wrong() {
        // i128::MAX squared cannot be represented; the run must say so instead
        // of wrapping into a plausible-looking answer.
        let values = [i64::MAX, i64::MAX];
        let error = run(
            &values,
            1,
            &program(&[
                [LOAD_S, 0, 0, 0, 0, 0],
                [MUL_SS, 1, 0, 0, 0, 0],
                [MUL_SS, 2, 1, 1, 0, 0],
                [OUT_S, 0, 2, 0, 0, 0],
            ]),
        )
        .unwrap_err();
        assert!(error.is_recoverable(), "{error:?}");
    }

    #[test]
    fn dividing_by_zero_is_not_recoverable() {
        let values = [1i64, 0];
        let error = run(
            &values,
            1,
            &program(&[
                [LOAD_S, 0, 0, 0, 0, 0],
                [LOAD_S, 1, 1, 0, 0, 0],
                [DIV_SS, 2, 0, 1, 4, 0],
                [OUT_S, 0, 2, 0, 0, 0],
            ]),
        )
        .unwrap_err();
        assert_eq!(error, BulkError::DivisionByZero);
        assert!(!error.is_recoverable());
    }

    /// Builds i128::MIN from i64 literals only: (-2^63)² = 2^126, negated and
    /// doubled. Register 3 holds it, register 1 holds 2^126.
    const MIN_PROLOGUE: [[i32; INSTRUCTION_WIDTH]; 4] = [
        [LOAD_S, 0, 0, 0, 0, 0],
        [MUL_SS, 1, 0, 0, 0, 0],
        [NEG_S, 2, 1, 0, 0, 0],
        [ADD_SS, 3, 2, 2, 0, 0],
    ];

    fn run_on_min(tail: &[[i32; INSTRUCTION_WIDTH]]) -> Outcome<Vec<String>> {
        let mut words = MIN_PROLOGUE.to_vec();
        words.extend_from_slice(tail);
        run(&[i64::MIN, -1], 1, &program(&words))
    }

    #[test]
    fn negating_the_narrowest_value_overflows_instead_of_wrapping() {
        let error = run_on_min(&[[NEG_S, 4, 3, 0, 0, 0], [OUT_S, 0, 4, 0, 0, 0]]).unwrap_err();
        assert!(error.is_recoverable(), "{error:?}");
    }

    #[test]
    fn the_absolute_value_of_the_narrowest_value_overflows_instead_of_wrapping() {
        let error = run_on_min(&[[ABS_S, 4, 3, 0, 0, 0], [OUT_S, 0, 4, 0, 0, 0]]).unwrap_err();
        assert!(error.is_recoverable(), "{error:?}");
    }

    #[test]
    fn column_negation_and_absolute_value_overflow_instead_of_wrapping() {
        // [-2^63] * -2^63 = [2^126], then 2^126 subtracted three times.
        for op in [NEG_C, ABS_C] {
            let error = run(
                &[i64::MIN, i64::MIN],
                1,
                &program(&[
                    [LOAD_C, 0, 0, 0, 0, 0],
                    [LOAD_S, 0, 1, 0, 0, 0],
                    [MUL_SS, 1, 0, 0, 0, 0],
                    [MUL_CS, 1, 0, 0, 0, 0],
                    [SUB_CS, 2, 1, 1, 0, 0],
                    [SUB_CS, 3, 2, 1, 0, 0],
                    [SUB_CS, 4, 3, 1, 0, 0],
                    [op, 5, 4, 0, 0, 0],
                    [SUM_C, 2, 5, 0, 0, 0],
                    [OUT_S, 0, 2, 0, 0, 0],
                ]),
            )
            .unwrap_err();
            assert!(error.is_recoverable(), "opcode {op}: {error:?}");
        }
    }

    #[test]
    fn dividing_the_narrowest_value_by_minus_one_overflows_instead_of_panicking() {
        let error = run_on_min(&[
            [LOAD_S, 4, 1, 0, 0, 0],
            [DIV_SS, 5, 3, 4, 0, 0],
            [OUT_S, 0, 5, 0, 0, 0],
        ])
        .unwrap_err();
        assert!(error.is_recoverable(), "{error:?}");
    }

    #[test]
    fn the_square_root_of_the_widest_value_is_exact() {
        // 2^126 + (2^126 - 1) = 2^127 - 1 = i128::MAX
        let out = run(
            &[i64::MIN, 1],
            1,
            &program(&[
                [LOAD_S, 0, 0, 0, 0, 0],
                [LOAD_S, 1, 1, 0, 0, 0],
                [MUL_SS, 2, 0, 0, 0, 0],
                [SUB_SS, 3, 2, 1, 0, 0],
                [ADD_SS, 4, 2, 3, 0, 0],
                [SQRT_S, 5, 4, 0, 0, 0],
                [OUT_S, 0, 5, 0, 0, 0],
            ]),
        )
        .unwrap();
        assert_eq!(out, vec!["13043817825332782212".to_string()]);
    }

    #[test]
    fn isqrt_is_exact_across_the_whole_range() {
        for value in [
            0i128,
            1,
            2,
            3,
            4,
            15,
            16,
            17,
            i64::MAX as i128,
            i128::MAX - 1,
            i128::MAX,
        ] {
            let root = isqrt(value);
            assert!(root * root <= value, "{value}");
            let next = root + 1;
            assert!(
                next.checked_mul(next).is_none_or(|square| square > value),
                "{value}"
            );
        }
    }

    #[test]
    fn scales_that_would_overflow_are_reported_rather_than_wrapped() {
        // Two loads at the largest scale an i32 immediate can carry: their
        // product's scale does not fit u32.
        let error = run(
            &[1, 1],
            1,
            &program(&[
                [LOAD_S, 0, 0, 0, i32::MAX, 0],
                [LOAD_S, 1, 1, 0, i32::MAX, 0],
                [MUL_SS, 2, 0, 1, 0, 0],
                [MUL_SS, 3, 2, 2, 0, 0],
                [OUT_S, 0, 3, 0, 0, 0],
            ]),
        )
        .unwrap_err();
        assert!(error.is_recoverable(), "{error:?}");
    }

    #[test]
    fn a_column_reaching_past_the_end_of_the_buffer_is_refused() {
        let error = run(&[1], usize::MAX, &program(&[[LOAD_C, 0, 1, 0, 0, 0]])).unwrap_err();
        assert!(matches!(error, BulkError::BadProgram(_)), "{error:?}");
    }

    #[test]
    fn a_power_takes_logarithmic_time_in_its_exponent() {
        // A linear loop would take seconds here; square-and-multiply takes 31
        // steps.
        let out = run(
            &[1, -1],
            1,
            &program(&[
                [LOAD_S, 0, 0, 0, 0, 0],
                [LOAD_S, 1, 1, 0, 0, 0],
                [POW_S, 2, 0, 0, i32::MAX, 0],
                [POW_S, 3, 1, 0, i32::MAX, 0],
                [OUT_S, 0, 2, 0, 0, 0],
                [OUT_S, 0, 3, 0, 0, 0],
            ]),
        )
        .unwrap();
        assert_eq!(out, vec!["1".to_string(), "-1".to_string()]);
    }

    #[test]
    fn a_power_is_exact_when_only_the_last_square_would_overflow() {
        // 3^79 fits i128, 3^128 does not: the base must not be squared past
        // the exponent's top bit.
        let out = run(
            &[3],
            1,
            &program(&[
                [LOAD_S, 0, 0, 0, 0, 0],
                [POW_S, 1, 0, 0, 79, 0],
                [OUT_S, 0, 1, 0, 0, 0],
            ]),
        )
        .unwrap();
        assert_eq!(
            out,
            vec!["49269609804781974438694403402127765867".to_string()]
        );
        let error = run(
            &[3],
            1,
            &program(&[
                [LOAD_S, 0, 0, 0, 0, 0],
                [POW_S, 1, 0, 0, 81, 0],
                [OUT_S, 0, 1, 0, 0, 0],
            ]),
        )
        .unwrap_err();
        assert!(error.is_recoverable(), "{error:?}");
    }

    #[test]
    fn a_negative_precision_or_scale_is_refused_instead_of_cast() {
        for words in [
            [[LOAD_S, 0, 0, 0, -1, 0], [OUT_S, 0, 0, 0, 0, 0]],
            [[LOAD_S, 0, 0, 0, 0, 0], [DIV_SS, 1, 0, 0, -1, 0]],
            [[LOAD_S, 0, 0, 0, 0, 0], [SQRT_S, 1, 0, 0, -1, 0]],
            [[LOAD_C, 0, 0, 0, -1, 0], [SUM_C, 0, 0, 0, 0, 0]],
        ] {
            let error = run(&[2], 1, &program(&words)).unwrap_err();
            assert!(
                matches!(error, BulkError::BadProgram(_)),
                "{words:?}: {error:?}"
            );
        }
    }

    #[test]
    fn a_precision_past_the_decimal_bound_is_refused() {
        for op in [DIV_SS, SQRT_S] {
            let error = run(
                &[2],
                1,
                &program(&[[LOAD_S, 0, 0, 0, 0, 0], [op, 1, 0, 0, 10_001, 0]]),
            )
            .unwrap_err();
            assert!(matches!(error, BulkError::BadProgram(_)), "{op}: {error:?}");
        }
    }

    #[test]
    fn a_square_root_below_half_the_operand_scale_truncates_the_radicand() {
        // √2.123 at one digit: ⌊√(2123 / 10)⌋ = ⌊√212⌋ = 14, as engine::sqrt.
        let out = run(
            &[2123],
            1,
            &program(&[
                [LOAD_S, 0, 0, 0, 3, 0],
                [SQRT_S, 1, 0, 0, 1, 0],
                [SQRT_S, 2, 0, 0, 0, 0],
                [OUT_S, 0, 1, 0, 0, 0],
                [OUT_S, 0, 2, 0, 0, 0],
            ]),
        )
        .unwrap();
        assert_eq!(
            out,
            vec![
                crate::engine::sqrt("2.123", 1).unwrap(),
                crate::engine::sqrt("2.123", 0).unwrap(),
            ]
        );
        assert_eq!(out, vec!["1.4".to_string(), "1".to_string()]);
    }

    /// `a·10^-a_scale / b` at `precision`, in the mode numbered `code`.
    fn quotient(a: i64, a_scale: i32, b: i64, precision: i32, code: i32) -> String {
        let out = run(
            &[a, b],
            1,
            &program(&[
                [LOAD_S, 0, 0, 0, a_scale, 0],
                [LOAD_S, 1, 1, 0, 0, 0],
                [DIV_SS, 2, 0, 1, precision, code],
                [OUT_S, 0, 2, 0, 0, 0],
            ]),
        )
        .unwrap();
        out[0].clone()
    }

    /// `√(a·10^-a_scale)` at `precision`, in the mode numbered `code`.
    fn root(a: i64, a_scale: i32, precision: i32, code: i32) -> String {
        let out = run(
            &[a],
            1,
            &program(&[
                [LOAD_S, 0, 0, 0, a_scale, 0],
                [SQRT_S, 1, 0, 0, precision, code],
                [OUT_S, 0, 1, 0, 0, 0],
            ]),
        )
        .unwrap();
        out[0].clone()
    }

    #[test]
    fn division_and_roots_round_as_the_scalar_engine_does_in_every_mode() {
        let modes = ["trunc", "floor", "ceil", "half-up", "half-even"];
        let cases: [(i64, i32, i64, i32); 8] = [
            (1, 0, 8, 2),
            (1, 0, -8, 2),
            (-2, 0, 3, 4),
            (2, 0, 3, 4),
            (225, 2, 7, 0),
            (2123, 3, 3, 1),
            (625, 2, -4, 0),
            (2, 0, 3, 12),
        ];
        for (code, mode) in modes.iter().enumerate() {
            let code = code as i32;
            for (a, a_scale, b, precision) in cases {
                let text = format_decimal(BigInt::from(a), a_scale as u32);
                let expected = crate::engine::div(&text, &b.to_string(), precision as u32, mode);
                assert_eq!(
                    quotient(a, a_scale, b, precision, code),
                    expected.unwrap(),
                    "{text}/{b} {mode}"
                );
                if a >= 0 {
                    let truncated = crate::engine::sqrt(&text, precision as u32).unwrap();
                    assert_eq!(
                        root(a, a_scale, precision, code),
                        expected_root(&text, &truncated, precision as u32, mode),
                        "√{text} {mode}"
                    );
                }
            }
        }
    }

    /// The rounded root, from the truncated one and exact BigInt comparisons.
    fn expected_root(value: &str, truncated: &str, precision: u32, mode: &str) -> String {
        let v = crate::engine::parse_decimal(value).unwrap();
        let t = crate::engine::parse_decimal(truncated).unwrap();
        let t_int = &t.int * pow10(precision - t.scale);
        // Compare x / 10^(2p) with v.int / 10^v.scale.
        let cmp = |x: BigInt, times: u32| {
            (x * pow10(v.scale)).cmp(&(&v.int * times * pow10(2 * precision)))
        };
        let exact = cmp(&t_int * &t_int, 1) == Ordering::Equal;
        let threshold = cmp((&t_int * 2 + 1) * (&t_int * 2 + 1), 4);
        let up = match mode {
            "trunc" | "floor" => false,
            "ceil" => !exact,
            "half-up" => threshold != Ordering::Greater,
            _ => {
                threshold == Ordering::Less
                    || (threshold == Ordering::Equal && &t_int % 2 != BigInt::from(0))
            }
        };
        format_decimal(if up { t_int + 1 } else { t_int }, precision)
    }

    #[test]
    fn an_unknown_rounding_mode_is_refused() {
        for op in [DIV_SS, SQRT_S] {
            let error = run(
                &[2],
                1,
                &program(&[[LOAD_S, 0, 0, 0, 0, 0], [op, 1, 0, 0, 2, 5]]),
            )
            .unwrap_err();
            assert!(matches!(error, BulkError::BadProgram(_)), "{op}: {error:?}");
        }
    }

    #[test]
    fn a_rounded_quotient_moves_away_from_zero_on_both_signs() {
        assert_eq!(quotient(3, 0, 2, 0, 3), "2");
        assert_eq!(quotient(-3, 0, 2, 0, 3), "-2");
        assert_eq!(quotient(-3, 0, 2, 0, 1), "-2");
        assert_eq!(quotient(-3, 0, 2, 0, 2), "-1");
    }

    #[test]
    fn a_truncated_instruction_is_refused() {
        let error = run(&[1], 1, &[LOAD_S, 0, 0]).unwrap_err();
        assert!(matches!(error, BulkError::BadProgram(_)));
    }

    #[test]
    fn mismatched_column_lengths_are_refused() {
        // Two columns of 2 declared over a buffer holding only 3 values.
        let error = run(
            &[1i64, 2, 3],
            2,
            &program(&[[LOAD_C, 0, 0, 0, 0, 0], [LOAD_C, 1, 1, 0, 0, 0]]),
        )
        .unwrap_err();
        assert!(matches!(error, BulkError::BadProgram(_)));
    }
}
