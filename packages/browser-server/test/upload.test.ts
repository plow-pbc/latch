import { describe, expect, it, vi } from "vitest";
import { Frame, Page } from "./fillProbe.js";
import { Session } from "../src/session.js";

const base = {
  action: "upload",
  selector: "input[type=file]",
  path: "/Users/o/clip.mov",
  frame: 1,
  frame_token: "doc-1",
  origins: ["pizza.example"],
};

function setup() {
  const trace: string[] = [];
  const top = new Frame(trace, { nodes: {} });
  const inner = new Frame(trace);
  const waitForSelector = vi.spyOn(inner, "waitForSelector");
  const setInputFiles = vi.spyOn(inner.handle, "setInputFiles");
  return { session: new Session(new Page(inner, [top])), waitForSelector, setInputFiles };
}

describe("upload", () => {
  // #163: the page's own button opens the native picker; the input behind it
  // is usually hidden, so it is waited for attached, not visible.
  it("sets the file on the input in the frame the device checked", async () => {
    const { session, waitForSelector, setInputFiles } = setup();

    const result = await session.handle(base);

    expect(result).toEqual({ ok: true, frame: 1 });
    expect(waitForSelector).toHaveBeenCalledWith("input[type=file]", expect.objectContaining({ state: "attached" }));
    expect(setInputFiles).toHaveBeenCalledWith("/Users/o/clip.mov", expect.anything());
  });

  it("gives nothing to a document swapped in after its origin was checked", async () => {
    const { session, setInputFiles } = setup();

    const result = await session.handle({ ...base, frame_token: "doc-before" });

    expect(result).toEqual({ ok: false, mask: "moved", frame: 1 });
    expect(setInputFiles).not.toHaveBeenCalled();
  });

  // A page can plant whatever token it likes, so a matching token does not
  // prove this is the document whose origin was checked; the frame's url does.
  it("gives nothing to a frame now on an unapproved origin, even with a matching token", async () => {
    const { session, setInputFiles } = setup();

    const result = await session.handle({ ...base, origins: ["elsewhere.example"] });

    expect(result).toEqual({ ok: false, mask: "moved", frame: 1 });
    expect(setInputFiles).not.toHaveBeenCalled();
  });

  it("says which selector it could not find", async () => {
    const { session } = setup();

    await expect(session.handle({ ...base, frame: 0 })).rejects.toThrow("selector not found: input[type=file]");
  });
});
