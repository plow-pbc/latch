import { describe, expect, it } from "vitest";
import { VaultImportRequest } from "../src/vaultImportRequest.js";

describe("VaultImportRequest", () => {
  it("keeps an onboarding import request pending until the live pane acknowledges it", () => {
    const request = new VaultImportRequest();

    expect(request.pending()).toBe(false);
    request.openAfterOnboarding();
    expect(request.pending()).toBe(true);
    expect(request.pending()).toBe(true);
    request.acknowledge();
    expect(request.pending()).toBe(false);
  });

  it("coalesces repeated requests before the main window consumes them", () => {
    const request = new VaultImportRequest();

    request.openAfterOnboarding();
    request.openAfterOnboarding();

    expect(request.pending()).toBe(true);
    request.acknowledge();
    expect(request.pending()).toBe(false);
  });
});
