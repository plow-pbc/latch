/**
 * One-shot handoff from first-run setup to the Browser Vault's existing
 * import sheet. Main owns this flag because setup and the main app are
 * different renderer windows: the request can be made before the main window
 * exists, and is consumed only after its Vault pane is ready.
 */
export class VaultImportRequest {
  private requested = false;

  openAfterOnboarding(): void {
    this.requested = true;
  }

  pending(): boolean {
    return this.requested;
  }

  acknowledge(): void {
    this.requested = false;
  }
}
