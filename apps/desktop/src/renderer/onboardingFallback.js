export const FALLBACK_STATE = Object.freeze({
  step: "welcome",
  message: "",
  noteKind: "error",
  busy: false,
});

export const ONBOARDING_FAILURE_MESSAGE =
  "Something went wrong talking to the app. Try again.";

export function resolveOnboardingState(current, next) {
  return next ?? current ?? FALLBACK_STATE;
}

export function failedOnboardingState(current) {
  return {
    ...(current ?? FALLBACK_STATE),
    busy: false,
    message: ONBOARDING_FAILURE_MESSAGE,
    noteKind: "error",
  };
}
