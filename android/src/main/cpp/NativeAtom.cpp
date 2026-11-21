#include "NativeAtom.h"

#include <cmath>
#include <cstring>
#include <limits>
#include <optional>
#include <thread>
#include <utility>

#include "atom_ffi.h"

namespace facebook::react {

namespace {

// The largest precision the engine accepts from N-API (a u32): anything else
// is refused here rather than wrapped. The engine bounds the work itself.
constexpr double kMaxU32 = 4294967295.0;

AtomStr view(const std::string& s) {
  return AtomStr{reinterpret_cast<const uint8_t*>(s.data()), s.size()};
}

std::vector<AtomStr> views(const std::vector<std::string>& values) {
  std::vector<AtomStr> out;
  out.reserve(values.size());
  for (const auto& v : values) {
    out.push_back(view(v));
  }
  return out;
}

struct Taken {
  bool ok;
  std::string text;
};

Taken take(AtomOut out) {
  Taken t{out.ok, std::string(reinterpret_cast<const char*>(out.ptr), out.len)};
  atom_ffi_free(out);
  return t;
}

std::string orThrow(jsi::Runtime& rt, AtomOut out) {
  auto t = take(out);
  if (!t.ok) {
    throw jsi::JSError(rt, t.text);
  }
  return t.text;
}

std::optional<uint32_t> asU32(double value) {
  if (!(value >= 0 && value <= kMaxU32) || std::floor(value) != value) {
    return std::nullopt;
  }
  return static_cast<uint32_t>(value);
}

std::optional<int32_t> asI32(double value) {
  if (!(value >= std::numeric_limits<int32_t>::min() && value <= std::numeric_limits<int32_t>::max()) ||
      std::floor(value) != value) {
    return std::nullopt;
  }
  return static_cast<int32_t>(value);
}

uint32_t u32OrThrow(jsi::Runtime& rt, double value, const char* what) {
  auto v = asU32(value);
  if (!v) {
    throw jsi::JSError(rt, std::string(what) + " must be an integer in [0, 4294967295]");
  }
  return *v;
}

std::vector<std::string> lines(const std::string& text) {
  std::vector<std::string> out;
  if (text.empty()) {
    return out;
  }
  size_t start = 0;
  while (true) {
    size_t end = text.find('\n', start);
    out.push_back(text.substr(start, end == std::string::npos ? std::string::npos : end - start));
    if (end == std::string::npos) {
      return out;
    }
    start = end + 1;
  }
}

/// A typed array's elements, in place: its kind checked by element size and
/// constructor, its extent checked against the buffer it views.
template <typename T>
std::pair<const T*, size_t> typedArray(jsi::Runtime& rt, const jsi::Object& array, const char* kind) {
  auto ctor = array.getProperty(rt, "constructor");
  bool named = ctor.isObject() &&
      ctor.asObject(rt).getProperty(rt, "name").isString() &&
      ctor.asObject(rt).getProperty(rt, "name").asString(rt).utf8(rt) == kind;
  auto buffer = array.getProperty(rt, "buffer");
  if (!named || !buffer.isObject() || !buffer.asObject(rt).isArrayBuffer(rt)) {
    throw jsi::JSError(rt, std::string("expected a ") + kind);
  }
  auto arrayBuffer = buffer.asObject(rt).getArrayBuffer(rt);
  double offset = array.getProperty(rt, "byteOffset").asNumber();
  double length = array.getProperty(rt, "length").asNumber();
  size_t size = arrayBuffer.size(rt);
  if (offset < 0 || length < 0 || offset + length * sizeof(T) > static_cast<double>(size)) {
    throw jsi::JSError(rt, std::string("a ") + kind + " beyond its buffer");
  }
  auto base = arrayBuffer.data(rt) + static_cast<size_t>(offset);
  return {reinterpret_cast<const T*>(base), static_cast<size_t>(length)};
}

/// Runs `work` on a worker thread and settles `promise` with its result; the
/// inputs are owned by `work`, nothing JSI is touched off the JS thread.
template <typename Work>
void offThread(AsyncPromise<std::vector<std::string>> promise, Work work) {
  std::thread([promise, work = std::move(work)]() mutable {
    auto t = work();
    if (t.ok) {
      promise.resolve(lines(t.text));
    } else {
      promise.reject(Error(t.text));
    }
  }).detach();
}

} // namespace

NativeAtom::NativeAtom(std::shared_ptr<CallInvoker> jsInvoker)
    : NativeAtomCxxSpec(jsInvoker), jsInvoker_(std::move(jsInvoker)) {}

std::string NativeAtom::add(jsi::Runtime& rt, std::string a, std::string b) {
  return orThrow(rt, atom_ffi_add(view(a), view(b)));
}

std::string NativeAtom::sub(jsi::Runtime& rt, std::string a, std::string b) {
  return orThrow(rt, atom_ffi_sub(view(a), view(b)));
}

std::string NativeAtom::mul(jsi::Runtime& rt, std::string a, std::string b) {
  return orThrow(rt, atom_ffi_mul(view(a), view(b)));
}

std::string NativeAtom::div(jsi::Runtime& rt, std::string a, std::string b, double precision, std::string mode) {
  return orThrow(rt, atom_ffi_div(view(a), view(b), u32OrThrow(rt, precision, "precision"), view(mode)));
}

std::string NativeAtom::rem(jsi::Runtime& rt, std::string a, std::string b) {
  return orThrow(rt, atom_ffi_rem(view(a), view(b)));
}

std::string NativeAtom::pow(jsi::Runtime& rt, std::string a, double exp, double precision, std::string mode) {
  auto e = asI32(exp);
  if (!e) {
    throw jsi::JSError(rt, "exp must be a 32-bit integer");
  }
  return orThrow(rt, atom_ffi_pow(view(a), *e, u32OrThrow(rt, precision, "precision"), view(mode)));
}

std::string NativeAtom::sqrt(jsi::Runtime& rt, std::string a, double precision) {
  return orThrow(rt, atom_ffi_sqrt(view(a), u32OrThrow(rt, precision, "precision")));
}

std::string NativeAtom::sum(jsi::Runtime& rt, std::vector<std::string> values) {
  auto v = views(values);
  return orThrow(rt, atom_ffi_sum(v.data(), v.size()));
}

std::string NativeAtom::dot(jsi::Runtime& rt, std::vector<std::string> a, std::vector<std::string> b) {
  auto va = views(a);
  auto vb = views(b);
  return orThrow(rt, atom_ffi_dot(va.data(), va.size(), vb.data(), vb.size()));
}

double NativeAtom::cmp(jsi::Runtime& rt, std::string a, std::string b) {
  return std::stod(orThrow(rt, atom_ffi_cmp(view(a), view(b))));
}

std::vector<std::string> NativeAtom::runBulk(jsi::Runtime& rt, jsi::Object values, double rows, jsi::Object program) {
  auto [data, count] = typedArray<int64_t>(rt, values, "BigInt64Array");
  auto [code, codeCount] = typedArray<int32_t>(rt, program, "Int32Array");
  return lines(orThrow(rt, atom_ffi_run_bulk(data, count, u32OrThrow(rt, rows, "rows"), code, codeCount)));
}

AsyncPromise<std::vector<std::string>> NativeAtom::runBulkAsync(
    jsi::Runtime& rt, jsi::Object values, double rows, jsi::Object program) {
  AsyncPromise<std::vector<std::string>> promise(rt, jsInvoker_);
  // Copied on the JS thread: the arrays may change once this returns.
  auto [data, count] = typedArray<int64_t>(rt, values, "BigInt64Array");
  auto [code, codeCount] = typedArray<int32_t>(rt, program, "Int32Array");
  auto r = asU32(rows);
  if (!r) {
    promise.reject(Error("rows must be an integer in [0, 4294967295]"));
    return promise;
  }
  std::vector<int64_t> column(data, data + count);
  std::vector<int32_t> bytecode(code, code + codeCount);
  offThread(promise, [column = std::move(column), bytecode = std::move(bytecode), rowCount = *r]() {
    return take(atom_ffi_run_bulk(column.data(), column.size(), rowCount, bytecode.data(), bytecode.size()));
  });
  return promise;
}

} // namespace facebook::react
