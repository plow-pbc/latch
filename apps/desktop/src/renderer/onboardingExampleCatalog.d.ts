export type OnboardingQueryId =
  | "family-calendar"
  | "text-mary"
  | "instacart-sign-in"
  | "publish-tax-return"
  | "copy-passwords"
  | "unread-team-email"
  | "draft-customer-reply"
  | "free-hour"
  | "review-pull-request"
  | "personal-whatsapp";

export interface OnboardingQuery {
  id: OnboardingQueryId;
  label: string;
  icon: string;
  plugins: readonly string[];
}

export const ONBOARDING_QUERIES: readonly OnboardingQuery[];
export function queriesForPlugins(pluginNames: readonly string[]): OnboardingQuery[];
