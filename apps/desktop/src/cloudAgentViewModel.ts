/** Pure cloud-agent presentation decisions, shared with the sandboxed renderer. */

const CLOUD_HTTP_REASONS = new Set([
  "bad request",
  "unauthorized",
  "forbidden",
  "not found",
  "method not allowed",
  "not acceptable",
  "request timeout",
  "conflict",
  "gone",
  "unprocessable entity",
  "too many requests",
  "internal server error",
  "not implemented",
  "bad gateway",
  "service unavailable",
  "gateway timeout",
]);

/** Replace bare HTTP failures with useful copy while retaining specific errors. */
export function cloudErrorCopy(message: string): string {
  const reason = String(message ?? "").trim().replace(/[.!]$/, "").toLowerCase();
  if (
    CLOUD_HTTP_REASONS.has(reason) ||
    /^(?:plow returned|http(?: error)?) \d{3}$/.test(reason)
  ) {
    return "Plow couldn't complete that request. Try again.";
  }
  return message;
}

export interface CloudProviderPickerViewModel {
  mode: "ready" | "blocked" | "banner";
  heading: string | null;
  message: string | null;
}

/** Decide whether the provider picker renders normally, blocks, or warns. */
export function cloudProviderPickerViewModel(
  cloudProviders: string[] | null,
  cloudProvidersError: string | null,
): CloudProviderPickerViewModel {
  const error = cloudProvidersError ? cloudErrorCopy(cloudProvidersError) : null;
  if (cloudProviders === null) {
    return {
      mode: "blocked",
      heading: "Agent types could not be loaded",
      message: error ?? "Agent types couldn't be loaded yet. Try again.",
    };
  }
  if (cloudProviders.length === 0) {
    return {
      mode: "blocked",
      heading: "No agent types are available",
      message: error ?? "Plow has no cloud agent types available right now.",
    };
  }
  if (error) {
    return {
      mode: "banner",
      heading: "Agent types could not be refreshed",
      message: error,
    };
  }
  return { mode: "ready", heading: null, message: null };
}
