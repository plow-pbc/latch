// Contacts and Calendars consent, asked for IN PROCESS — the only way those
// two can be asked for at all.
//
// `CNContactStore requestAccessForEntityType:` and `EKEventStore
// requestFullAccessToEvents` check the usage description in the CALLING
// process's own bundle before they will show a dialog, and refuse on the spot
// without one. So the request has to come from the app process itself, whose
// bundle carries NSContactsUsageDescription and
// NSCalendarsFullAccessUsageDescription: the packaged app through
// electron-builder's extendInfo, a from-source run through the dev Electron
// bundle patched at build time (apps/desktop/scripts/dev-usage-strings.mjs).
// A bare helper CLI cannot do it, and touching the store does not go through
// this gate either — hence an addon, loaded into Electron's main process.
//
// The dialog names the RESPONSIBLE app (the terminal a from-source run was
// launched from; the app itself when packaged) and the grant is recorded for
// it — which is also what puts the app in the pane's list.
//
// Four functions, no state. Status answers at once; a request runs the
// framework's completion on a worker thread and resolves a promise with the
// status it left behind. Statuses are the host-gate vocabulary: "granted",
// "denied", "not_asked" (macOS has never asked), "unknown".
#include <napi.h>
#import <Contacts/Contacts.h>
#import <EventKit/EventKit.h>
#import <Foundation/Foundation.h>

namespace {

const char* ContactsWord(CNAuthorizationStatus status) {
  switch (status) {
    case CNAuthorizationStatusAuthorized: return "granted";
    case CNAuthorizationStatusNotDetermined: return "not_asked";
    default: return "denied";
  }
}

const char* CalendarsWord(EKAuthorizationStatus status) {
  switch (status) {
    case EKAuthorizationStatusAuthorized: return "granted";
    case EKAuthorizationStatusNotDetermined: return "not_asked";
    default:
      // macOS 14 split the grant into full and write-only; reading events
      // needs full, and write-only is not enough for that.
      if (@available(macOS 14.0, *)) {
        if (status == EKAuthorizationStatusFullAccess) return "granted";
      }
      return "denied";
  }
}

Napi::Value ContactsStatus(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), ContactsWord([CNContactStore authorizationStatusForEntityType:CNEntityTypeContacts]));
}

Napi::Value CalendarsStatus(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), CalendarsWord([EKEventStore authorizationStatusForEntityType:EKEntityTypeEvent]));
}

// A request: raise the dialog, wait for the answer off the main thread, and
// resolve with what macOS then reports. The framework calls its completion
// on a queue of its own; a semaphore holds the worker until it does. Three
// minutes is a person reading a dialog, not a poll.
class RequestWorker : public Napi::AsyncWorker {
 public:
  RequestWorker(Napi::Env env, bool contacts)
      : Napi::AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)), contacts_(contacts) {}

  Napi::Promise Promise() { return deferred_.Promise(); }

  void Execute() override {
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    if (contacts_) {
      CNContactStore* store = [[CNContactStore alloc] init];
      [store requestAccessForEntityType:CNEntityTypeContacts
                      completionHandler:^(BOOL, NSError*) { dispatch_semaphore_signal(done); }];
      dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)180 * NSEC_PER_SEC));
      result_ = ContactsWord([CNContactStore authorizationStatusForEntityType:CNEntityTypeContacts]);
    } else {
      EKEventStore* store = [[EKEventStore alloc] init];
      if (@available(macOS 14.0, *)) {
        [store requestFullAccessToEventsWithCompletion:^(BOOL, NSError*) { dispatch_semaphore_signal(done); }];
      } else {
        [store requestAccessToEntityType:EKEntityTypeEvent
                              completion:^(BOOL, NSError*) { dispatch_semaphore_signal(done); }];
      }
      dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)180 * NSEC_PER_SEC));
      result_ = CalendarsWord([EKEventStore authorizationStatusForEntityType:EKEntityTypeEvent]);
    }
  }

  void OnOK() override { deferred_.Resolve(Napi::String::New(Env(), result_)); }
  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

 private:
  Napi::Promise::Deferred deferred_;
  bool contacts_;
  std::string result_ = "unknown";
};

Napi::Value RequestContacts(const Napi::CallbackInfo& info) {
  auto* worker = new RequestWorker(info.Env(), true);
  worker->Queue();
  return worker->Promise();
}

Napi::Value RequestCalendars(const Napi::CallbackInfo& info) {
  auto* worker = new RequestWorker(info.Env(), false);
  worker->Queue();
  return worker->Promise();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("contactsStatus", Napi::Function::New(env, ContactsStatus));
  exports.Set("calendarsStatus", Napi::Function::New(env, CalendarsStatus));
  exports.Set("requestContacts", Napi::Function::New(env, RequestContacts));
  exports.Set("requestCalendars", Napi::Function::New(env, RequestCalendars));
  return exports;
}

}  // namespace

NODE_API_MODULE(permissions, Init)
