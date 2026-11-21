// C ABI of crates/atom-ffi (atom-engine), as the JSI module calls it.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  const uint8_t* ptr;
  size_t len;
} AtomStr;

typedef struct {
  bool ok;
  uint8_t* ptr;
  size_t len;
} AtomOut;

AtomOut atom_ffi_add(AtomStr a, AtomStr b);
AtomOut atom_ffi_sub(AtomStr a, AtomStr b);
AtomOut atom_ffi_mul(AtomStr a, AtomStr b);
AtomOut atom_ffi_div(AtomStr a, AtomStr b, uint32_t precision, AtomStr mode);
AtomOut atom_ffi_rem(AtomStr a, AtomStr b);
AtomOut atom_ffi_pow(AtomStr a, int32_t exp, uint32_t precision, AtomStr mode);
AtomOut atom_ffi_sqrt(AtomStr a, uint32_t precision);
AtomOut atom_ffi_sum(const AtomStr* values, size_t count);
AtomOut atom_ffi_dot(const AtomStr* a, size_t a_count, const AtomStr* b, size_t b_count);
AtomOut atom_ffi_cmp(AtomStr a, AtomStr b);
AtomOut atom_ffi_run_bulk(const int64_t* values, size_t value_count, uint32_t rows,
                          const int32_t* program, size_t program_count);
void atom_ffi_free(AtomOut out);

#ifdef __cplusplus
}
#endif
