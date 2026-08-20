/**
 * Local pizza-checkout fixture site for the browser integration tier:
 * login form → menu → checkout (card form inside an IFRAME, to exercise
 * frame-targeted fills) → confirmation. `state` records what the site
 * received so tests can prove the real credential arrived on the wire
 * without ever crossing MCP.
 */
import http from "node:http";
import { AddressInfo } from "node:net";

export interface PizzaSiteState {
  loginAttempts: { user: string; pass: string }[];
  orders: { pizza: string; cardNumber: string; cvv: string }[];
}

export interface PizzaSite {
  url: string;
  port: number;
  state: PizzaSiteState;
  close(): Promise<void>;
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

export function createPizzaSite(): Promise<PizzaSite> {
  const state: PizzaSiteState = { loginAttempts: [], orders: [] };
  const sessions = new Set<string>();
  let nextOrder = 1000;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const cookie = req.headers.cookie ?? "";
    const loggedIn = [...sessions].some((s) => cookie.includes(`sid=${s}`));

    const html = (title: string, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(200, { "content-type": "text/html", ...headers });
      res.end(PAGE(title, body));
    };
    const redirect = (to: string, headers: Record<string, string> = {}) => {
      res.writeHead(302, { location: to, ...headers });
      res.end();
    };
    const readBody = (cb: (params: URLSearchParams) => void) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => cb(new URLSearchParams(data)));
    };

    if (req.method === "GET" && url.pathname === "/") {
      html(
        "Slice of Test — Login",
        `<h1>Slice of Test</h1>
         <form method="POST" action="/login">
           <label>Email <input id="user" name="user" type="text"></label>
           <label>Password <input id="pass" name="pass" type="password"></label>
           <button id="login" type="submit">Log in</button>
         </form>`,
      );
    } else if (req.method === "POST" && url.pathname === "/login") {
      readBody((params) => {
        const user = params.get("user") ?? "";
        const pass = params.get("pass") ?? "";
        state.loginAttempts.push({ user, pass });
        if (user === "jon@example.com" && pass === "pizza-time-99") {
          const sid = `s${Math.random().toString(36).slice(2)}`;
          sessions.add(sid);
          redirect("/menu", { "set-cookie": `sid=${sid}; Path=/` });
        } else {
          html("Login failed", `<p id="error">Wrong email or password.</p><a href="/">Try again</a>`);
        }
      });
    } else if (req.method === "GET" && url.pathname === "/menu") {
      if (!loggedIn) return redirect("/");
      html(
        "Menu",
        `<h1>Menu</h1>
         <form method="POST" action="/order">
           <label><input type="radio" name="pizza" value="pepperoni" id="pepperoni"> Pepperoni</label>
           <label><input type="radio" name="pizza" value="margherita" id="margherita"> Margherita</label>
           <button id="order" type="submit">Order</button>
         </form>`,
      );
    } else if (req.method === "POST" && url.pathname === "/order") {
      if (!loggedIn) return redirect("/");
      readBody((params) => {
        redirect(`/checkout?pizza=${encodeURIComponent(params.get("pizza") ?? "")}`);
      });
    } else if (req.method === "GET" && url.pathname === "/checkout") {
      if (!loggedIn) return redirect("/");
      const pizza = url.searchParams.get("pizza") ?? "";
      // The card form lives in an iframe — like real payment widgets.
      html(
        "Checkout",
        `<h1>Checkout — ${pizza}</h1>
         <iframe id="payframe" src="/payframe?pizza=${encodeURIComponent(pizza)}" width="400" height="300"></iframe>`,
      );
    } else if (req.method === "GET" && url.pathname === "/payframe") {
      const pizza = url.searchParams.get("pizza") ?? "";
      html(
        "Payment",
        `<form method="POST" action="/pay" target="_top">
           <input type="hidden" name="pizza" value="${pizza}">
           <label>Card number <input id="card-number" name="number" type="text"></label>
           <label>CVV <input id="card-cvv" name="cvv" type="text"></label>
           <button id="pay" type="submit">Pay</button>
         </form>`,
      );
    } else if (req.method === "POST" && url.pathname === "/pay") {
      readBody((params) => {
        state.orders.push({
          pizza: params.get("pizza") ?? "",
          cardNumber: params.get("number") ?? "",
          cvv: params.get("cvv") ?? "",
        });
        redirect(`/confirm?n=${nextOrder++}`);
      });
    } else if (req.method === "GET" && url.pathname === "/blocked") {
      // The shape the Costco IdP had (issue #88): a real, visible, enabled
      // button with a backdrop over it swallowing pointer events. Playwright's
      // actionability check refuses it; `force` is the honest way through, and
      // the handler reports whether the event the page got was a real one.
      html(
        "Blocked",
        `<h1>Verify</h1>
         <button id="continue" type="button">Update</button>
         <div class="modal-backdrop show"
              style="position:fixed;inset:0;background:rgba(0,0,0,.5)"></div>
         <button id="dismiss" type="button"
                 style="position:fixed;top:0;right:0">Close</button>
         <a id="leave" href="/confirm?n=9" style="position:fixed;bottom:0;left:0">Leave</a>
         <p id="result">no click yet</p>
         <script>
           document.getElementById("continue").addEventListener("click", (e) => {
             document.getElementById("result").textContent =
               "clicked isTrusted=" + e.isTrusted;
           });
           // Dismissable, like the modal it stands in for: the way through is
           // the control that closes it, which a real click reaches.
           document.getElementById("dismiss").addEventListener("click", () => {
             document.querySelector(".modal-backdrop").remove();
           });
         </script>`,
      );
    } else if (req.method === "GET" && url.pathname === "/confirm") {
      html("Confirmed", `<h1 id="confirmed">Order confirmed #${url.searchParams.get("n")}</h1>`);
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        state,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
