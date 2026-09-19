/** Shared states for the browser picker and the offscreen screenshot harness. */
export function onboardingFixtures(now) {
  const displayCode = "Z1SWY";
  const sendTo = "+1 555 987 6543";
  const activation = {
    displayCode,
    sendTo,
    smsBody: `Plow Activate: ${displayCode}`,
    smsUrl: `sms:${sendTo}?&body=Plow%20Activate%3A%20${displayCode}`,
    pollUntil: now + 4 * 60_000 + 30_000,
  };
  const base = {
    message: "",
    noteKind: "error",
    busy: false,
    activation: null,
    activationStale: false,
    telemetryEnabled: true,
    purpose: "",
  };
  const noAgents = { cloudAgents: [], cloudAgentsError: null };
  const elm = {
    cloudAgentsError: null,
    cloudAgents: [{ agentId: "agent_elm", name: "Elm", canMessage: true }],
  };
  // The Plugins tab's state as main answers it (pluginsModel.ts): the shipped
  // plugins as staged, then the browser, and the ordered grants setup walks.
  const fullDisk = {
    id: "full_disk_access",
    title: "Full Disk Access",
    detail: "Drag Plow Latch into the list in System Settings.",
    action: "Grant Full Disk Access",
    waiting: "Waiting for you in System Settings…",
    done: "Granted",
    status: "open",
  };
  const fullDiskMet = { ...fullDisk, status: "met" };
  const fullDiskRelaunch = {
    ...fullDisk,
    detail: "Quit and reopen Plow Latch to finish.",
    action: "Relaunch Plow Latch",
    waiting: "",
    status: "relaunch",
  };
  const google = {
    id: "account:google",
    title: "Google account",
    detail: "Sign in with Google in your browser.",
    action: "Connect Google",
    waiting: "Finish signing in with Google in your browser.",
    done: "Connected",
    status: "open",
  };
  const safari = {
    id: "safari-javascript-from-apple-events",
    title: "Safari",
    detail: "Allow JavaScript from Apple Events — Safari relaunches",
    action: "Enable in Safari",
    waiting: "Turning it on. Safari relaunches.",
    done: "On",
    status: "open",
  };
  const row = (name, title, summary, kind, status, requirements) =>
    ({ name, title, summary, kind, description: null, status, requirements });
  const gmail = "Gmail and Google Calendar";
  const iMessage = "iMessage history";
  /** The four rows, with Gmail's and iMessage's switch states and how this
   * Mac reads Full Disk Access. The browser stays off: Safari still needs it. */
  const rows = (gmailStatus, iMessageStatus, fda) => [
    row("gog", gmail, "Read and draft email; check and book your calendar.", "CLI", gmailStatus, [google]),
    row("messages", iMessage, "Find and read your texts, right on this Mac.", "CLI", iMessageStatus, [fda]),
    row("wiki", "Obsidian-style wiki", "A notebook your agents keep about the people and projects in your life.", "CLI", "ready", []),
    row("browser", "Browser use", "Browse and fill in forms in a private browser, with Safari as a fallback.", "Browser", "off", [fda, safari]),
  ];
  const onlyWiki = { rows: rows("off", "off", fullDisk), grants: [] };
  const picked = {
    rows: rows("needs-setup", "needs-setup", fullDisk),
    grants: [{ ...fullDisk, plugins: [iMessage] }, { ...google, plugins: [gmail] }],
  };
  const fullDiskDone = {
    rows: rows("needs-setup", "ready", fullDiskMet),
    grants: [{ ...fullDiskMet, plugins: [iMessage] }, { ...google, plugins: [gmail] }],
  };
  // The Gatekeeper step's presets as main serves them (gatekeeperPreview.ts),
  // and the verdicts its example decks are rehearsed to read.
  const gatekeeperPresets = {
    home: {
      text:
        "Allow my family assistant to keep our calendar, text family, and order groceries online. " +
        "Never let it share my documents or passwords with anyone.",
      rows: [
        { label: "Check the family calendar", icon: "calendar" },
        { label: "Text Mary \u201cRunning late\u201d", icon: "messages" },
        { label: "Sign in to Instacart with your password", icon: "key" },
        { label: "Post your tax return publicly", icon: "upload" },
        { label: "Copy all your saved passwords", icon: "lock" },
      ],
    },
    work: {
      text:
        "Allow my work assistant to access my email, calendar and GitHub. " +
        "Keep it out of my personal texts and chats.",
      rows: [
        { label: "Find unread email from your team", icon: "mail" },
        { label: "Draft a reply to a customer", icon: "pen" },
        { label: "Find a free hour next week", icon: "calendar" },
        { label: "Review a pull request on GitHub", icon: "git" },
        { label: "Read your personal WhatsApp", icon: "messages" },
      ],
    },
  };
  const customPurpose =
    "Run my errands the way a personal assistant would: book appointments, reorder household " +
    "supplies, answer routine email and keep the family calendar current. Never move money " +
    "or share anything from my documents folder.";
  const allow = (reason) => ({ verdict: "allow", reason });
  const deny = (reason) => ({ verdict: "deny", reason });
  const homeResults = [
    allow("Keeping the family calendar is what you allowed."),
    allow("Texting family is what you allowed."),
    allow("Ordering groceries is allowed. Your Mac types the password; the agent never sees it."),
    deny("You said never to share your documents."),
    deny("You said never to share your passwords."),
  ];
  const workResults = [
    allow("Email is one of the things you allowed."),
    allow("Drafting email is allowed, and nothing is sent."),
    allow("Your calendar is allowed."),
    allow("GitHub is allowed."),
    deny("You kept it out of your personal texts and chats."),
  ];
  const noCredits = homeResults.map(() =>
    ({ verdict: "ask", reason: "insufficient Plow balance", cause: "no_credits" }));
  const relaunchLeft = {
    rows: rows("off", "needs-setup", fullDiskRelaunch),
    grants: [{ ...fullDiskRelaunch, plugins: [iMessage] }],
  };

  return [
    {
      name: "welcome",
      state: { ...base, step: "welcome" },
      cloud: noAgents,
      expect: [
        "Keep your passwords.",
        "Lose the busywork.",
        "Get started",
      ],
      expectFocus: "Get started",
      expectTitle: "Plow Latch. Set Up.",
      expectAriaLabel: "Plow Latch Set Up",
    },
    {
      name: "verify",
      state: { ...base, step: "activate", activation },
      cloud: noAgents,
      expect: [
        "Verify your phone to connect this Mac",
        "Send the message below from the phone number you want to use with Plow",
        displayCode,
        `Plow Activate: ${displayCode}`,
        sendTo,
        "Send to:",
        "Keep this private",
        "Anyone who sends this code from their number can link it to this Plow account",
        "Waiting for your text",
        "Listening for 4:",
        "Open Messages to activate",
        "Continue",
        "Still waiting? Send it again",
      ],
      reject: ["Get a new code", "Use a phone code instead"],
      expectFocus: "Open Messages to activate",
    },
    {
      name: "verify-rearm",
      state: { ...base, step: "activate", activation },
      cloud: noAgents,
      expect: [
        "Verify your phone to connect this Mac",
        "Send the message below from the phone number you want to use with Plow",
        displayCode,
        `Plow Activate: ${displayCode}`,
        sendTo,
        "Send to:",
        "Keep this private",
        "Anyone who sends this code from their number can link it to this Plow account",
        "Waiting for your text",
        "Open Messages to activate",
        "Continue",
        "Still waiting? Send it again",
        "That code still works — send it exactly as shown and this screen will move on by itself.",
      ],
      reject: ["Get a new code", "Use a phone code instead"],
      expectFocus: "Open Messages to activate",
    },
    {
      name: "signed-out-revoke-warning",
      state: {
        ...base,
        step: "welcome",
        message:
          "Signed out on this Mac. Plow could not be reached to revoke the session — revoke it in Plow's account settings.",
      },
      cloud: noAgents,
      expect: [
        "Signed out on this Mac",
        "Plow could not be reached to revoke the session",
        "revoke it in Plow's account settings",
      ],
      expectFocus: "Get started",
    },
    {
      name: "waiting",
      state: { ...base, step: "waiting", activation },
      cloud: noAgents,
      expect: [
        "Verify your phone to connect this Mac",
        displayCode,
        `Plow Activate: ${displayCode}`,
        "Waiting for your text",
        "Listening for 4:",
        "Open Messages to activate",
        "Still waiting? Send it again",
        "Continue",
      ],
      reject: ["Get a new code", "Use a phone code instead"],
      expectFocus: "Open Messages to activate",
    },
    {
      name: "waiting-gave-up",
      state: {
        ...base,
        step: "waiting",
        activation,
        activationStale: true,
        message:
          "We haven't heard from your phone. Send the message exactly as shown — it has to start with “Plow Activate:” — or try again.",
      },
      cloud: noAgents,
      expect: ["Still not signed in", "it has to start with", "Plow Activate:", "Try again"],
      reject: ["Still waiting? Send it again", "Get a new code", "Use a phone code instead"],
      expectFocus: "Open Messages to activate",
    },
    {
      name: "privacy",
      state: { ...base, step: "privacy" },
      cloud: noAgents,
      expect: [
        "Verified. This Mac is linked.",
        "Stay in control of how your AI agents use your data",
        "Your agents can get things done without giving up control of your data",
        "Data stays on your Mac",
        "Your messages, calendar, and logins live on your Mac and reach an agent only through actions you approve",
        "You stay in control",
        "Choose what runs automatically and what needs your approval",
        "The Plow gatekeeper reviews every data request",
        "The Plow adversarial reviewer catches actions that don't look right",
        "Never sold. Never trained on.",
        "Your data isn't sold, stored, or used to train AI models",
        "Continue",
      ],
      reject: ["Back"],
      expectFocus: "Continue",
    },
    {
      name: "gatekeeper-home",
      state: { ...base, step: "gatekeeper", purpose: gatekeeperPresets.home.text },
      cloud: noAgents,
      gatekeeper: { presets: gatekeeperPresets, results: homeResults },
      expect: [
        "Meet the Plow Gatekeeper",
        "Plow's adversarial reviewer protects your data from malicious queries, while allowing your agents to get useful work done.",
        "What access should it allow to your Mac?",
        "Use a default:", "Personal assistant", "Executive assistant",
        ...gatekeeperPresets.home.rows.map((r) => r.label),
        "Continue",
      ],
      expectValues: [gatekeeperPresets.home.text],
      reject: ["Back", "Tap a request", "Name the work", "never sees it"],
      expectFocus: "Continue",
      expectDotCount: 6,
    },
    {
      name: "gatekeeper-work",
      state: { ...base, step: "gatekeeper", purpose: gatekeeperPresets.work.text },
      cloud: noAgents,
      gatekeeper: { presets: gatekeeperPresets, results: workResults },
      expect: ["Meet the Plow Gatekeeper", ...gatekeeperPresets.work.rows.map((r) => r.label), "Continue"],
      expectValues: [gatekeeperPresets.work.text],
      reject: ["Back"],
      expectDotCount: 6,
    },
    {
      // A re-setup opens on the owner's saved draft, which can outgrow the presets' two lines.
      name: "gatekeeper-custom",
      state: { ...base, step: "gatekeeper", purpose: customPurpose },
      cloud: noAgents,
      gatekeeper: { presets: gatekeeperPresets, results: homeResults },
      expectValues: [customPurpose],
      expectDotCount: 6,
    },
    {
      name: "gatekeeper-checking",
      state: { ...base, step: "gatekeeper", purpose: gatekeeperPresets.home.text },
      cloud: noAgents,
      gatekeeper: { presets: gatekeeperPresets, results: "pending" },
      expect: ["Meet the Plow Gatekeeper", ...gatekeeperPresets.home.rows.map((r) => r.label)],
      expectDotCount: 6,
    },
    {
      name: "gatekeeper-stopped",
      state: { ...base, step: "gatekeeper", purpose: gatekeeperPresets.home.text },
      cloud: noAgents,
      gatekeeper: { presets: gatekeeperPresets, results: homeResults },
      click: "Post your tax return publicly",
      expect: ["Post your tax return publicly", "You said never to share your documents."],
      expectDotCount: 6,
    },
    {
      name: "gatekeeper-couldnt-check",
      state: { ...base, step: "gatekeeper", purpose: gatekeeperPresets.home.text },
      cloud: noAgents,
      gatekeeper: { presets: gatekeeperPresets, results: noCredits },
      click: "Check the family calendar",
      expect: ["Check the family calendar", "Your Plow account is out of credits, so the gatekeeper can't review right now."],
      expectDotCount: 6,
    },
    {
      name: "plugins-fresh",
      state: { ...base, step: "plugins" },
      cloud: noAgents,
      plugins: onlyWiki,
      expect: [
        "Choose your plugins",
        "Switch on what your agents can use on this Mac",
        gmail,
        iMessage,
        "Obsidian-style wiki",
        "Browser use",
        "You'll grant next",
        "Nothing to grant. These work as soon as setup finishes.",
        "Share usage data so we can improve Plow",
        "Never your messages or your data",
        "Back",
        "Continue",
      ],
      reject: [`for ${iMessage}`],
      expectFocus: "Continue",
      expectDotCount: 6,
    },
    {
      name: "plugins-picked",
      state: { ...base, step: "plugins" },
      cloud: noAgents,
      plugins: picked,
      expect: [
        "Choose your plugins",
        "You'll grant next",
        "Full Disk Access",
        `for ${iMessage}`,
        "Google account",
        `for ${gmail}`,
        "Share usage data so we can improve Plow",
        "Back",
        "Continue",
      ],
      reject: ["Nothing to grant. These work as soon as setup finishes."],
      expectFocus: "Continue",
      expectDotCount: 6,
    },
    {
      name: "plugins-error",
      state: { ...base, step: "plugins", message: "Something went wrong. Try again.", noteKind: "error" },
      cloud: noAgents,
      plugins: onlyWiki,
      expect: ["Choose your plugins", "Something went wrong. Try again."],
      reject: ["Talking to Plow"],
      expectFocus: "Continue",
      expectDotCount: 6,
    },
    {
      name: "access-ready",
      state: { ...base, step: "access" },
      cloud: noAgents,
      plugins: picked,
      expect: [
        "Grant access",
        "One at a time. Skip anything and it'll wait for you in Settings",
        "Full Disk Access",
        `For ${iMessage}`,
        "Drag Plow Latch into the list in System Settings.",
        "Google account",
        `For ${gmail}`,
        "Sign in with Google in your browser.",
        "Back",
        "Set up all 2",
      ],
      reject: ["Granted"],
      expectFocus: "Set up all 2",
      expectDotCount: 6,
    },
    {
      name: "access-partly",
      state: { ...base, step: "access" },
      cloud: noAgents,
      plugins: fullDiskDone,
      expect: ["Grant access", "Full Disk Access", "Granted", "Google account", "Set up all 1"],
      reject: ["Set up all 2"],
      expectFocus: "Set up all 1",
      expectDotCount: 6,
    },
    {
      name: "access-relaunch",
      state: { ...base, step: "access" },
      cloud: noAgents,
      plugins: relaunchLeft,
      expect: [
        "Grant access",
        "Full Disk Access",
        `For ${iMessage}`,
        "Quit and reopen Plow Latch to finish.",
        "Granted: relaunch to finish",
        "Relaunch to finish",
      ],
      reject: ["Set up all", "Google account"],
      expectFocus: "Relaunch to finish",
      expectDotCount: 6,
    },
    {
      name: "availability",
      state: { ...base, step: "availability" },
      cloud: noAgents,
      expect: [
        "Keep this Mac reachable",
        "Your agents work through this Mac",
        "they can't reach your email, calendar, messages, or browser.",
        "Open Plow Latch when you log in",
        "A restart won't take this Mac off the roster",
        "Keep this Mac awake while plugged in",
        "closing the lid still sleeps it",
        "Back",
        "Continue",
      ],
      reject: ["Only the installed app can add itself as a login item"],
      expectFocus: "Continue",
      expectDotCount: 6,
    },
    {
      name: "availability-from-source",
      state: { ...base, step: "availability" },
      cloud: noAgents,
      launch: { supported: false, openAtLogin: false },
      expect: [
        "Keep this Mac reachable",
        "Open Plow Latch when you log in",
        "Only the installed app can add itself as a login item, so this from-source run can't.",
        "Keep this Mac awake while plugged in",
        "Continue",
      ],
      expectFocus: "Continue",
      expectDotCount: 6,
    },
    {
      name: "done-agent",
      state: { ...base, step: "done" },
      cloud: elm,
      expect: ["You're all set", "Text Elm", "Explore the app"],
    },
    {
      name: "done-noagent",
      state: { ...base, step: "done" },
      cloud: noAgents,
      expect: ["You're all set", "Explore the app"],
      reject: ["Text Elm"],
    },
  ];
}
