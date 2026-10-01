import type { ConnectorAccount } from "./plowApi.js";

export function googleCapabilityBadges(capabilities: ConnectorAccount["capabilities"]): string[] {
  const badges: string[] = [];
  if (capabilities.mail_read) {
    badges.push("Mail: read");
  }
  if (capabilities.mail_write) {
    badges.push("Mail: write");
  }
  if (capabilities.calendar_read) {
    badges.push("Calendar: read");
  }
  if (capabilities.calendar_write) {
    badges.push("Calendar: write");
  }
  return badges;
}
