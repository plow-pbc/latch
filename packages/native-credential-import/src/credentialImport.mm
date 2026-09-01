/**
 * The N-API half of credential exchange. Everything Apple-specific lives in
 * the app's Swift shim (apps/desktop/native/credential-import.swift), because
 * ASCredentialImportManager is Swift-only API; this file only loads that shim
 * with dlopen and turns its one C callback into a promise.
 *
 * Split this way on purpose: node-gyp cannot drive swiftc, and the shim's OS
 * floor (macOS 26) must never decide whether THIS addon loads — the addon
 * loads everywhere, answers osSupported() honestly, and a missing or too-old
 * anything comes back as a rejected promise with the reason, never a crash.
 *
 * The JSON crossing here carries the owner's passwords. It goes to exactly one
 * place (the resolved promise) and the intermediate C buffer is zeroed before
 * it is freed; nothing here logs, throws, or stores any part of it.
 */
#include <napi.h>

#include <dlfcn.h>
#include <cstdlib>
#include <cstring>
#include <string>

#import <Foundation/Foundation.h>

namespace {

typedef int32_t (*SupportedFn)(void);
typedef void (*DoneFn)(void* ctx, const char* json, const char* error);
typedef void (*ImportFn)(const char* token, void* ctx, DoneFn done);

struct Shim {
  SupportedFn supported = nullptr;
  ImportFn import = nullptr;
};

/**
 * dlopen the Swift shim, once. One shim per process is the real shape (the
 * path never changes within a run), so a single cached handle is enough; a
 * failed load is reported each time rather than cached, because the caller's
 * remedy (a rebuild dropping the dylib in place) can land mid-process.
 */
Shim* loadShim(const std::string& path, std::string& error) {
  static Shim shim;
  static std::string loadedPath;
  if (!loadedPath.empty()) {
    if (loadedPath == path) return &shim;
    error = "the credential-import shim was already loaded from a different path";
    return nullptr;
  }
  void* handle = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
  if (handle == nullptr) {
    const char* why = dlerror();
    error = std::string("could not load the credential-import shim: ") + (why ? why : "dlopen failed");
    return nullptr;
  }
  shim.supported = reinterpret_cast<SupportedFn>(dlsym(handle, "domo_cx_supported"));
  shim.import = reinterpret_cast<ImportFn>(dlsym(handle, "domo_cx_import"));
  if (shim.supported == nullptr || shim.import == nullptr) {
    dlclose(handle);
    shim = Shim{};
    error = "the credential-import shim is missing its entry points";
    return nullptr;
  }
  loadedPath = path;
  return &shim;
}

/** What the shim answered, carried from its thread to the JS thread. */
struct Outcome {
  char* json;
  char* error;
};

struct Pending {
  Napi::ThreadSafeFunction tsfn;
  Napi::Promise::Deferred deferred;
  explicit Pending(Napi::Env env) : deferred(Napi::Promise::Deferred::New(env)) {}
};

/** The shim's single callback — any thread. Copies the answer, hops to the
 * JS thread, settles the promise, scrubs, and tears everything down. */
void onDone(void* ctx, const char* json, const char* error) {
  auto* pending = static_cast<Pending*>(ctx);
  auto* outcome = new Outcome{json ? strdup(json) : nullptr, error ? strdup(error) : nullptr};
  // A local copy of the handle: the lambda deletes `pending` on the JS thread,
  // and that can run before the Release below on this one.
  Napi::ThreadSafeFunction tsfn = pending->tsfn;
  napi_status status = tsfn.BlockingCall(outcome, [pending](Napi::Env env, Napi::Function, Outcome* o) {
    if (o->json != nullptr) {
      pending->deferred.Resolve(Napi::String::New(env, o->json));
    } else {
      pending->deferred.Reject(
          Napi::Error::New(env, o->error ? o->error : "credential import failed").Value());
    }
    if (o->json != nullptr) memset(o->json, 0, strlen(o->json));
    free(o->json);
    free(o->error);
    delete o;
    delete pending;
  });
  if (status != napi_ok) {
    // The environment is going away; nothing to settle against. Scrub anyway.
    if (outcome->json != nullptr) memset(outcome->json, 0, strlen(outcome->json));
    free(outcome->json);
    free(outcome->error);
    delete outcome;
  }
  tsfn.Release();
}

/** Whether this Mac's OS has the credential-exchange API at all (macOS 26+).
 * Asked separately from the shim so the answer exists even when the shim was
 * never built — the caller words its message on this distinction. */
Napi::Value OsSupported(const Napi::CallbackInfo& info) {
  NSOperatingSystemVersion floor = {26, 0, 0};
  bool ok = [[NSProcessInfo processInfo] isOperatingSystemAtLeastVersion:floor];
  return Napi::Boolean::New(info.Env(), ok);
}

/** importCredentials(shimPath, token) -> Promise<wire JSON string>. */
Napi::Value ImportCredentials(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
    Napi::TypeError::New(env, "importCredentials(shimPath, token)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string path = info[0].As<Napi::String>();
  std::string token = info[1].As<Napi::String>();

  auto rejected = [&env](const std::string& why) {
    auto deferred = Napi::Promise::Deferred::New(env);
    deferred.Reject(Napi::Error::New(env, why).Value());
    return deferred.Promise();
  };

  std::string error;
  Shim* shim = loadShim(path, error);
  if (shim == nullptr) return rejected(error);
  if (shim->supported() == 0) {
    return rejected("receiving passwords this way needs macOS 26 or later");
  }

  auto* pending = new Pending(env);
  pending->tsfn = Napi::ThreadSafeFunction::New(
      env, Napi::Function::New(env, [](const Napi::CallbackInfo&) {}), "domoCredentialImport", 0, 1);
  shim->import(token.c_str(), pending, onDone);
  return pending->deferred.Promise();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("osSupported", Napi::Function::New(env, OsSupported));
  exports.Set("importCredentials", Napi::Function::New(env, ImportCredentials));
  return exports;
}

}  // namespace

NODE_API_MODULE(credential_import, Init)
