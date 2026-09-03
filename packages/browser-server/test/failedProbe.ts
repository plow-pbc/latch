/**
 * Drive the REAL response listener of the ported Session against stub Playwright
 * objects — the TypeScript successor to e2e/fixtures/failedRequestProbe.py.
 *
 * Session subscribes its `request`/`response` listeners on the context at
 * construction; the stub context captures them, and `feed` invokes them in the
 * real order (request first, then response). Node's Playwright shape is
 * method-based (`response.status()`, `response.headers()`), which is the only
 * change from the Python fixture. A body is never read — the stub throws if one
 * is asked for.
 */
import {
  Session,
  type ContextLike,
  type FrameLike,
  type PageLike,
  type RequestLike,
  type ResponseLike,
} from "../src/index.js";

type Handler = (x: never) => void;

class StubContext implements ContextLike {
  listeners: string[] = [];
  request?: Handler;
  response?: Handler;
  pageList: PageLike[] = [];
  on(event: "request" | "response", handler: Handler): void {
    this.listeners.push(event);
    if (event === "request") this.request = handler;
    else this.response = handler;
  }
  pages(): PageLike[] {
    return this.pageList;
  }
}

class StubPage implements PageLike {
  ctx = new StubContext();
  constructor() {
    this.ctx.pageList.push(this);
  }
  url(): string {
    return "https://pizza.example/checkout";
  }
  async title(): Promise<string> {
    return "checkout";
  }
  frames(): FrameLike[] {
    return [];
  }
  context(): ContextLike {
    return this.ctx;
  }
  async evaluate(): Promise<unknown> {
    return "doc-1";
  }
  locator() {
    return { evaluate: async () => "doc-1" };
  }
  async goto(): Promise<unknown> {
    return undefined;
  }
  async goBack(): Promise<unknown> {
    return undefined;
  }
  async screenshot(): Promise<Buffer> {
    return Buffer.alloc(0);
  }
  async innerText(): Promise<string> {
    return "";
  }
  async bringToFront(): Promise<void> {}
  async waitForTimeout(): Promise<void> {}
}

interface ReqOpts {
  method?: string;
  page?: string;
  navigation?: boolean;
  embedder?: string;
  /** Playwright will not name a frame for this request (a service worker). */
  blindFrame?: boolean;
}

class StubRequest implements RequestLike {
  constructor(private o: ReqOpts) {}
  frame(): FrameLike {
    if (this.o.blindFrame) throw new Error("no frame for this request");
    const parent =
      this.o.embedder === undefined
        ? null
        : ({ url: () => this.o.embedder!, parentFrame: () => null } as unknown as FrameLike);
    const page = this.o.page ?? "";
    return { url: () => page, parentFrame: () => parent } as unknown as FrameLike;
  }
  isNavigationRequest(): boolean {
    return this.o.navigation ?? false;
  }
  method(): string {
    return this.o.method ?? "GET";
  }
}

interface RespOpts extends ReqOpts {
  status: number;
  url: string;
  headers?: Record<string, string>;
  /** Answering about headers raises — the listener must drop the whole entry. */
  hostileHeaders?: boolean;
}

export class StubResponse implements ResponseLike {
  readonly req: StubRequest;
  constructor(private o: RespOpts) {
    this.req = new StubRequest(o);
  }
  status(): number {
    return this.o.status;
  }
  url(): string {
    return this.o.url;
  }
  request(): RequestLike {
    return this.req;
  }
  headers(): Record<string, string> {
    if (this.o.hostileHeaders) throw new Error("detached");
    return this.o.headers ?? {};
  }
}

export interface Envelope {
  failed_requests?: {
    status: number;
    method: string;
    origin: string;
    initiator: string;
    retry_after?: string;
    server?: string;
  }[];
}

export function newSession(): { session: Session; page: StubPage } {
  const page = new StubPage();
  const session = new Session(page);
  return { session, page };
}

/** Each response as it really happens: the request first, the answer after. */
export function feed(
  session: Session,
  page: StubPage,
  responses: { req: StubRequest; resp?: StubResponse }[],
): Envelope {
  for (const r of responses) {
    (page.ctx.request as (x: RequestLike) => void)(r.req);
    if (r.resp) (page.ctx.response as (x: ResponseLike) => void)(r.resp);
  }
  return session.replyWithFailures({}) as Envelope;
}

/** A response and its request, the common case. */
export function pair(o: RespOpts): { req: StubRequest; resp: StubResponse } {
  const resp = new StubResponse(o);
  return { req: resp.req, resp };
}
