/* What every pane in this window builds with: one element helper, and one
   icon registry with one constructor. */

export function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  for (const c of children) if (c) node.appendChild(c);
  return node;
}

/** The Plow mark, in a 400×400 box: setup draws it large, the main window's
    titlebar small. */
export const PLW_PATH =
  "M64.2891 6.03791C103.801 -2.33144 140.954 15.1702 152.051 56.9783L152.059 56.9705C163.194 98.9657 146.53 157.832 93.5537 167.899C82.3869 170.025 67.326 171.372 53.1455 170.259V396.001L4 395.954V84.8739C4.57639 47.1219 27.183 13.9013 64.2891 6.03791ZM135.946 194.909V332.057C136.211 340.271 142.121 344.787 149.122 346.5L149.13 346.492C150.843 346.912 153.701 347.192 155.469 347.192H164.098V395.945H153.709C120.777 396.934 91.746 371.249 87.1982 338.986C87.1671 338.41 87.1278 337.827 87.0889 337.251C86.5126 328.827 86.3027 320.379 86.3027 311.939V194.909H135.946ZM396.003 328.515C396.003 344.125 391.035 355.422 387.889 361.23C367.751 398.383 319.82 406.581 286.584 381.441C261.104 401.224 224.177 400.905 200.13 379.386C190.162 370.463 177.688 354.425 177.688 332.93V194.909H226.459C226.459 231.447 226.451 293.231 226.459 323.867C226.49 329.325 226.747 334.557 230.049 339.142C237.026 348.936 251.137 349.637 258.714 339.944C262.833 333.949 261.868 329.255 262.062 320.037V194.909H311.612C311.612 228.504 311.597 298.183 311.612 324.568C311.628 327.223 311.714 329.909 312.212 332.377C314.463 344.6 330.216 349.723 339.95 341.759C344.038 338.8 347.169 333.84 347.185 329.114C347.27 287.188 347.192 41.4011 347.216 4.06819H396.003V328.515ZM197.996 22.5194C236.8 -9.91499 297.01 1.78684 321.571 45.6815C340.884 78.9335 332.536 123.257 303.389 148.069H303.381L303.271 148.163C269 178.48 214.395 174.851 185.785 138.711C157.51 103.902 163.055 50.7341 197.996 22.5194ZM83.1182 51.6688C68.011 51.5365 58.6272 60.6846 54.7959 74.5428C53.6434 78.6847 53.1611 82.9903 53.1533 87.2957V123.249C61.1118 124.759 69.7794 125.507 77.0137 124.674V124.681C95.9831 122.782 107.617 107.662 107.695 85.7225C107.765 66.4379 98.8794 51.8011 83.1182 51.6688ZM284.582 95.1746C291.972 70.7904 269.958 46.6475 245.335 49.7459L245.202 49.7615C217.55 53.4598 202.98 88.5723 222.16 110.053C242.142 132.895 276.125 123.49 284.582 95.1746Z";

/* Every glyph in the window, as shapes rather than markup: nothing here is
   ever set through innerHTML, so nothing on the wire can inject anything. */
const ICONS = {
  command: [["path", { d: "m4 17 6-6-6-6" }], ["path", { d: "M12 19h8" }]],
  file: [["path", { d: "M14 3v5h5" }], ["path", { d: "M7 3h8l5 5v11a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" }]],
  access: [["path", { d: "M12 3 4 6v6c0 5 3.5 7.5 8 9 4.5-1.5 8-4 8-9V6z" }]],
  agent: [["path", { d: "M4 8h16v12H4z" }], ["path", { d: "M12 8V4" }]],
  info: [["path", { d: "M12 2v10" }], ["path", { d: "M18.4 6.6a9 9 0 1 1-12.8 0" }]],
  browser: [["path", { d: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z" }], ["path", { d: "M3 12h18" }],
            ["path", { d: "M12 3a14 14 0 0 1 0 18" }], ["path", { d: "M12 3a14 14 0 0 0 0 18" }]],

  // The Vault tab's set, from the design file.
  key: [["circle", { cx: "8", cy: "15", r: "4" }], ["path", { d: "M10.8 12.2L20 3" }],
        ["path", { d: "M17 6l2.5 2.5" }], ["path", { d: "M15 8l2.5 2.5" }]],
  card: [["rect", { x: "2.5", y: "5", width: "19", height: "14", rx: "2.5" }],
         ["path", { d: "M2.5 9.5h19" }], ["path", { d: "M6 15h4" }]],
  user: [["circle", { cx: "12", cy: "8", r: "4" }], ["path", { d: "M5 20c0-3.3 3.1-5 7-5s7 1.7 7 5" }]],
  note: [["path", { d: "M6 3h9l4 4v14H6z" }], ["path", { d: "M14 3v5h5" }], ["path", { d: "M9 13h7M9 17h5" }]],
  chevron: [["path", { d: "M8 10l4 4 4-4" }]],
  eye: [["path", { d: "M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" }], ["circle", { cx: "12", cy: "12", r: "3" }]],
  eyeOff: [["path", { d: "M17.9 17.9A10.4 10.4 0 0 1 12 19c-7 0-11-7-11-7a19.6 19.6 0 0 1 5.1-5.9M9.9 4.2A10.6 10.6 0 0 1 12 4c7 0 11 7 11 7a19.7 19.7 0 0 1-2.3 3.3M9.9 9.9a3 3 0 0 0 4.2 4.2" }],
           ["path", { d: "M1 1l22 22" }]],
  shield: [["path", { d: "M12 3l7 4v6c0 4-3 6.5-7 8-4-1.5-7-4-7-8V7z" }]],
  generate: [["path", { d: "M21 12a9 9 0 1 1-2.6-6.4" }], ["path", { d: "M21 3v5h-5" }]],
  plus: [["path", { d: "M12 5v14M5 12h14" }]],
  close: [["path", { d: "M18 6L6 18M6 6l12 12" }]],
  search: [["circle", { cx: "11", cy: "11", r: "7" }], ["path", { d: "m20 20-3.5-3.5" }]],
  arrowBack: [["path", { d: "M15 18l-6-6 6-6" }]],
  arrowNext: [["path", { d: "M9 18l6-6-6-6" }]],
  desktop: [["rect", { x: "2.5", y: "4", width: "19", height: "12", rx: "2" }],
            ["path", { d: "M8.5 20h7M12 16v4" }]],
  sliders: [["path", { d: "M5 7h14M5 12h14M5 17h14" }],
            ["circle", { cx: "9", cy: "7", r: "2.1" }],
            ["circle", { cx: "15", cy: "12", r: "2.1" }],
            ["circle", { cx: "8", cy: "17", r: "2.1" }]],
  shieldCheck: [["path", { d: "M12 3l7 4v6c0 4-3 6.5-7 8-4-1.5-7-4-7-8V7z" }],
                ["path", { d: "M9.2 12.4l1.9 1.9 3.7-4" }]],
  lock: [["rect", { x: "5", y: "11", width: "14", height: "9", rx: "2" }],
         ["path", { d: "M8 11V8a4 4 0 0 1 8 0v3" }]],
  copy: [["rect", { x: "9", y: "9", width: "11", height: "11", rx: "2.5" }],
         ["path", { d: "M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" }]],
  checkmark: [["path", { d: "M20 6L9 17l-5-5" }]],
  messages: [["path", { d: "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" }]],
  // The Import sheet's arrow-into-tray.
  intake: [["path", { d: "M12 3v11" }], ["path", { d: "m7.5 10.5 4.5 4.5 4.5-4.5" }],
           ["path", { d: "M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" }]],

  // The Full Disk Access grant panel's pair (fdapanel.js). arrowUp is drawn
  // FILLED (PermissionFlow's arrowshape.up.fill) via icon()'s fill option.
  arrowUp: [["path", { d: "M12 2.5 L20.5 11.5 H15.5 V21 H8.5 V11.5 H3.5 Z" }]],
  // The Capabilities banner's warning triangle.
  warning: [["path", { d: "M12 3.5 L21.5 20 H2.5 Z" }], ["path", { d: "M12 9.5v4.5" }], ["path", { d: "M12 17h.01" }]],
  // The Permissions section's nudge: the same arrow with a wider head and a
  // longer tail of the same width, so it reads at 14px.
  nudgeArrow: [["path", { d: "M12 0.5 L23 12 H15.5 V23.5 H8.5 V12 H1 Z" }]],
  hand: [["path", { d: "M9 12V5a1.4 1.4 0 0 1 2.8 0v5.5" }],
         ["path", { d: "M11.8 10.5V4.4a1.4 1.4 0 0 1 2.8 0V11" }],
         ["path", { d: "M14.6 11V6.4a1.4 1.4 0 0 1 2.8 0v7.1c0 3.6-2.4 6-6 6h-.8c-2 0-3.6-.9-4.7-2.4l-2.3-3.3a1.7 1.7 0 0 1 2.7-2L9 14.5" }]],
  calendar: [["rect", { x: "3", y: "5", width: "18", height: "16", rx: "3" }], ["path", { d: "M3 10h18M8 3v4M16 3v4" }]],
  mail: [["rect", { x: "3", y: "5", width: "18", height: "14", rx: "3" }], ["path", { d: "M4 7l8 6 8-6" }]],
  pen: [["path", { d: "M4 20l4-1 11-11-3-3L5 16l-1 4z" }]],
  git: [["circle", { cx: "6", cy: "6", r: "2" }], ["circle", { cx: "6", cy: "18", r: "2" }],
        ["circle", { cx: "18", cy: "12", r: "2" }], ["path", { d: "M6 8v8M8 6h4a4 4 0 0 1 4 4" }]],
  upload: [["path", { d: "M12 16V4M7 9l5-5 5 5M4 20h16" }]],

  // The main window's section nav, and Audit's decision marks.
  activity: [["path", { d: "M3 12h4l3-7 4 14 3-7h4" }]],
  plug: [["path", { d: "M9 3v5M15 3v5" }], ["path", { d: "M6 8h12v3a6 6 0 0 1-12 0z" }], ["path", { d: "M12 17v4" }]],
  clock: [["circle", { cx: "12", cy: "12", r: "9" }], ["path", { d: "M12 7v5l3 2" }]],
  ring: [["circle", { cx: "12", cy: "12", r: "8" }]],
};

/**
 * One glyph. `class` defaults to the stroked-line-art class the audit and
 * agent panes style; the Vault tab passes its own stroke width because its
 * design draws the same shapes a little lighter. `fill: true` draws a solid
 * shape in currentColor instead of stroked line art (the grant panel's
 * arrow).
 */
export function icon(name, opts = {}) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", opts.class ?? "ico");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", opts.fill ? "currentColor" : "none");
  if (!opts.fill) {
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
  }
  if (opts.strokeWidth) svg.setAttribute("stroke-width", opts.strokeWidth);
  for (const [tag, attrs] of ICONS[name] ?? ICONS.info) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.appendChild(node);
  }
  return svg;
}

/** The on/off switch (switch.css) around a checkbox `box`: the input stays
 *  the control — check it, disable it, listen to it — and the track and knob
 *  draw its state. `attrs` go on the label (a title, say). */
export function switchEl(box, attrs) {
  // Announced as the switch it looks like ("on"/"off"), not a checkbox.
  box.setAttribute("role", "switch");
  return el("label", { class: "switch", attrs }, [
    box,
    el("span", { class: "track", attrs: { "aria-hidden": "true" } }),
    el("span", { class: "knob", attrs: { "aria-hidden": "true" } }),
  ]);
}
