/**
 * The setup screen's two Gatekeeper defaults, offered beside an empty
 * instructions box too (plow#2289). A blank box left people not knowing what
 * to write, and the example in its placeholder can't be taken. Each default
 * fills the box with its preset, to accept or edit. They show only while the
 * box is empty, so a click never replaces instructions someone wrote.
 */
import { el } from "./dom.js";

/** The presets `gatekeeperPresets()` serves, in the order both screens offer them. */
export const GATEKEEPER_DEFAULTS = [["home", "Personal assistant"], ["work", "Executive assistant"]];

/** A "Use a default:" row for `input`; `pick(text)` takes a preset's text. `sync()` re-checks emptiness. */
export function gatekeeperDefaults(input, presets, pick) {
  const row = el("div", { class: "gatekeeper-defaults" }, [
    el("span", { text: "Use a default:" }),
    ...GATEKEEPER_DEFAULTS.map(([key, label]) => {
      const button = el("button", { class: "cap-more", text: label, attrs: { type: "button" } });
      button.addEventListener("click", () => pick(presets[key].text));
      return button;
    }),
  ]);
  const sync = () => {
    row.hidden = input.value.trim() !== "";
  };
  sync();
  return { row, sync };
}
