use num_bigint::BigInt;
use num_traits::{Signed, Zero};
use std::cmp::Ordering;

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
    Ok(format_decimal(da.int * db.int, da.scale + db.scale))
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
    let parsed = values
        .iter()
        .map(|value| parse_decimal(value))
        .collect::<Result<Vec<Decimal>, String>>()?;

    let scale = parsed.iter().map(|d| d.scale).max().unwrap_or(0);
    let mut total = BigInt::zero();
    for decimal in &parsed {
        // Raised to the common scale rather than rounded to it: every value
        // keeps every digit it came with, which is what makes this exact.
        total += &decimal.int * pow10(scale - decimal.scale);
    }
    Ok(format_decimal(total, scale))
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

    let mut products: Vec<Decimal> = Vec::with_capacity(a.len());
    for (left, right) in a.iter().zip(b.iter()) {
        let da = parse_decimal(left)?;
        let db = parse_decimal(right)?;
        products.push(Decimal {
            int: da.int * db.int,
            scale: da.scale + db.scale,
        });
    }

    let scale = products.iter().map(|d| d.scale).max().unwrap_or(0);
    let mut total = BigInt::zero();
    for product in &products {
        total += &product.int * pow10(scale - product.scale);
    }
    Ok(format_decimal(total, scale))
}

pub fn div(a: &str, b: &str, precision: u32) -> Result<String, String> {
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
    let quotient = numerator / denominator;

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
/// - `exp < 0`  → `1 / a^(-exp)` at the given `precision`, truncated toward zero
///
/// The positive path is exact because each multiplication accumulates scale
/// without loss. The negative path has to divide, so it follows `div`'s
/// "truncate toward zero" contract at `precision` fractional digits.
pub fn pow(a: &str, exp: i32, precision: u32) -> Result<String, String> {
    if exp == 0 {
        return Ok("1".to_string());
    }
    if exp < 0 {
        let positive_exp = exp
            .checked_neg()
            .ok_or_else(|| "Invalid exponent: below supported i32 range".to_string())?;
        let positive = pow(a, positive_exp, precision)?;
        return div("1", &positive, precision);
    }

    // Binary exponentiation on the integer representation — avoids repeated
    // string parsing at each multiplication step.
    let mut base = parse_decimal(a)?;
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
            base = Decimal {
                int: &base.int * &base.int,
                scale: base.scale * 2,
            };
        }
    }

    Ok(format_decimal(result_int, result_scale))
}

/// Integer square root of a decimal — returns the largest value `r` such that
/// `r * r <= input` at `precision` fractional digits, following the Newton
/// iteration on BigInt. Returns an error for negative inputs.
///
/// This is the "truncated" sqrt; rounding modes are applied in the TS layer
/// by requesting one extra digit of precision and rounding the last.
pub fn sqrt(a: &str, precision: u32) -> Result<String, String> {
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
    let factor_exp: i64 = 2 * precision as i64 - parsed.scale as i64;
    let radicand = if factor_exp >= 0 {
        parsed.int * pow10(factor_exp as u32)
    } else {
        parsed.int / pow10((-factor_exp) as u32)
    };

    let root = bigint_sqrt(radicand);
    Ok(format_decimal(root, precision))
}

/// Integer square root via Newton's method on `BigInt`. Panics on negative.
fn bigint_sqrt(value: BigInt) -> BigInt {
    if value < BigInt::from(2) {
        return value;
    }
    let mut x0 = value.clone();
    let mut x1 = (&x0 + &value / &x0) / BigInt::from(2);
    while x1 < x0 {
        x0 = x1.clone();
        x1 = (&x0 + &value / &x0) / BigInt::from(2);
    }
    x0
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

    Ok(Decimal {
        int,
        scale: frac.len() as u32,
    })
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

pub(crate) fn pow10(exp: u32) -> BigInt {
    let mut acc = BigInt::from(1u32);
    for _ in 0..exp {
        acc *= 10u32;
    }
    acc
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(div("1", "8", 6).unwrap(), "0.125");
        assert_eq!(div("10", "4", 4).unwrap(), "2.5");
    }

    #[test]
    fn cmp_works() {
        assert_eq!(cmp("1.20", "1.2").unwrap(), 0);
        assert_eq!(cmp("1.19", "1.2").unwrap(), -1);
        assert_eq!(cmp("1.21", "1.2").unwrap(), 1);
    }

    #[test]
    fn div_by_zero_errors() {
        assert!(div("5", "0", 10).is_err());
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
        assert_eq!(pow("2", 10, 18).unwrap(), "1024");
        assert_eq!(pow("1.5", 2, 18).unwrap(), "2.25");
        assert_eq!(pow("2", 0, 18).unwrap(), "1");
        // Negative exponent goes through div path
        assert_eq!(pow("2", -2, 18).unwrap(), "0.25");
    }

    #[test]
    fn sqrt_works() {
        assert_eq!(sqrt("4", 6).unwrap(), "2");
        assert_eq!(sqrt("2", 6).unwrap(), "1.414213");
        assert_eq!(sqrt("0", 6).unwrap(), "0");
        assert!(sqrt("-1", 6).is_err());
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
