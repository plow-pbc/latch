import { describe, expect, it } from "vitest";
import { googleCapabilityBadges } from "../src/connectorBadges.js";

const grants = [
  { read: false, write: false, mail: [], calendar: [] },
  { read: true, write: false, mail: ["Mail: read"], calendar: ["Calendar: read"] },
  { read: false, write: true, mail: ["Mail: write"], calendar: ["Calendar: write"] },
  { read: true, write: true, mail: ["Mail: read", "Mail: write"], calendar: ["Calendar: read", "Calendar: write"] },
];

describe("connected Google account badges", () => {
  it.each(grants.flatMap((mail) => grants.map((calendar) => ({
    capabilities: { mail_read: mail.read, mail_write: mail.write, calendar_read: calendar.read, calendar_write: calendar.write },
    badges: [...mail.mail, ...calendar.calendar],
  }))))("shows $badges for $capabilities", ({ capabilities, badges }) => {
    expect(googleCapabilityBadges(capabilities)).toEqual(badges);
  });
});
