use num_bigint::BigInt;
use num_traits::{Signed, Zero};
use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::sync::OnceLock;

/// The most fractional digits a precision or a scale may ask for — kept in
/// step with `MAX_SCALE` in `src/math.ts`.
pub const MAX_SCALE: u32 = 10_000;

/// The most significant digits a power may produce: the highest `maxDigits`
/// the TypeScript context accepts. The facade checks its own, lower, bound
/// first; this one keeps the engine from being asked for a power that would
/// take minutes whoever calls it.
const MAX_POWER_DIGITS: f64 = 1_000_000.0;

/// How a quotient that does not land on a digit is brought to one.
///
/// The names are the TypeScript `RoundMode` union's; `half-up` and `half-even`
/// treat a negative value by its magnitude, as big.js does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoundMode {
    Trunc,
    Floor,
    Ceil,
    HalfUp,
    HalfEven,
}

impl RoundMode {
    pub fn parse(name: &str) -> Result<Self, String> {
        match name {
            "trunc" => Ok(Self::Trunc),
            "floor" => Ok(Self::Floor),
            "ceil" => Ok(Self::Ceil),
            "half-up" => Ok(Self::HalfUp),
            "half-even" => Ok(Self::HalfEven),
            _ => Err(format!("Unknown rounding mode: {name}")),
        }
    }

    /// Whether a truncated quotient with a non-zero remainder moves one step
    /// away from zero. `negative` is the sign of the exact quotient, `half`
    /// how twice the remainder compares with the divisor, by magnitude.
    pub(crate) fn steps_away(self, negative: bool, half: Ordering, odd: bool) -> bool {
        match self {
            Self::Trunc => false,
            Self::Floor => negative,
            Self::Ceil => !negative,
            Self::HalfUp => half != Ordering::Less,
            Self::HalfEven => half == Ordering::Greater || (half == Ordering::Equal && odd),
        }
    }
}

/// `n / d` rounded once to an integer in `mode`.
fn round_quotient(numerator: BigInt, denominator: BigInt, mode: RoundMode) -> BigInt {
    // num-bigint divides toward zero and gives the remainder the dividend's sign.
    let quotient = &numerator / &denominator;
    let remainder = &numerator % &denominator;
    if remainder.is_zero() {
        return quotient;
    }
    let negative = numerator.is_negative() != denominator.is_negative();
    let half = (remainder.abs() * 2u32).cmp(&denominator.abs());
    let odd = !(&quotient % 2u32).is_zero();
    if !mode.steps_away(negative, half, odd) {
        quotient
    } else if negative {
        quotient - 1
    } else {
        quotient + 1
    }
}

fn assert_precision(precision: u32) -> Result<(), String> {
    if precision > MAX_SCALE {
        return Err(format!("Invalid scale: {precision}"));
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub(crate) struct Decimal {
    pub(crate) int: BigInt,
    pub(crate) scale: u32,
}

pub fn add(a: &str, b: &str) -> Result<String, String> {
    let da = parse_decimal(a)?;
    let db = parse_decimal(b)?;
    let (ai, bi, scale) = align_scale(&da, &db);
    Ok(format_decimal(ai + bi, scale))
}

pub fn sub(a: &str, b: &str) -> Result<String, String> {
    let da = parse_decimal(a)?;
    let db = parse_decimal(b)?;
    let (ai, bi, scale) = align_scale(&da, &db);
    Ok(format_decimal(ai - bi, scale))
}

pub fn mul(a: &str, b: &str) -> Result<String, String> {
    let da = parse_decimal(a)?;
    let db = parse_decimal(b)?;
    let scale = product_scale(&da, &db)?;
    Ok(format_decimal(da.int * db.int, scale))
}

/// The scale a product is worked at.
///
/// Not refused past [`MAX_SCALE`]: `5e-5000 · 2e-5001` works at 10 001 digits
/// and is `1e-10000`, which fits. Whether the canonical result fits is the
/// caller's check, on the result.
fn product_scale(a: &Decimal, b: &Decimal) -> Result<u32, String> {
    a.scale
        .checked_add(b.scale)
        .ok_or_else(|| "Invalid scale: a product's scale overflows".to_string())
}

/// Add up integers grouped by scale, then raise each group once to the
/// largest scale.
///
/// Raising every member on its own made one value at scale 10 000 cost a
/// 10 000-digit multiplication for each of the others; grouped, a list costs
/// its length plus one multiplication per distinct scale.
fn sum_by_scale(groups: BTreeMap<u32, BigInt>) -> String {
    let scale = groups.keys().next_back().copied().unwrap_or(0);
    let mut total = BigInt::zero();
    for (group_scale, int) in groups {
        // Raised to the common scale rather than rounded to it: every value
        // keeps every digit it came with, which is what makes this exact.
        total += int * pow10(scale - group_scale);
    }
    format_decimal(total, scale)
}

/// Sum a whole batch in ONE crossing of the boundary.
///
/// Identical in result to folding `add` over the same values — decimal
/// addition is exact and associative, and `format_decimal` normalises the
/// output — but it parses and formats once instead of once per pair. That is
/// what it exists for: the cost of `Decimal` arithmetic from JavaScript is
/// almost entirely the string round trip, not the arithmetic, so a caller
/// summing a hundred thousand values pays a hundred thousand crossings for
/// work this does in one.
///
/// An empty batch is `0`: the additive identity, and the only answer that
/// keeps `sum(a) + sum(b) == sum(a ++ b)` true when one side is empty.
pub fn sum(values: &[String]) -> Result<String, String> {
    let mut groups: BTreeMap<u32, BigInt> = BTreeMap::new();
    for value in values {
        let decimal = parse_decimal(value)?;
        *groups.entry(decimal.scale).or_default() += decimal.int;
    }
    Ok(sum_by_scale(groups))
}

/// The sum of pairwise products — `Σ aᵢ·bᵢ` — in one crossing.
///
/// The shape of every valuation this ecosystem performs: a quantity times a
/// price, added up. Exact for the same reason `mul` is — a product's scale is
/// the sum of its operands' scales, and nothing is rounded on the way — so it
/// agrees digit for digit with multiplying and adding one pair at a time.
///
/// Refuses mismatched lengths rather than stopping at the shorter one: a
/// quantity list and a price list of different lengths is a caller's bug, and
/// silently valuing the first n positions would return a plausible number for
/// a portfolio nobody holds.
pub fn dot(a: &[String], b: &[String]) -> Result<String, String> {
    if a.len() != b.len() {
        return Err(format!(
            "Mismatched batch lengths: {} and {}",
            a.len(),
            b.len()
        ));
    }

    let mut groups: BTreeMap<u32, BigInt> = BTreeMap::new();
    for (left, right) in a.iter().zip(b.iter()) {
        let da = parse_decimal(left)?;
        let db = parse_decimal(right)?;
        let scale = product_scale(&da, &db)?;
        *groups.entry(scale).or_default() += da.int * db.int;
    }
    Ok(sum_by_scale(groups))
}

/// `a / b` at `precision` fractional digits, rounded once from the exact
/// quotient in `mode` (a `RoundMode` name).
pub fn div(a: &str, b: &str, precision: u32, mode: &str) -> Result<String, String> {
    assert_precision(precision)?;
    let mode = RoundMode::parse(mode)?;
    let da = parse_decimal(a)?;
    let db = parse_decimal(b)?;
    if db.int.is_zero() {
        return Err("Division by zero".to_string());
    }

    let ten_pow_precision = pow10(precision);
    let ten_pow_db_scale = pow10(db.scale);
    let ten_pow_da_scale = pow10(da.scale);

    // (aInt / 10^aScale) / (bInt / 10^bScale)
    // => (aInt * 10^(precision + bScale)) / (bInt * 10^aScale)
    let numerator = da.int * ten_pow_precision * ten_pow_db_scale;
    let denominator = db.int * ten_pow_da_scale;
    let quotient = round_quotient(numerator, denominator, mode);

    Ok(format_decimal(quotient, precision))
}

/// `a mod b` — exact remainder following BigInt semantics (sign follows dividend).
/// The result carries the max scale of the two operands. Returns an error on
/// divide-by-zero.
pub fn rem(a: &str, b: &str) -> Result<String, String> {
    let da = parse_decimal(a)?;
    let db = parse_decimal(b)?;
    if db.int.is_zero() {
        return Err("Division by zero".to_string());
    }
    let (ai, bi, scale) = align_scale(&da, &db);
    Ok(format_decimal(ai % bi, scale))
}

/// Integer exponent `a^exp` with exact accumulated scale.
///
/// - `exp == 0` → `1`
/// - `exp > 0`  → binary exponentiation, scale = `a.scale * exp` (exact)
/// - `exp < 0`  → `1 / a^(-exp)` at the given `precision`, rounded in `mode`
///
/// The positive path is exact because each multiplication accumulates scale
/// without loss. The negative path has to divide, so it follows `div`'s
/// contract at `precision` fractional digits.
pub fn pow(a: &str, exp: i32, precision: u32, mode: &str) -> Result<String, String> {
    assert_precision(precision)?;
    RoundMode::parse(mode)?;
    if exp == 0 {
        return Ok("1".to_string());
    }
    if exp < 0 {
        let positive_exp = exp
            .checked_neg()
            .ok_or_else(|| "Invalid exponent: below supported i32 range".to_string())?;
        check_power_size(&without_trailing_zeros(parse_decimal(a)?), exp)?;
        let positive = pow(a, positive_exp, precision, mode)?;
        return div("1", &positive, precision, mode);
    }

    // Binary exponentiation on the integer representation — avoids repeated
    // string parsing at each multiplication step.
    // Canonical first: a trailing zero of the fraction would otherwise
    // multiply the scale for nothing.
    let mut base = without_trailing_zeros(parse_decimal(a)?);
    check_power_size(&base, exp)?;
    let mut result_int = BigInt::from(1u32);
    let mut result_scale: u32 = 0;
    let mut e = exp as u32;

    while e > 0 {
        if e & 1 == 1 {
            result_int *= &base.int;
            result_scale += base.scale;
        }
        e >>= 1;
        if e > 0 {
            // Bounded by the check above: the squared scale never passes
            // `scale * exp`.
            base = Decimal {
                int: &base.int * &base.int,
                scale: base.scale * 2,
            };
        }
    }

    Ok(format_decimal(result_int, result_scale))
}

/// Refuse a power whose size is predictably out of bounds, before computing it.
///
/// A positive power of a canonical base carries exactly `scale · exp`
/// fractional digits, and about `exp · log10|int|` significant ones. A negative
/// power is `1 / base^|exp|`: that intermediate is sized the same way, and the
/// quotient's integer part has about `|exp| · (scale − log10|int|)` digits.
///
/// `base` must be canonical — see [`without_trailing_zeros`].
fn check_power_size(base: &Decimal, exp: i32) -> Result<(), String> {
    if base.int.is_zero() {
        return Ok(());
    }
    let steps = exp.unsigned_abs();
    let scale = base.scale;
    if exp > 0
        && scale
            .checked_mul(steps)
            .is_none_or(|result_scale| result_scale > MAX_SCALE)
    {
        return Err("Invalid scale: a power's scale is past the largest scale".to_string());
    }
    // |int| lies in [2^(bits-1), 2^bits).
    let bits = base.int.bits() as f64;
    let at_least = (bits - 1.0) * std::f64::consts::LOG10_2;
    let at_most = bits * std::f64::consts::LOG10_2;
    let steps = f64::from(steps);
    let too_large = steps * at_least > MAX_POWER_DIGITS
        || (exp < 0 && steps * (f64::from(scale) - at_most) > MAX_POWER_DIGITS);
    if too_large {
        return Err("A power past the bound of significant digits".to_string());
    }
    Ok(())
}

/// The same value at the smallest scale that holds it.
fn without_trailing_zeros(mut decimal: Decimal) -> Decimal {
    let ten = BigInt::from(10u32);
    while decimal.scale > 0 && (&decimal.int % &ten).is_zero() {
        decimal.int /= &ten;
        decimal.scale -= 1;
    }
    decimal
}

/// Integer square root of a decimal — returns the largest value `r` such that
/// `r * r <= input` at `precision` fractional digits, following the Newton
/// iteration on BigInt. Returns an error for negative inputs.
///
/// This is the "truncated" sqrt; rounding modes are applied in the TS layer
/// by requesting one extra digit of precision and rounding the last.
pub fn sqrt(a: &str, precision: u32) -> Result<String, String> {
    assert_precision(precision)?;
    let parsed = parse_decimal(a)?;
    if parsed.int < BigInt::from(0) {
        return Err("Cannot compute sqrt of a negative decimal".to_string());
    }
    if parsed.int.is_zero() {
        return Ok("0".to_string());
    }

    // Shift the radicand so that taking its integer square root yields a
    // result with `precision` fractional digits. This is the same identity
    // used in the TS fallback: `floor(sqrt(int * 10^(2*target - scale)))`.
    let doubled = 2 * precision;
    let radicand = if doubled >= parsed.scale {
        parsed.int * pow10(doubled - parsed.scale)
    } else {
        parsed.int / pow10(parsed.scale - doubled)
    };

    // num-bigint's root starts Newton from a floating-point estimate, so it
    // converges in `O(log bits)` steps; the hand-written iteration started
    // from the radicand itself and took about `bits/2` full-width divisions,
    // seconds on a 20 000-digit value. Through `BigUint` so a negative
    // radicand is an error rather than a panic.
    let root = radicand
        .to_biguint()
        .ok_or_else(|| "Cannot compute sqrt of a negative decimal".to_string())?
        .sqrt();
    Ok(format_decimal(BigInt::from(root), precision))
}

pub fn cmp(a: &str, b: &str) -> Result<i32, String> {
    let da = parse_decimal(a)?;
    let db = parse_decimal(b)?;
    let (ai, bi, _) = align_scale(&da, &db);
    let ord = ai.cmp(&bi);
    Ok(match ord {
        Ordering::Less => -1,
        Ordering::Equal => 0,
        Ordering::Greater => 1,
    })
}

pub(crate) fn parse_decimal(input: &str) -> Result<Decimal, String> {
    let s = input.trim();
    if s.is_empty() {
        return Err("Invalid decimal: empty string".to_string());
    }

    let mut sign = 1i32;
    let body = if let Some(rest) = s.strip_prefix('-') {
        sign = -1;
        rest
    } else if let Some(rest) = s.strip_prefix('+') {
        rest
    } else {
        s
    };

    let parts: Vec<&str> = body.split('.').collect();
    if parts.len() > 2 {
        return Err(format!("Invalid decimal: {}", input));
    }

    let whole = parts[0];
    let frac = if parts.len() == 2 { parts[1] } else { "" };

    if !whole.chars().all(|c| c.is_ascii_digit()) || !frac.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("Invalid decimal: {}", input));
    }

    let digits = format!("{}{}", whole, frac);
    if digits.is_empty() {
        return Err(format!("Invalid decimal: {}", input));
    }
    let mut int = digits
        .parse::<BigInt>()
        .map_err(|_| format!("Invalid decimal: {}", input))?;
    if sign < 0 {
        int = -int;
    }

    let scale = u32::try_from(frac.len()).map_err(|_| format!("Invalid scale: {}", frac.len()))?;
    Ok(Decimal { int, scale })
}

fn align_scale(a: &Decimal, b: &Decimal) -> (BigInt, BigInt, u32) {
    if a.scale == b.scale {
        return (a.int.clone(), b.int.clone(), a.scale);
    }
    if a.scale > b.scale {
        let factor = pow10(a.scale - b.scale);
        return (a.int.clone(), &b.int * factor, a.scale);
    }

    let factor = pow10(b.scale - a.scale);
    (&a.int * factor, b.int.clone(), b.scale)
}

pub(crate) fn format_decimal(int: BigInt, scale: u32) -> String {
    if scale == 0 {
        return int.to_string();
    }

    let negative = int.is_negative();
    let mut s = int.abs().to_string();
    let scale_usize = scale as usize;

    if s.len() <= scale_usize {
        let zeros = "0".repeat(scale_usize + 1 - s.len());
        s = format!("{}{}", zeros, s);
    }

    let split = s.len() - scale_usize;
    let whole = &s[..split];
    let mut frac = s[split..].to_string();
    while frac.ends_with('0') {
        frac.pop();
    }

    let mut out = if frac.is_empty() {
        whole.to_string()
    } else {
        format!("{}.{}", whole, frac)
    };

    if negative && out != "0" {
        out = format!("-{}", out);
    }
    out
}

/// The distance between two rungs of the power-of-ten ladder.
const LADDER_STEP: u32 = 100;

/// Rungs up to twice the largest scale: a product is worked at the sum of two
/// scales, and a square root's radicand at twice its precision.
const LADDER_RUNGS: usize = (2 * MAX_SCALE / LADDER_STEP) as usize + 1;

/// `10^(100·k)`, each built the first time it is asked for. Every rung kept
/// is under a megabyte all together, which is what bounds the cache.
static LADDER: [OnceLock<BigInt>; LADDER_RUNGS] = [const { OnceLock::new() }; LADDER_RUNGS];

/// `10^exp`.
///
/// Built from the ladder's rung below `exp` and one small power, so a scale
/// alignment costs one multiplication linear in the digits instead of `exp`
/// of them — rebuilding `10^10000` one factor of ten at a time was what made
/// a single value at scale 10 000 cost seconds across a list.
pub(crate) fn pow10(exp: u32) -> BigInt {
    let ten = BigInt::from(10u32);
    let rung = exp / LADDER_STEP;
    let rest = ten.pow(exp % LADDER_STEP);
    let Some(slot) = usize::try_from(rung).ok().and_then(|rung| LADDER.get(rung)) else {
        return ten.pow(exp);
    };
    let high = slot.get_or_init(|| ten.pow(rung * LADDER_STEP));
    high * rest
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pow10_is_exact_on_and_between_the_ladder_rungs() {
        let ten = BigInt::from(10u32);
        for exp in [
            0, 1, 99, 100, 101, 250, 9_999, 10_000, 19_999, 20_000, 20_100, 20_101, 25_000,
        ] {
            assert_eq!(pow10(exp), ten.pow(exp), "10^{exp}");
        }
    }

    #[test]
    fn sum_and_dot_group_mixed_scales_exactly() {
        let mut values = strings(&["1", "0.5", "-0.25", "2"]);
        values.push(format!("0.{}1", "0".repeat(9_999)));
        assert_eq!(sum(&values).unwrap(), format!("3.25{}1", "0".repeat(9_997)));
        let left = strings(&["2", "0.5", "1.25"]);
        let right = strings(&["3", "0.2", "-4"]);
        assert_eq!(dot(&left, &right).unwrap(), "1.1");
        // Worked at 10 001 digits, but the product fits.
        let a = format!("0.{}5", "0".repeat(4_999));
        let b = format!("0.{}2", "0".repeat(5_000));
        assert_eq!(mul(&a, &b).unwrap(), format!("0.{}1", "0".repeat(9_999)));
    }

    #[test]
    fn add_and_sub_work() {
        assert_eq!(add("1.23", "2.7").unwrap(), "3.93");
        assert_eq!(sub("10", "2.5").unwrap(), "7.5");
    }

    #[test]
    fn mul_works() {
        assert_eq!(mul("1.2", "3").unwrap(), "3.6");
        assert_eq!(mul("2.50", "2").unwrap(), "5");
    }

    #[test]
    fn div_works() {
        assert_eq!(div("1", "8", 6, "trunc").unwrap(), "0.125");
        assert_eq!(div("10", "4", 4, "trunc").unwrap(), "2.5");
    }

    #[test]
    fn cmp_works() {
        assert_eq!(cmp("1.20", "1.2").unwrap(), 0);
        assert_eq!(cmp("1.19", "1.2").unwrap(), -1);
        assert_eq!(cmp("1.21", "1.2").unwrap(), 1);
    }

    #[test]
    fn div_by_zero_errors() {
        assert!(div("5", "0", 10, "trunc").is_err());
        assert!(rem("5", "0").is_err());
    }

    #[test]
    fn negative_numbers() {
        assert_eq!(add("-1.5", "0.5").unwrap(), "-1");
        assert_eq!(sub("-1", "-2").unwrap(), "1");
        assert_eq!(mul("-2", "3").unwrap(), "-6");
        assert_eq!(mul("-2", "-3").unwrap(), "6");
        assert_eq!(cmp("-1", "-2").unwrap(), 1);
        assert_eq!(cmp("-2", "-1").unwrap(), -1);
    }

    #[test]
    fn mismatched_scales_large() {
        // 15-digit vs 2-digit scale
        let result = add("1.000000000000001", "0.99").unwrap();
        assert_eq!(result, "1.990000000000001");
    }

    #[test]
    fn very_large_values() {
        // Beyond 2^53 — where JS number would lose precision
        let huge = "123456789012345678901234567890";
        assert_eq!(add(huge, "1").unwrap(), "123456789012345678901234567891");
        assert_eq!(mul(huge, "2").unwrap(), "246913578024691357802469135780");
    }

    #[test]
    fn rem_works() {
        assert_eq!(rem("10", "3").unwrap(), "1");
        assert_eq!(rem("10.5", "3").unwrap(), "1.5");
        assert_eq!(rem("-10", "3").unwrap(), "-1");
    }

    #[test]
    fn pow_works() {
        assert_eq!(pow("2", 10, 18, "trunc").unwrap(), "1024");
        assert_eq!(pow("1.5", 2, 18, "trunc").unwrap(), "2.25");
        assert_eq!(pow("2", 0, 18, "trunc").unwrap(), "1");
        // Negative exponent goes through div path
        assert_eq!(pow("2", -2, 18, "trunc").unwrap(), "0.25");
    }

    #[test]
    fn pow_refuses_a_result_predictably_too_large_before_computing_it() {
        let base = "9".repeat(1_000);
        let started = std::time::Instant::now();
        assert!(pow(&base, 100_000, 18, "trunc").is_err());
        assert!(pow(&base, -100_000, 18, "trunc").is_err());
        assert!(started.elapsed().as_millis() < 1_000);
        assert_eq!(pow("1", i32::MAX, 18, "trunc").unwrap(), "1");
        assert_eq!(pow("-1", i32::MAX, 18, "trunc").unwrap(), "-1");
    }

    #[test]
    fn pow_refuses_a_scale_past_the_largest_scale_before_computing_it() {
        assert!(pow("0.1", i32::MAX, 18, "trunc").is_err());
        assert!(pow("0.1", 10_001, 18, "trunc").is_err());
        assert_eq!(pow("0.1", 10_000, 18, "trunc").unwrap().len(), 10_002);
        // Trailing zeros do not count, and do not overflow the scale either.
        assert_eq!(
            pow(&format!("1.{}", "0".repeat(10_000)), i32::MAX, 18, "trunc").unwrap(),
            "1"
        );
    }

    #[test]
    fn pow_refuses_a_negative_power_whose_quotient_is_too_large() {
        // 1 / (10^-5000)^100000 has five hundred million digits.
        let tiny = format!("0.{}1", "0".repeat(4_999));
        assert!(pow(&tiny, -100_000, 18, "trunc").is_err());
        assert_eq!(pow("0.5", -3, 18, "trunc").unwrap(), "8");
    }

    #[test]
    fn a_precision_past_the_largest_scale_is_refused() {
        assert!(div("1", "3", MAX_SCALE + 1, "trunc").is_err());
        assert!(sqrt("2", MAX_SCALE + 1).is_err());
        assert!(pow("2", -1, MAX_SCALE + 1, "trunc").is_err());
        assert!(div("1", "3", MAX_SCALE, "trunc").is_ok());
    }

    #[test]
    fn div_rounds_the_exact_quotient_once_in_the_mode_asked_for() {
        // 1/8, -1/8, 2/3, -2/3 at two digits.
        let cases = [
            ("trunc", ["0.12", "-0.12", "0.66", "-0.66"]),
            ("floor", ["0.12", "-0.13", "0.66", "-0.67"]),
            ("ceil", ["0.13", "-0.12", "0.67", "-0.66"]),
            ("half-up", ["0.13", "-0.13", "0.67", "-0.67"]),
            ("half-even", ["0.12", "-0.12", "0.67", "-0.67"]),
        ];
        for (mode, expected) in cases {
            let got = [
                div("1", "8", 2, mode).unwrap(),
                div("1", "-8", 2, mode).unwrap(),
                div("2", "3", 2, mode).unwrap(),
                div("-2", "3", 2, mode).unwrap(),
            ];
            assert_eq!(got, expected, "{mode}");
        }
        assert_eq!(pow("1.5", -1, 2, "half-up").unwrap(), "0.67");
        assert!(div("1", "3", 2, "bogus").is_err());
        assert!(pow("2", 2, 2, "bogus").is_err());
    }

    #[test]
    fn sqrt_works() {
        assert_eq!(sqrt("4", 6).unwrap(), "2");
        assert_eq!(sqrt("2", 6).unwrap(), "1.414213");
        assert_eq!(sqrt("0", 6).unwrap(), "0");
        assert!(sqrt("-1", 6).is_err());
    }

    #[test]
    fn sqrt_of_a_wide_square_is_exact() {
        let root = "7".repeat(10_000);
        let square = mul(&root, &root).unwrap();
        assert_eq!(sqrt(&square, 0).unwrap(), root);
        assert_eq!(sqrt(&format!("{square}.5"), 0).unwrap(), root);
        assert!(sqrt("2", MAX_SCALE)
            .unwrap()
            .starts_with("1.41421356237309504880"));
    }

    /// The batch API must agree with the pairwise one, digit for digit —
    /// otherwise a screen that sums a column disagrees with one that folds it.
    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    #[test]
    fn sum_agrees_with_folding_add() {
        let values = strings(&["0.1", "0.2", "1.005", "-3", "2.70"]);
        let folded = values
            .iter()
            .fold("0".to_string(), |acc, v| add(&acc, v).unwrap());
        assert_eq!(sum(&values).unwrap(), folded);
        assert_eq!(sum(&values).unwrap(), "1.005");
    }

    #[test]
    fn sum_of_nothing_is_zero() {
        assert_eq!(sum(&[]).unwrap(), "0");
    }

    #[test]
    fn sum_keeps_every_digit_it_was_given() {
        // Scales are RAISED to the common one, never rounded to it.
        assert_eq!(sum(&strings(&["1.00000001", "2"])).unwrap(), "3.00000001");
    }

    #[test]
    fn sum_refuses_a_malformed_member() {
        assert!(sum(&strings(&["1", "abc"])).is_err());
    }

    #[test]
    fn dot_agrees_with_multiplying_pair_by_pair() {
        let q = strings(&["100", "2.5", "-3"]);
        let p = strings(&["52.37", "1000.01", "7.5"]);
        let folded = q.iter().zip(p.iter()).fold("0".to_string(), |acc, (a, b)| {
            add(&acc, &mul(a, b).unwrap()).unwrap()
        });
        assert_eq!(dot(&q, &p).unwrap(), folded);
    }

    #[test]
    fn dot_refuses_mismatched_lengths() {
        // Valuing the first n positions would return a plausible number for a
        // portfolio nobody holds.
        assert!(dot(&strings(&["1", "2"]), &strings(&["3"])).is_err());
    }

    #[test]
    fn dot_of_nothing_is_zero() {
        assert_eq!(dot(&[], &[]).unwrap(), "0");
    }

    #[test]
    fn empty_input_errors() {
        assert!(add("", "1").is_err());
        assert!(add("1", "").is_err());
    }

    #[test]
    fn malformed_input_errors() {
        assert!(add("1.2.3", "1").is_err());
        assert!(add("abc", "1").is_err());
        assert!(add("1a", "1").is_err());
    }
}
