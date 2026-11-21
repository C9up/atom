// atom's Rust engine as a C++ TurboModule, shared by Android and iOS.
#pragma once

#include <AppSpecsJSI.h>

#include <memory>
#include <string>
#include <vector>

namespace facebook::react {

class NativeAtom : public NativeAtomCxxSpec<NativeAtom> {
 public:
  explicit NativeAtom(std::shared_ptr<CallInvoker> jsInvoker);

  std::string add(jsi::Runtime& rt, std::string a, std::string b);
  std::string sub(jsi::Runtime& rt, std::string a, std::string b);
  std::string mul(jsi::Runtime& rt, std::string a, std::string b);
  std::string div(jsi::Runtime& rt, std::string a, std::string b, double precision, std::string mode);
  std::string rem(jsi::Runtime& rt, std::string a, std::string b);
  std::string pow(jsi::Runtime& rt, std::string a, double exp, double precision, std::string mode);
  std::string sqrt(jsi::Runtime& rt, std::string a, double precision);
  std::string sum(jsi::Runtime& rt, std::vector<std::string> values);
  std::string dot(jsi::Runtime& rt, std::vector<std::string> a, std::vector<std::string> b);
  double cmp(jsi::Runtime& rt, std::string a, std::string b);
  std::vector<std::string> runBulk(jsi::Runtime& rt, jsi::Object values, double rows, jsi::Object program);

  AsyncPromise<std::vector<std::string>> runBulkAsync(jsi::Runtime& rt, jsi::Object values, double rows, jsi::Object program);

 private:
  std::shared_ptr<CallInvoker> jsInvoker_;
};

} // namespace facebook::react
