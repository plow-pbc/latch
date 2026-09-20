/**
 * User-facing setup queries shared by the typed main process and the plain-JS
 * renderer fixtures. Gatekeeper capability payloads stay in main; this module
 * owns only safe display metadata and plugin dependencies.
 */
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
];

/** Queries whose complete plugin dependency set exists in this inventory. */
export function queriesForPlugins(pluginNames) {
  const available = new Set(pluginNames);
  return ONBOARDING_QUERIES.filter(({ plugins }) =>
    plugins.length > 0 && plugins.every((plugin) => available.has(plugin))
  );
}
