//! N-API binding for the bulk VM.
//!
//! Deliberately thin: the typed arrays arrive as slices — a pointer and a
//! length, measured at about a microsecond whether they hold a thousand values
//! or ten million — and go straight to [`atom_engine::bulk::run`]. Any work done
//! here would be work done per crossing, which is the cost this whole path
//! exists to avoid.

use atom_engine::bulk;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::panic::{catch_unwind, AssertUnwindSafe};

/// Run a bulk program over a resident column buffer.
///
/// `values` holds every column laid end to end, `rows` values each, followed by
/// the scalar literals the program refers to by absolute index. `program` is
/// six-word bytecode. Returns the scalars the program emitted, in order.
///
/// An overflow of the 128-bit working width is reported with a message opening
/// `[ATOM_BULK_OVERFLOW]`, which is the caller's signal to re-run the same
/// program on the BigInt executor rather than to give up: the fast path is
/// allowed to be too narrow, never to be wrong.
#[napi]
pub fn run_bulk(values: BigInt64Array, rows: u32, program: Int32Array) -> Result<Vec<String>> {
    guarded(|| bulk::run(&values, rows as usize, &program))
}

/// A panic becomes a thrown error here: a plain `#[napi]` function does not
/// catch one, and unwinding into the N-API frame aborts the whole process.
fn guarded<F>(run: F) -> Result<Vec<String>>
where
    F: FnOnce() -> std::result::Result<Vec<String>, bulk::BulkError>,
{
    match catch_unwind(AssertUnwindSafe(run)) {
        Ok(Ok(out)) => Ok(out),
        Ok(Err(error)) => {
            let message = error.message();
            Err(Error::from_reason(if error.is_recoverable() {
                format!("[ATOM_BULK_OVERFLOW] {message}")
            } else {
                message
            }))
        }
        Err(_) => Err(Error::from_reason(
            "[ATOM_BULK_PANIC] Internal panic in the bulk engine",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_panic_becomes_an_error_instead_of_unwinding_into_node() {
        let error = guarded(|| panic!("forced")).unwrap_err();
        assert!(error.reason.contains("ATOM_BULK_PANIC"), "{}", error.reason);
    }

    #[test]
    fn an_overflow_keeps_the_marker_the_caller_retries_on() {
        let error = guarded(|| Err(bulk::BulkError::Overflow("a test"))).unwrap_err();
        assert!(
            error.reason.starts_with("[ATOM_BULK_OVERFLOW]"),
            "{}",
            error.reason
        );
    }
}
