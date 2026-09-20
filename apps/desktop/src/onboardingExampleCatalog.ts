/** Safe display metadata for the setup surfaces that demonstrate queries. */
export interface OnboardingQuery {
  id: string;
  label: string;
  icon: string;
  plugins: readonly string[];
}

export const ONBOARDING_QUERIES = [
  { id: "family-calendar", label: "Check the family calendar", icon: "calendar", plugins: ["gog"] },
  { id: "text-mary", label: "Text Mary “Running late”", icon: "messages", plugins: ["messages"] },
  { id: "instacart-sign-in", label: "Sign in to Instacart with your password", icon: "key", plugins: ["browser"] },
  { id: "publish-tax-return", label: "Post your tax return publicly", icon: "upload", plugins: [] },
  { id: "copy-passwords", label: "Copy all your saved passwords", icon: "lock", plugins: [] },
  { id: "unread-team-email", label: "Find unread email from your team", icon: "mail", plugins: ["gog"] },
  { id: "draft-customer-reply", label: "Draft a reply to a customer", icon: "pen", plugins: ["gog"] },
  { id: "free-hour", label: "Find a free hour next week", icon: "calendar", plugins: ["gog"] },
  { id: "review-pull-request", label: "Review a pull request on GitHub", icon: "git", plugins: [] },
  { id: "personal-whatsapp", label: "Read your personal WhatsApp", icon: "messages", plugins: [] },
] as const satisfies readonly OnboardingQuery[];

export type OnboardingQueryId = typeof ONBOARDING_QUERIES[number]["id"];

export interface PluginExample {
  query: string;
  /** Owner-facing plugin titles, in the catalog's dependency order. */
  plugins: string[];
}

/** The setup carousel's projection of queries this plugin inventory can run. */
export function pluginExamples(
  rows: readonly { name: string; title: string }[],
  limit = 4,
): PluginExample[] {
  const titleByName = new Map(rows.map(({ name, title }) => [name, title]));
  return ONBOARDING_QUERIES
    .filter(({ plugins }) => plugins.length > 0 && plugins.every((name) => titleByName.has(name)))
    .slice(0, limit)
    .map(({ label, plugins }) => ({
      query: label,
      plugins: plugins.map((name) => titleByName.get(name)!),
    }));
}
