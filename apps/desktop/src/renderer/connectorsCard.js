import { el, icon } from "./dom.js";

function actionButton(text, className, onClick, disabled = false) {
  const node = el("button", {
    class: className,
    text,
    attrs: { type: "button" },
  });
  node.disabled = disabled;
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

/** The Google account card shared by setup and Settings. */
export function googleConnectorCard(state, actions) {
  const google = state.google;
  const disabled = state.busy === true;
  const header = el("div", { class: "provider-head" }, [
    el("span", { class: "brandmark bg-google", text: "G", attrs: { "aria-hidden": "true" } }),
    el("span", { class: "pname", text: "Google" }),
  ]);

  if (google.accounts.length === 0) {
    const connecting = google.connecting === true;
    const connect = actionButton(
      connecting ? "Connecting…" : state.loading ? "Checking…" : "Connect",
      "provider-connect",
      disabled ? null : actions.connect,
      disabled,
    );
    if (!connecting && !state.loading) connect.prepend(icon("plus", { strokeWidth: "1.9" }));
    header.append(connect);
    return el("div", { class: "provider-group" }, [header]);
  }

  const rows = google.accounts.map((account) => {
    const controls = [];
    if (account.isDefault) {
      controls.push(el("span", { class: "adefault", text: "Default" }));
    } else {
      controls.push(actionButton(
        "Set default",
        "aset-default",
        disabled ? null : () => actions.setDefault(account.email),
        disabled,
      ));
    }
    const remove = actionButton(
      "",
      "acct-remove",
      disabled ? null : () => actions.disconnect(account.email),
      disabled,
    );
    remove.setAttribute("aria-label", "Remove Google account");
    remove.append(icon("close", { strokeWidth: "1.8" }));
    controls.push(remove);
    return el("div", { class: "acct-row" }, [
      // Server data is assigned through textContent by el().
      el("span", { class: "alabel", text: account.email }),
      ...controls,
    ]);
  });

  const connecting = google.connecting === true;
  const add = actionButton(
    connecting ? "Connecting…" : "Add another Google account",
    "add-another",
    disabled ? null : actions.connect,
    disabled,
  );
  if (!connecting) add.prepend(icon("plus", { strokeWidth: "1.7" }));

  return el("div", { class: "provider-group connected" }, [
    header,
    el("div", { class: "connected-body" }, [
      el("div", { class: "acct-list" }, rows),
      add,
    ]),
  ]);
}
