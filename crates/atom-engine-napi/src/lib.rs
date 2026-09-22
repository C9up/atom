pub mod bulk;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::panic::catch_unwind;

#[napi]
pub fn add(a: String, b: String) -> Result<String> {
    wrap_string(|| atom_engine::add(&a, &b))
}

#[napi]
pub fn sub(a: String, b: String) -> Result<String> {
    wrap_string(|| atom_engine::sub(&a, &b))
}

#[napi]
pub fn mul(a: String, b: String) -> Result<String> {
    wrap_string(|| atom_engine::mul(&a, &b))
}

#[napi]
pub fn div(a: String, b: String, precision: u32) -> Result<String> {
    wrap_string(|| atom_engine::div(&a, &b, precision))
}

#[napi]
pub fn rem(a: String, b: String) -> Result<String> {
    wrap_string(|| atom_engine::rem(&a, &b))
}

#[napi]
pub fn pow(a: String, exp: i32, precision: u32) -> Result<String> {
    wrap_string(|| atom_engine::pow(&a, exp, precision))
}

#[napi]
pub fn sqrt(a: String, precision: u32) -> Result<String> {
    wrap_string(|| atom_engine::sqrt(&a, precision))
}

/// Batch addition — one crossing for the whole list.
///
/// `Vec<String>` rather than a stream of calls, because the crossing IS the
/// cost: parsing and formatting a decimal is cheap, and doing it once per
/// pair from JavaScript is what makes a long fold expensive.
#[napi]
pub fn sum(values: Vec<String>) -> Result<String> {
    wrap_string(move || atom_engine::sum(&values))
}

/// Batch `Σ aᵢ·bᵢ` — the shape of every valuation, in one crossing.
#[napi]
pub fn dot(a: Vec<String>, b: Vec<String>) -> Result<String> {
    wrap_string(move || atom_engine::dot(&a, &b))
}

#[napi]
pub fn cmp(a: String, b: String) -> Result<i32> {
    let result = catch_unwind(|| -> std::result::Result<i32, String> { atom_engine::cmp(&a, &b) });
    match result {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(e)) => Err(Error::from_reason(e)),
        Err(_) => Err(Error::from_reason("Internal panic in atom engine")),
    }
}

fn wrap_string<F>(f: F) -> Result<String>
where
    F: FnOnce() -> std::result::Result<String, String> + std::panic::UnwindSafe,
{
    let result = catch_unwind(|| -> std::result::Result<String, String> { f() });
    match result {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(e)) => Err(Error::from_reason(e)),
        Err(_) => Err(Error::from_reason("Internal panic in atom engine")),
    }
}
