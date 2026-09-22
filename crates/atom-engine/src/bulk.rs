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

use crate::engine::{format_decimal, pow10};
use num_bigint::BigInt;

/// Fixed instruction width, in `i32` words: `[opcode, dst, a, b, imm0, imm1]`.
///
/// Fixed rather than packed because the decoder is not the cost — a 2 160
/// instruction schedule is 52 KB of program against milliseconds of arithmetic,
/// and a uniform stride keeps the decoder branch-free.
pub const INSTRUCTION_WIDTH: usize = 6;

const COLUMN_REGISTERS: usize = 16;
const SCALAR_REGISTERS: usize = 32;

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

/// Integer square root by Newton's method, truncated toward zero.
fn isqrt(value: i128) -> i128 {
    if value <= 0 {
        return 0;
    }
    let mut guess = value;
    let mut next = (guess + 1) / 2;
    while next < guess {
        guess = next;
        next = (guess + value / guess) / 2;
    }
    guess
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

    fn divide(&self, a: Scalar, b: Scalar, precision: u32) -> Outcome<Scalar> {
        if b.value == 0 {
            return Err(BulkError::DivisionByZero);
        }
        // (a / 10^sa) / (b / 10^sb) at `precision` digits
        //   = (a * 10^(precision + sb)) / (b * 10^sa)
        let numerator = a
            .value
            .checked_mul(ten_pow(precision + b.scale)?)
            .ok_or(BulkError::Overflow("a division numerator"))?;
        let denominator = b
            .value
            .checked_mul(ten_pow(a.scale)?)
            .ok_or(BulkError::Overflow("a division denominator"))?;
        Ok(Scalar {
            // i128 division truncates toward zero, which is the contract the
            // scalar engine already follows.
            value: numerator / denominator,
            scale: precision,
        })
    }

    /// One instruction.
    ///
    /// A fixed-size array rather than a slice: the six reads below are then
    /// bounds-check-free, and this is the loop every bulk program runs once
    /// per instruction.
    fn step(&mut self, word: &[i32; INSTRUCTION_WIDTH]) -> Outcome<()> {
        // `imm1` is decoded but unused: the sixth slot is held open so a new
        // opcode can take a second immediate without changing the stride, and
        // with it every program already compiled.
        let (op, dst, a, b, imm0, _imm1) = (word[0], word[1], word[2], word[3], word[4], word[5]);
        match op {
            LOAD_C => {
                if a < 0 {
                    return Err(BulkError::BadProgram("negative column index".to_string()));
                }
                let offset = (a as usize)
                    .checked_mul(self.rows)
                    .ok_or_else(|| BulkError::BadProgram("column offset overflow".to_string()))?;
                let slice = self
                    .values
                    .get(offset..offset + self.rows)
                    .ok_or_else(|| BulkError::BadProgram("column out of bounds".to_string()))?;
                self.put_column(
                    dst,
                    Column {
                        values: slice.iter().map(|v| *v as i128).collect(),
                        scale: imm0 as u32,
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
                        scale: imm0 as u32,
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
                let scale = left.scale + right.scale;
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
                let scale = column.scale + scalar.scale;
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
                    values: source.values.iter().map(|v| -v).collect(),
                    scale: source.scale,
                };
                self.put_column(dst, column)
            }
            ABS_C => {
                let source = self.column(a)?;
                let column = Column {
                    values: source.values.iter().map(|v| v.abs()).collect(),
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
                let scale = left.scale + right.scale;
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
                        scale: scale * 2,
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
                self.put_scalar(
                    dst,
                    Scalar {
                        value,
                        scale: left.scale + right.scale,
                    },
                )
            }
            DIV_SS => {
                let quotient = self.divide(self.scalar(a)?, self.scalar(b)?, imm0 as u32)?;
                self.put_scalar(dst, quotient)
            }
            NEG_S => {
                let s = self.scalar(a)?;
                self.put_scalar(
                    dst,
                    Scalar {
                        value: -s.value,
                        scale: s.scale,
                    },
                )
            }
            ABS_S => {
                let s = self.scalar(a)?;
                self.put_scalar(
                    dst,
                    Scalar {
                        value: s.value.abs(),
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
                if imm0 < 0 {
                    return Err(BulkError::BadProgram(
                        "negative exponent must be compiled as a division".to_string(),
                    ));
                }
                let base = self.scalar(a)?;
                let mut value: i128 = 1;
                for _ in 0..imm0 {
                    value = value
                        .checked_mul(base.value)
                        .ok_or(BulkError::Overflow("a power"))?;
                }
                let scale = base
                    .scale
                    .checked_mul(imm0 as u32)
                    .ok_or(BulkError::Overflow("a power's scale"))?;
                self.put_scalar(dst, Scalar { value, scale })
            }
            SQRT_S => {
                let source = self.scalar(a)?;
                if source.value < 0 {
                    return Err(BulkError::BadProgram(
                        "square root of a negative value".to_string(),
                    ));
                }
                let precision = imm0 as u32;
                // isqrt(v * 10^(2p − s)) gives ⌊√(v·10^-s) · 10^p⌋.
                let shift = 2 * precision;
                if shift < source.scale {
                    return Err(BulkError::BadProgram(
                        "square root precision below half the operand scale".to_string(),
                    ));
                }
                let lifted = source
                    .value
                    .checked_mul(ten_pow(shift - source.scale)?)
                    .ok_or(BulkError::Overflow("a square root operand"))?;
                self.put_scalar(
                    dst,
                    Scalar {
                        value: isqrt(lifted),
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

/// `10^exp` as a `BigInt`, for callers that need the same ladder this module
/// uses internally.
pub fn scale_factor(exp: u32) -> BigInt {
    pow10(exp)
}

#[cfg(test)]
mod tests {
    use super::*;

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
