use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn add(a: &str, b: &str) -> Result<String, JsValue> {
    atom_engine::add(a, b).map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub fn sub(a: &str, b: &str) -> Result<String, JsValue> {
    atom_engine::sub(a, b).map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub fn mul(a: &str, b: &str) -> Result<String, JsValue> {
    atom_engine::mul(a, b).map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub fn div(a: &str, b: &str, precision: u32) -> Result<String, JsValue> {
    atom_engine::div(a, b, precision).map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub fn rem(a: &str, b: &str) -> Result<String, JsValue> {
    atom_engine::rem(a, b).map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub fn pow(a: &str, exp: i32, precision: u32) -> Result<String, JsValue> {
    atom_engine::pow(a, exp, precision).map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub fn sqrt(a: &str, precision: u32) -> Result<String, JsValue> {
    atom_engine::sqrt(a, precision).map_err(|e| JsValue::from_str(&e))
}

/// The batch pair, held to the same shape as the NAPI build so the two
/// engines cannot quietly diverge — the browser has to export what Node does.
///
/// `Vec<String>` crosses the wasm boundary as a JS array of strings, which is
/// exactly what the facade holds anyway.
#[wasm_bindgen]
pub fn sum(values: Vec<String>) -> Result<String, JsValue> {
    atom_engine::sum(&values).map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub fn dot(a: Vec<String>, b: Vec<String>) -> Result<String, JsValue> {
    atom_engine::dot(&a, &b).map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub fn cmp(a: &str, b: &str) -> Result<i32, JsValue> {
    atom_engine::cmp(a, b).map_err(|e| JsValue::from_str(&e))
}

/// Run a bulk program over a resident column buffer.
///
/// Held to the same shape as the N-API build so the two engines cannot quietly
/// diverge — the browser has to export what Node does. `Vec<i64>` and `Vec<i32>`
/// cross as `BigInt64Array` and `Int32Array`, which is what the compiler in
/// TypeScript produces anyway.
#[wasm_bindgen(js_name = runBulk)]
pub fn run_bulk(values: Vec<i64>, rows: u32, program: Vec<i32>) -> Result<Vec<String>, JsValue> {
    atom_engine::bulk::run(&values, rows as usize, &program).map_err(|error| {
        let message = error.message();
        JsValue::from_str(&if error.is_recoverable() {
            format!("[ATOM_BULK_OVERFLOW] {message}")
        } else {
            message
        })
    })
}
