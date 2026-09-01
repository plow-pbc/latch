/**
 * What the ported response listener keeps, and who it hands it to — run directly
 * (no Python, no browser), the successor to the `describe.skipIf(!havePython())`
 * block that drove failedRequestProbe.py. The device-layer half (re-strip,
 * host-only projection, approved origins, the audit) stays in
 * browserSessions.test.ts against the fake server.
 */
import { describe, expect, it } from "vitest";
import { feed, newSession, pair, StubResponse, type Envelope } from "./failedProbe.js";
import type { RequestLike, ResponseLike } from "../src/index.js";

describe("the response listener in the ported server", () => {
  it("listens on the context, so a popup's refusals count too", () => {
    const { page } = newSession();
    expect(page.ctx.listeners).toEqual(["request", "response"]);
  });

  it("keeps the origin that refused and nothing a site could put a token in", () => {
    const { session, page } = newSession();
    const env = feed(session, page, [
      pair({
        status: 429,
        url: "https://user:pw@signin.example/reset/TOKEN?tx=StateProperties=SECRET",
        method: "POST",
        headers: { "retry-after": "30", server: "cloudfront" },
        page: "https://pizza.example/checkout",
      }),
    ]);
    expect(env.failed_requests).toEqual([
      {
        status: 429,
        method: "POST",
        origin: "https://signin.example",
        initiator: "https://pizza.example",
        retry_after: "30",
        server: "cloudfront",
      },
    ]);
  });

  it("drops a top-level navigation; a frame's document load names nobody", () => {
    const { session, page } = newSession();
    const env = feed(session, page, [
      pair({ status: 429, url: "https://pizza.example/checkout", navigation: true, page: "https://offsite.example/lander" }),
      pair({ status: 403, url: "https://payframe.example/pay", navigation: true, page: "about:blank", embedder: "https://pizza.example/checkout" }),
      pair({ status: 410, url: "https://pizza.example/api/z", navigation: true, page: "https://offsite.example/embed", embedder: "https://pizza.example/checkout" }),
      pair({ status: 404, url: "https://pizza.example/api/x", page: "https://offsite.example/lander" }),
    ]);
    expect((env.failed_requests ?? []).map((r) => [r.status, r.initiator])).toEqual([
      [404, "https://offsite.example"],
      [410, ""],
      [403, ""],
    ]);
  });

  it("forgets a request the moment it comes back fine", () => {
    const { session, page } = newSession();
    const p = pair({ status: 200, url: "https://pizza.example/ok", page: "https://pizza.example/" });
    (page.ctx.request as (x: RequestLike) => void)(p.req);
    (page.ctx.response as (x: ResponseLike) => void)(p.resp);
    expect(session.rememberedRequestCount()).toBe(0);
  });

  it("reads who asked when the request was MADE, not when it was answered", () => {
    const { session, page } = newSession();
    const resp = new StubResponse({ status: 429, url: "https://pizza.example/api/x", page: "https://offsite.example/lander" });
    // Note the request while its frame is offsite, then move the frame to an
    // approved origin before the answer arrives.
    let frameUrl = "https://offsite.example/lander";
    const req = {
      frame: () => ({ url: () => frameUrl, parentFrame: () => null }),
      isNavigationRequest: () => false,
      method: () => "GET",
    } as unknown as RequestLike;
    Object.defineProperty(resp, "req", { value: req });
    (page.ctx.request as (x: RequestLike) => void)(req);
    frameUrl = "https://pizza.example/checkout";
    (page.ctx.response as (x: ResponseLike) => void)(resp);
    const env = session.replyWithFailures({}) as Envelope;
    expect(env.failed_requests?.[0]).toMatchObject({
      origin: "https://pizza.example",
      initiator: "https://offsite.example",
    });
  });

  it("names nobody for a request it never saw asked", () => {
    const { session, page } = newSession();
    const resp = new StubResponse({ status: 403, url: "https://pizza.example/api/y", page: "https://pizza.example/" });
    (page.ctx.response as (x: ResponseLike) => void)(resp);
    const env = session.replyWithFailures({}) as Envelope;
    expect(env.failed_requests?.[0]).toMatchObject({ initiator: "" });
  });

  it("names nobody when the frame will not answer, or answers with nothing", () => {
    const { session, page } = newSession();
    const env = feed(session, page, [
      pair({ status: 410, url: "https://pizza.example/api/sw", blindFrame: true }),
      pair({ status: 429, url: "https://pizza.example/api/x", page: "about:blank" }),
      pair({ status: 403, url: "https://pizza.example/api/y", page: "blob:https://pizza.example/8f2c" }),
    ]);
    expect((env.failed_requests ?? []).map((r) => [r.status, r.initiator])).toEqual([
      [403, ""],
      [429, ""],
      [410, ""],
    ]);
  });

  it("hands each refusal over once, so the next reply is not told again", () => {
    const { session, page } = newSession();
    feed(session, page, [pair({ status: 401, url: "https://pizza.example/x", page: "https://pizza.example/" })]);
    const again = session.replyWithFailures({}) as Envelope;
    expect(again.failed_requests).toBeUndefined();
  });

  it("keeps nothing for a page that worked, redirects included", () => {
    const { session, page } = newSession();
    const env = feed(session, page, [
      pair({ status: 200, url: "https://pizza.example/a" }),
      pair({ status: 302, url: "https://pizza.example/b" }),
      pair({ status: 304, url: "https://pizza.example/c" }),
    ]);
    expect(env.failed_requests).toBeUndefined();
  });

  it("keeps the most recent few, most recent first", () => {
    const { session, page } = newSession();
    const env = feed(
      session,
      page,
      Array.from({ length: 9 }, (_v, i) =>
        pair({ status: 400 + i, url: `https://pizza.example/x${i}`, page: "https://pizza.example/" }),
      ),
    );
    expect((env.failed_requests ?? []).map((r) => r.status)).toEqual([408, 407, 406, 405, 404]);
  });

  it("drops a response that will not answer, and keeps the next one", () => {
    const { session, page } = newSession();
    const env = feed(session, page, [
      pair({ status: 429, url: "https://pizza.example/boom", hostileHeaders: true, page: "https://pizza.example/" }),
      pair({ status: 401, url: "https://pizza.example/ok", page: "https://pizza.example/" }),
    ]);
    expect((env.failed_requests ?? []).map((r) => r.status)).toEqual([401]);
  });
});
