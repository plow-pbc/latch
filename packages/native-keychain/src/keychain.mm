// One generic password in the macOS Keychain, through SecItem, with an access
// group — the API surface Electron's safeStorage cannot reach. Three functions,
// no state, no policy: which service/account/group to use is the caller's
// decision (and a frozen constant in @domo/device-core, for the reasons its
// comment gives). Read, write, probe — no delete: destroying a vault key is
// not an operation anything owns, so the boundary does not offer it.
//
// Every function takes (service, account, accessGroup); accessGroup may be ""
// to mean "no group" — that is what lets the same binary be probed in a build
// that has no keychain-access-groups entitlement.
//
// Error contract: a missing item is `null`/`false`, never a throw. Everything
// else throws an Error whose `code` property is the OSStatus, so the caller
// can tell "no entitlement" (errSecMissingEntitlement, -34018) from real
// failures and fall back to another provider.
#include <napi.h>
#import <Foundation/Foundation.h>
#import <Security/Security.h>

namespace {

// -34018: the caller lacks the keychain-access-groups (or application
// identifier) entitlement for the group it asked for. Not in every SDK header
// under a usable name, so pinned here.
constexpr OSStatus kMissingEntitlement = -34018;

NSString* ToNSString(const Napi::Value& v) {
  const std::string s = v.As<Napi::String>().Utf8Value();
  return [NSString stringWithUTF8String:s.c_str()];
}

// The query every call starts from. Data-protection keychain on purpose: it is
// the modern store SecItem access groups are defined for, and it never shows
// the legacy "wants to use your confidential information" dialogs.
NSMutableDictionary* BaseQuery(NSString* service, NSString* account, NSString* group) {
  NSMutableDictionary* q = [NSMutableDictionary dictionary];
  q[(__bridge id)kSecClass] = (__bridge id)kSecClassGenericPassword;
  q[(__bridge id)kSecAttrService] = service;
  if (account.length > 0) q[(__bridge id)kSecAttrAccount] = account;
  if (group.length > 0) q[(__bridge id)kSecAttrAccessGroup] = group;
  q[(__bridge id)kSecUseDataProtectionKeychain] = @YES;
  return q;
}

Napi::Error StatusError(Napi::Env env, OSStatus status, const char* what) {
  Napi::Error err = Napi::Error::New(env, std::string(what) + " failed (OSStatus " + std::to_string(status) + ")");
  err.Set("code", Napi::Number::New(env, status));
  return err;
}

// get(service, account, accessGroup) -> string | null
Napi::Value Get(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  NSMutableDictionary* q = BaseQuery(ToNSString(info[0]), ToNSString(info[1]), ToNSString(info[2]));
  q[(__bridge id)kSecReturnData] = @YES;
  q[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
  CFTypeRef out = nullptr;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)q, &out);
  if (status == errSecItemNotFound) return env.Null();
  if (status != errSecSuccess) throw StatusError(env, status, "SecItemCopyMatching");
  NSData* data = (__bridge_transfer NSData*)out;
  return Napi::String::New(env, static_cast<const char*>(data.bytes), data.length);
}

// set(service, account, accessGroup, value) -> undefined. Upserts.
Napi::Value Set(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  NSString* service = ToNSString(info[0]);
  NSString* account = ToNSString(info[1]);
  NSString* group = ToNSString(info[2]);
  const std::string value = info[3].As<Napi::String>().Utf8Value();
  NSData* data = [NSData dataWithBytes:value.data() length:value.size()];

  NSMutableDictionary* find = BaseQuery(service, account, group);
  NSDictionary* change = @{(__bridge id)kSecValueData : data};
  OSStatus status = SecItemUpdate((__bridge CFDictionaryRef)find, (__bridge CFDictionaryRef)change);
  if (status == errSecItemNotFound) {
    NSMutableDictionary* add = BaseQuery(service, account, group);
    add[(__bridge id)kSecValueData] = data;
    add[(__bridge id)kSecAttrAccessible] = (__bridge id)kSecAttrAccessibleAfterFirstUnlock;
    status = SecItemAdd((__bridge CFDictionaryRef)add, nullptr);
  }
  if (status != errSecSuccess) throw StatusError(env, status, "SecItemAdd/Update");
  return env.Undefined();
}

// probe(service, accessGroup) -> "ok" | "missing-entitlement" | "unavailable"
// A read that expects to find nothing: errSecItemNotFound proves the keychain
// answered for that group, which is all availability means.
Napi::Value Probe(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  NSMutableDictionary* q = BaseQuery(ToNSString(info[0]), @"", ToNSString(info[1]));
  q[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
  CFTypeRef out = nullptr;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)q, &out);
  if (out) CFRelease(out);
  if (status == errSecSuccess || status == errSecItemNotFound) return Napi::String::New(env, "ok");
  if (status == kMissingEntitlement) return Napi::String::New(env, "missing-entitlement");
  return Napi::String::New(env, "unavailable");
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("get", Napi::Function::New(env, Get));
  exports.Set("set", Napi::Function::New(env, Set));
  exports.Set("probe", Napi::Function::New(env, Probe));
  return exports;
}

NODE_API_MODULE(keychain, Init)

}  // namespace
