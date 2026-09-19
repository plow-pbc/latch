import { describe, expect, it } from "vitest";
import { VaultImportRequest } from "../src/vaultImportRequest.js";

describe("VaultImportRequest", () => {
  it("hands an onboarding import request to the main window exactly once", () => {
    const request = new VaultImportRequest();

    expect(request.take()).toBe(false);
    request.openAfterOnboarding();
    expect(request.take()).toBe(true);
    expect(request.take()).toBe(false);
  });

  it("coalesces repeated requests before the main window consumes them", () => {
    const request = new VaultImportRequest();

    request.openAfterOnboarding();
    request.openAfterOnboarding();

    expect(request.take()).toBe(true);
    expect(request.take()).toBe(false);
  });
});
