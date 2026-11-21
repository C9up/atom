//! C ABI over `atom-engine`, for the C++ JSI module a phone loads atom through
//! (`android/src/main/cpp/NativeAtom.cpp`).
//!
//! Strings cross as (pointer, length) rather than NUL-terminated: a JS string
//! may hold U+0000, and a C string would silently truncate it. Every call
//! returns an [`AtomOut`] the caller hands back to [`atom_ffi_free`] once;
//! `ok == false` means it holds the error message, worded as the N-API
//! binding words it, so a phone reports what Node reports. A panic never
//! unwinds across the boundary: it becomes an error too.

use atom_engine::bulk;
use std::panic::{catch_unwind, AssertUnwindSafe};

/// A borrowed UTF-8 string: `len` bytes at `ptr`.
#[repr(C)]
pub struct AtomStr {
    pub ptr: *const u8,
    pub len: usize,
}

/// An owned result: the value, or the error message when `ok` is false.
#[repr(C)]
pub struct AtomOut {
    pub ok: bool,
    pub ptr: *mut u8,
    pub len: usize,
}

fn out(result: Result<String, String>) -> AtomOut {
    let (ok, text) = match result {
        Ok(value) => (true, value),
        Err(message) => (false, message),
    };
    let boxed = text.into_bytes().into_boxed_slice();
    let len = boxed.len();
    AtomOut {
        ok,
        ptr: Box::into_raw(boxed).cast::<u8>(),
        len,
    }
}

/// # Safety
/// `s.ptr` must point to `s.len` readable bytes (any pointer when `len` is 0).
unsafe fn text<'a>(s: &AtomStr) -> Result<&'a str, String> {
    if s.len == 0 {
        return Ok("");
    }
    std::str::from_utf8(std::slice::from_raw_parts(s.ptr, s.len))
        .map_err(|_| "Invalid decimal: not UTF-8".to_string())
}

/// # Safety
/// `items` must point to `count` valid [`AtomStr`] (any pointer when `count` is 0).
unsafe fn texts(items: *const AtomStr, count: usize) -> Result<Vec<String>, String> {
    if count == 0 {
        return Ok(Vec::new());
    }
    std::slice::from_raw_parts(items, count)
        .iter()
        .map(|s| text(s).map(str::to_owned))
        .collect()
}

/// Panics must not unwind across the C boundary.
fn guarded(f: impl FnOnce() -> Result<String, String>) -> AtomOut {
    out(catch_unwind(AssertUnwindSafe(f))
        .unwrap_or_else(|_| Err("Internal panic in atom engine".to_string())))
}

/// # Safety
/// Both strings must satisfy `text`'s contract.
#[no_mangle]
pub unsafe extern "C" fn atom_ffi_add(a: AtomStr, b: AtomStr) -> AtomOut {
    guarded(|| atom_engine::add(text(&a)?, text(&b)?))
}

/// # Safety
/// Both strings must satisfy `text`'s contract.
#[no_mangle]
pub unsafe extern "C" fn atom_ffi_sub(a: AtomStr, b: AtomStr) -> AtomOut {
    guarded(|| atom_engine::sub(text(&a)?, text(&b)?))
}

/// # Safety
/// Both strings must satisfy `text`'s contract.
#[no_mangle]
pub unsafe extern "C" fn atom_ffi_mul(a: AtomStr, b: AtomStr) -> AtomOut {
    guarded(|| atom_engine::mul(text(&a)?, text(&b)?))
}

/// `mode` is a `RoundMode` name; the quotient is rounded once, in it.
///
/// # Safety
/// The strings must satisfy `text`'s contract.
#[no_mangle]
pub unsafe extern "C" fn atom_ffi_div(
    a: AtomStr,
    b: AtomStr,
    precision: u32,
    mode: AtomStr,
) -> AtomOut {
    guarded(|| atom_engine::div(text(&a)?, text(&b)?, precision, text(&mode)?))
}

/// # Safety
/// Both strings must satisfy `text`'s contract.
#[no_mangle]
pub unsafe extern "C" fn atom_ffi_rem(a: AtomStr, b: AtomStr) -> AtomOut {
    guarded(|| atom_engine::rem(text(&a)?, text(&b)?))
}

/// # Safety
/// The strings must satisfy `text`'s contract.
#[no_mangle]
pub unsafe extern "C" fn atom_ffi_pow(
    a: AtomStr,
    exp: i32,
    precision: u32,
    mode: AtomStr,
) -> AtomOut {
    guarded(|| atom_engine::pow(text(&a)?, exp, precision, text(&mode)?))
}

/// # Safety
/// `a` must satisfy `text`'s contract.
#[no_mangle]
pub unsafe extern "C" fn atom_ffi_sqrt(a: AtomStr, precision: u32) -> AtomOut {
    guarded(|| atom_engine::sqrt(text(&a)?, precision))
}

/// # Safety
/// `values` must point to `count` valid [`AtomStr`].
#[no_mangle]
pub unsafe extern "C" fn atom_ffi_sum(values: *const AtomStr, count: usize) -> AtomOut {
    guarded(|| atom_engine::sum(&texts(values, count)?))
}

/// # Safety
/// `a` and `b` must point to `a_count` and `b_count` valid [`AtomStr`].
#[no_mangle]
pub unsafe extern "C" fn atom_ffi_dot(
    a: *const AtomStr,
    a_count: usize,
    b: *const AtomStr,
    b_count: usize,
) -> AtomOut {
    guarded(|| atom_engine::dot(&texts(a, a_count)?, &texts(b, b_count)?))
}

/// The comparison as text: `-1`, `0` or `1`.
///
/// # Safety
/// Both strings must satisfy `text`'s contract.
#[no_mangle]
pub unsafe extern "C" fn atom_ffi_cmp(a: AtomStr, b: AtomStr) -> AtomOut {
    guarded(|| atom_engine::cmp(text(&a)?, text(&b)?).map(|order| order.to_string()))
}

/// Run a bulk program over a resident column buffer (see the N-API
/// `runBulk`). The emitted scalars come back joined by `\n` — a decimal never
/// holds one. An overflow of the 128-bit width is reported as
/// `[ATOM_BULK_OVERFLOW] …`, the caller's signal to re-run on BigInt.
///
/// # Safety
/// `values` must point to `value_count` i64 and `program` to `program_count`
/// i32 (any pointer when the count is 0).
#[no_mangle]
pub unsafe extern "C" fn atom_ffi_run_bulk(
    values: *const i64,
    value_count: usize,
    rows: u32,
    program: *const i32,
    program_count: usize,
) -> AtomOut {
    let values = if value_count == 0 {
        &[][..]
    } else {
        std::slice::from_raw_parts(values, value_count)
    };
    let program = if program_count == 0 {
        &[][..]
    } else {
        std::slice::from_raw_parts(program, program_count)
    };
    out(
        match catch_unwind(AssertUnwindSafe(|| {
            bulk::run(values, rows as usize, program)
        })) {
            Ok(Ok(scalars)) => Ok(scalars.join("\n")),
            Ok(Err(error)) if error.is_recoverable() => {
                Err(format!("[ATOM_BULK_OVERFLOW] {}", error.message()))
            }
            Ok(Err(error)) => Err(error.message()),
            Err(_) => Err("[ATOM_BULK_PANIC] Internal panic in the bulk engine".to_string()),
        },
    )
}

/// # Safety
/// `o` must come from one of the functions above and be freed exactly once.
#[no_mangle]
pub unsafe extern "C" fn atom_ffi_free(o: AtomOut) {
    if !o.ptr.is_null() {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
            o.ptr, o.len,
        )));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &str) -> AtomStr {
        AtomStr {
            ptr: v.as_ptr(),
            len: v.len(),
        }
    }

    fn take(o: AtomOut) -> (bool, String) {
        let text = unsafe {
            String::from_utf8_lossy(std::slice::from_raw_parts(o.ptr, o.len)).into_owned()
        };
        let ok = o.ok;
        unsafe { atom_ffi_free(o) };
        (ok, text)
    }

    #[test]
    fn answers_as_the_engine_does() {
        assert_eq!(
            take(unsafe { atom_ffi_add(s("0.1"), s("0.2")) }),
            (true, "0.3".into())
        );
        assert_eq!(
            take(unsafe { atom_ffi_cmp(s("2"), s("10")) }),
            (true, "-1".into())
        );
        let values = [s("1.5"), s("2.5"), s("3")];
        assert_eq!(
            take(unsafe { atom_ffi_sum(values.as_ptr(), 3) }),
            (true, "7".into())
        );
        assert!(take(unsafe { atom_ffi_sum(std::ptr::null(), 0) }).0);
    }

    #[test]
    fn reports_errors_in_the_engine_s_words() {
        let (ok, message) = take(unsafe { atom_ffi_add(s("x"), s("1")) });
        assert!(!ok);
        assert_eq!(message, atom_engine::add("x", "1").unwrap_err());
        let bytes = [0xff_u8, 0xfe];
        let bad = AtomStr {
            ptr: bytes.as_ptr(),
            len: 2,
        };
        assert_eq!(
            take(unsafe { atom_ffi_add(bad, s("1")) }),
            (false, "Invalid decimal: not UTF-8".into())
        );
    }
}
