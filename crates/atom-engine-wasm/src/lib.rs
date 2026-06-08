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

#[wasm_bindgen]
pub fn cmp(a: &str, b: &str) -> Result<i32, JsValue> {
    atom_engine::cmp(a, b).map_err(|e| JsValue::from_str(&e))
}
