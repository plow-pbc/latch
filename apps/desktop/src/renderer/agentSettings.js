/** The two platform settings supported by the desktop. */
export function agentSettingsForm(document, settings, save) {
  const form = document.createElement("form");
  const capLabel = document.createElement("label");
  capLabel.className = "field";
  capLabel.textContent = "Daily payment limit (USD; blank means uncapped)";
  const cap = document.createElement("input");
  cap.className = "text";
  cap.type = "number";
  cap.min = "0";
  cap.step = "any";
  cap.value = settings.daily_payment_cap_usd.value ?? "";
  cap.setAttribute("aria-label", "Daily payment limit");
  capLabel.append(cap);
  const verboseLabel = document.createElement("label");
  verboseLabel.className = "field";
  verboseLabel.textContent = "Verbose agent output";
  const verbose = document.createElement("input");
  verbose.type = "checkbox";
  verbose.checked = settings.verbose_output.value;
  verbose.setAttribute("aria-label", "Verbose agent output");
  verboseLabel.append(verbose);
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "btn primary";
  submit.textContent = "Save settings";
  const notice = document.createElement("p");
  notice.setAttribute("role", "status");
  form.append(capLabel, verboseLabel, submit, notice);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!cap.reportValidity()) return;
    submit.disabled = true;
    try {
      const result = await save({
        daily_payment_cap_usd: cap.value === "" ? null : cap.valueAsNumber,
        verbose_output: verbose.checked,
      });
      if (result?.error) throw new Error(result.error);
      notice.textContent = "Settings saved.";
    } catch (error) {
      notice.textContent = error.message || "Settings could not be saved.";
    } finally {
      submit.disabled = false;
    }
  });
  return form;
}
