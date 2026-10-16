import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";

// Goes through the real assets router + Worker (SELF), so it also checks the wrangler.jsonc
// wiring: pages come from public/, API paths hit the Worker first.
// (Cloudflare Access sits in front of both at the edge; it isn't simulated locally.)

const fetchText = async (path: string) => (await SELF.fetch(`https://minty.example.workers.dev${path}`)).text();

// The pages' scripts were inline until security step 4 moved them to files (so the CSP can be
// script-src 'self'). The assertions below are about what a page contains, so `html` is the page
// with those scripts put back where their <script src> tags are, exactly as it was. Only these
// four: other scripts (lock.js, abc.js) were always separate files, and still aren't included.
export const MOVED_SCRIPTS = ["/theme.js", "/app.js", "/connect.js", "/add-user.js"];

const page = async (path: string) => {
  const r = await SELF.fetch(`https://minty.example.workers.dev${path}`);
  let html = (await r.text()).replaceAll("\r\n", "\n");
  if ((r.headers.get("content-type") ?? "").includes("text/html")) {
    for (const src of MOVED_SCRIPTS) {
      const tag = `<script src="${src}"></script>`;
      if (html.includes(tag)) html = html.replace(tag, `<script>\n${await fetchText(src)}</script>`);
    }
  }
  return { status: r.status, type: r.headers.get("content-type") ?? "", html };
};

describe("static pages", () => {
  it("serves the dashboard with its links and no hard-coded people", async () => {
    const { status, type, html } = await page("/");
    expect(status).toBe(200);
    expect(type).toMatch(/text\/html/);
    expect(html).toContain("<title>Minty</title>");
    expect(html).toContain('href="/connect">+ Add account');
    expect(html).toContain('href="/add-user">+ Add user');
    expect(html).not.toContain('data-owner="spouse"');            // person buttons come from /users
    expect(html).toContain("seg.hidden = USERS.length < 2");       // no person switch for one person
    expect(html).not.toMatch(/owner:"spouse"|label: "Spouse"/);   // no built-in spouse, not even in samples
    expect(html).toContain('id="tagBtn"');                         // multi-tag filter
  });

  it("dashboard has the multi-bank filter, fed by /items and sent as item_id", async () => {
    const { html } = await page("/");
    expect(html).toContain('id="bankBtn"');
    expect(html).toContain('fetch("/items")');
    expect(html).toContain('p.append("item_id", id)');
    expect(html).toContain('id="acctBtn"');                        // card/account filter next to it
    expect(html).toContain('fetch("/accounts")');
    expect(html).toContain('p.append("account_id", id)');
    expect(html).toContain("<dt>Card member</dt>");                // Plaid's account_owner, when present
    expect(html).toContain('p.append("card", k)');                 // per-card-member filter
    expect(html).toContain("data-card=");
    expect(html).not.toMatch(/data-bank|value="\d+"/);             // banks are rendered from /items, not hard-coded
  });

  it.each(["/", "/connect", "/add-user"])("%s has the theme toggle and dark palette", async (path) => {
    const { status, html } = await page(path);
    expect(status).toBe(200);
    expect(html).toContain('id="themeToggle"');
    expect(html).toContain(':root[data-theme="dark"]');
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toMatch(/<script>[^<]*minty-theme[^<]*<\/script>\s*<style>/);   // no light flash
  });

  it("opens ABC as a popup on the dashboard (a native dialog, like Inkling's), fed by /benefits", async () => {
    const { html } = await page("/");
    expect(html).toMatch(/<button type="button" class="pill" id="abcOpen" aria-haspopup="dialog" data-open-abc/);
    expect(html).toMatch(/\.pill \{[^}]*border-radius: 999px[^}]*box-shadow:/);           // a raised pill, as on Inkling
    expect(html).toContain('<dialog id="abc" class="abc" aria-labelledby="abcTitle"');
    expect(html).toContain('<form method="dialog" class="abc-close"><button aria-label="Close"');   // the × closes it
    expect(html).toContain('<script src="/abc.js" defer></script>');
    expect(html).toContain('<link rel="stylesheet" href="/abc.css" />');
    expect(html).not.toContain('href="/abc"');                        // no separate page any more

    const js = await page("/abc.js");
    expect(js.status).toBe(200);
    expect(js.html).toContain("dialog.showModal()");
    expect(js.html).toContain("if (e.target === dialog) dialog.close()");   // a click outside closes it
    expect(js.html).toContain('new URLSearchParams(location.search).has("abc")');   // /?abc opens it
    expect(js.html).toContain('fetch("/benefits"');
    expect(js.html).toContain('"/benefits/marks"');
    expect(js.html).toContain('role="checkbox"');                    // ticks for credits outside the card
    expect(js.html).not.toMatch(/Business Platinum|Resy|lululemon/); // benefits come from the API
    expect((await page("/abc.css")).status).toBe(200);
    expect((await SELF.fetch("https://minty.example.workers.dev/benefits")).status).toBe(403);   // in run_worker_first
  });

  it("every page has the Minty favicon and home-screen icon, and the dashboard shows the logo", async () => {
    for (const path of ["/", "/connect", "/add-user"]) {
      const { html } = await page(path);
      expect(html, path).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
      expect(html, path).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    }
    const dash = (await page("/")).html;
    expect(dash).toMatch(/<h1 class="brand"><button[^>]*id="syncBtn"[^>]*><img src="\/favicon.svg" alt="" width="30" height="30" \/><\/button><svg class="wordmark"[^>]*aria-label="Minty"/);
    for (const asset of ["/favicon.svg", "/favicon-32.png", "/apple-touch-icon.png"]) {
      expect((await SELF.fetch(`https://minty.example.workers.dev${asset}`)).status, asset).toBe(200);
    }
  });

  it("clicking the coin reloads and asks for a sync; the count says when more exist and when it last synced", async () => {
    const { html } = await page("/");
    expect(html).toContain('<button type="button" class="coinbtn" id="syncBtn"');
    expect(html).toContain('fetch("/sync-request", { method: "POST" })');
    expect(html).toContain('id="lastSync"');
    expect(html).toContain("latest ${txns.length.toLocaleString()} transactions");
    expect(html).toContain('p.set("before", `${last.date}:${last.id}`)');
    expect(html).toContain('id="moreBtn">Show more');
    expect(html).not.toContain('fetch("/sync"');                          // there is no sync endpoint
    expect((await SELF.fetch("https://minty.example.workers.dev/sync-request")).status).toBe(403);   // in run_worker_first
  });

  it("installs as an app: manifest (fetched with the Access cookie), icons, a shell-only service worker", async () => {
    for (const path of ["/", "/connect", "/add-user"]) {
      const { html } = await page(path);
      expect(html, path).toContain('<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials" />');
      expect(html, path).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    }
    const m = JSON.parse((await page("/manifest.webmanifest")).html);
    expect(m).toMatchObject({ name: "Minty", start_url: "/", scope: "/", display: "standalone" });
    const sizes = m.icons.map((i: any) => `${i.sizes}:${i.purpose}`);
    expect(sizes).toEqual(expect.arrayContaining(["192x192:any", "512x512:any", "512x512:maskable"]));
    for (const i of m.icons) expect((await SELF.fetch(`https://minty.example.workers.dev${i.src}`)).status, i.src).toBe(200);
    const sw = (await page("/sw.js")).html;
    expect(sw).toContain("const SHELL = [");
    expect(sw).toContain('if (e.request.method !== "GET" || !isShell(url)) return;');      // the API is never cached
    expect(sw).not.toMatch(/"\/(transactions|accounts|items|benefits|health|status)"/);
    const dash = (await page("/")).html;
    expect(dash).toContain('navigator.serviceWorker.register("/sw.js")');
    expect(dash).toContain('addEventListener("beforeinstallprompt"');
    expect(dash).toContain("SamsungBrowser");                                            // sent to Chrome, as in GRAZE
    expect(dash).toContain("package=com.android.chrome");
  });

  it("on phones, the filters move into a small strip pinned to the top once the header scrolls away", async () => {
    const { html } = await page("/");
    expect(html).toContain("@media (max-width: 640px) { body > header { position: static; } }");   // the header no longer pins half the screen
    expect(html).toContain('<div class="ministrip" id="miniStrip" role="region" aria-label="Filters" hidden>');
    expect(html).toMatch(/strip\.append\(controls\)/);                                // the same controls, so their state comes along
    expect(html).toMatch(/header\.append\(controls\)/);
    expect(html).toMatch(/header\.style\.minHeight = header\.offsetHeight/);           // the list doesn't jump
    for (const id of ["tagBtn", "bankBtn", "acctBtn", "dateBtn"]) expect(html).toContain(`.ministrip #${id}::before { -webkit-mask-image:`);
  });

  it("dashboard has a Dates menu with quick ranges, like the other filters", async () => {
    const { html } = await page("/");
    expect(html).toContain('id="dateBtn"');
    expect(html).toMatch(/\["datePick", "dateBtn", "dateMenu"\]/);           // opens and closes like Tags / Banks
    for (const r of ["this-month", "last-month", "30", "90", "this-year", "last-year"]) expect(html).toContain(`data-range="${r}"`);
    expect(html).toContain('<input type="date" id="start" />');
    expect(html).toContain('<input type="date" id="end" />');
  });

  it("ABC folds each card and keeps its settings out of the way", async () => {
    const js = (await page("/abc.js")).html;
    expect(js).toContain('<details class="abc-card"');
    expect(js).toContain('<details class="abc-settings"><summary>Card settings</summary>');
    expect(js).toContain('class="src"');                                    // "source" links, not a glyph fonts may lack
    expect(js).not.toContain("ⓘ");
    const css = (await page("/abc.css")).html;
    expect(css).toMatch(/\.abc \.abc-top \{ position: sticky/);            // title, year and × stay in view
  });

  it("dashboard shows a status strip from /health that names the problem and offers the fix", async () => {
    const { html } = await page("/");
    expect(html).toContain('id="health"');
    expect(html).toContain('fetch("/health")');
    expect(html).toContain('href="/connect#reconnect">Reconnect');
    expect(html).toContain('href="/connect">Link again');
    expect(html).toContain("p.error_code");                        // Plaid's code and message, small
    expect(html).toMatch(/setInterval\(\(\) => \{ if \(!document.hidden\) loadHealth\(\)/);
    expect(html).toContain('stalled: "not syncing"');              // the bank filter says so too
    expect(html).not.toMatch(/dismiss/i);                          // stays until fixed
  });

  it("connect page reconnects every bank the dashboard sends there, then re-checks it", async () => {
    const { html } = await page("/connect");
    expect(html).toContain('i.health?.action === "reconnect"');
    expect(html).toContain('fetch("/link/reconnected"');
  });

  it("connect page sends the institution name and can reconnect login_required banks", async () => {
    const { html } = await page("/connect");
    expect(html).toContain('id="reconnect"');
    expect(html).toContain('"/link/token/update"');
    expect(html).toContain("institution_name: metadata?.institution?.name");
  });

  it("add-user page shows setup checks and Cloudflare instructions only", async () => {
    const { html } = await page("/add-user");
    expect(html).toContain('fetch("/status")');
    expect(html).toContain("npx wrangler secret put PLAID_CLIENT_ID_");
    expect(html).toContain("Variables and secrets");
    for (const gone of ["docker", ".env", "Tailscale", "BACKEND"]) expect(html).not.toContain(gone);
  });

  it("connect page capacity bars actually render (the fill span is a block)", async () => {
    const { html } = await page("/connect");
    expect(html).toMatch(/\.cap \.fill \{ display:block;/);   // an inline span ignores width/height
  });

  it("routes API paths to the Worker (Access check applies)", async () => {
    const r = await SELF.fetch("https://minty.example.workers.dev/transactions");
    expect(r.status).toBe(403);
    expect((await SELF.fetch("https://minty.example.workers.dev/healthz")).status).toBe(200);
    expect((await SELF.fetch("https://minty.example.workers.dev/health")).status).toBe(403);   // in run_worker_first
  });
});

describe("limits on the dashboard (docs/security-plan.md, step 2)", () => {
  it("the search box stops at D1's LIKE limit, and a refusal shows its reason instead of sample data", async () => {
    const { html } = await page("/");
    expect(html).toContain('id="q" placeholder="Search" aria-label="Search descriptions and merchants" maxlength="48"');
    expect(html).toContain("if (res.status === 429 || res.status === 422) {");
    expect(html).toContain('notice(d.detail || "Too many requests. Wait a minute and try again.");');
  });
});

describe("connect page Link sessions (docs/security-plan.md, step 3)", () => {
  it("keeps one entry per session, sends only the session to /link/exchange, and cancels on exit", async () => {
    const { html } = await page("/connect");
    expect(html).toContain('const LINK_PREFIX = "minty_link:", TAB_KEY = "minty_link_tab";');
    expect(html).toContain("body: JSON.stringify({ session_id: entry.id, public_token, institution_name: metadata?.institution?.name ?? null })");
    expect(html).toContain('fetch("/link/cancel"');
    expect(html).toContain("if (!finished) cancelSession(entry);");
    expect(html).toContain("const resumable = linkStore.resume();");              // OAuth return, and expired entries swept
    expect(html).not.toMatch(/localStorage\.setItem\("plaid_link_/);            // the old shared keys are only removed
    expect(html).not.toMatch(/owner: forOwner|plaid_account: plaidAccount/);
  });
});

describe("device lock (public/lock.js)", () => {
  it.each(["/", "/connect", "/add-user"])("%s loads the lock render-blocking at the end of <head>, after the page's colours", async (path) => {
    const { html } = await page(path);
    expect(html).toContain('<link rel="stylesheet" href="/lock.css" />\n<script src="/lock.js"></script>\n</head>');
    expect(html.indexOf("/lock.js")).toBeGreaterThan(html.indexOf("</style>"));
  });

  it("is served, on by default where the device can do it, and never talks to the Worker", async () => {
    const js = await page("/lock.js");
    expect(js.status).toBe(200);
    expect(js.html).toContain("isUserVerifyingPlatformAuthenticatorAvailable");      // no authenticator: never locked
    expect(js.html).toContain('userVerification: "required"');
    expect(js.html).toContain('show(st && st.state === "on" ? "unlock" : "setup")');   // unset = offer it
    expect(js.html).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon/);
    const css = await page("/lock.css");
    expect(css.html).toContain("html.minty-locked body > *:not(#minty-lock) { visibility: hidden !important; }");
  });

  it("is in the service worker's shell and shown in Setup checks", async () => {
    expect((await page("/sw.js")).html).toContain('"/lock.js", "/lock.css"');
    const { html } = await page("/add-user");
    expect(html).toContain('id="lockState"');
    expect(html).toContain("MintyLock.turnOff()");
    // The live demo strips it: scripts/build-demo.mjs edit "no device lock" (the build stops if it no longer applies).
  });
});


describe("security headers (docs/security-plan.md, step 4)", () => {
  const raw = async (path: string) => SELF.fetch(`https://minty.example.workers.dev${path}`);
  const csp = (r: Response) => r.headers.get("content-security-policy") ?? "";

  it.each(["/", "/connect", "/add-user"])("%s has no inline script or inline event handler left", async (path) => {
    const html = await (await raw(path)).text();
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);                     // every script is a file
    expect(html).not.toMatch(/\son[a-z]+="/);
  });

  it.each(["/", "/add-user", "/app.js", "/theme.js", "/lock.js", "/abc.css", "/manifest.webmanifest"])("%s gets the strict page policy, enforced", async (path) => {
    const r = await raw(path);
    expect(r.status).toBe(200);
    for (const d of ["default-src 'self'", "script-src 'self';", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "worker-src 'self'", "manifest-src 'self'"])
      expect(csp(r), path).toContain(d);
    expect(csp(r)).not.toContain("cdn.plaid.com");
    expect(r.headers.get("content-security-policy-report-only")).toBeNull();     // enforced, no report-only copy left
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("same-origin");
    expect(r.headers.get("permissions-policy")).toContain("camera=()");
  });

  it("/connect has its own policy, with Plaid Link's script, frame and API hosts only", async () => {
    const r = await raw("/connect");
    const policy = csp(r);
    expect(policy).toContain("script-src 'self' https://cdn.plaid.com/link/v2/stable/link-initialize.js;");
    expect(policy).toContain("frame-src https://cdn.plaid.com/;");
    expect(policy).toContain("connect-src 'self' https://production.plaid.com https://sandbox.plaid.com;");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("unsafe-eval");
    expect(policy.split("default-src").length).toBe(2);                        // one policy, not the page one plus this
    expect(r.headers.get("content-security-policy-report-only")).toBeNull();
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("the Worker's JSON responses may load nothing and can't be framed", async () => {
    for (const path of ["/healthz", "/users"]) {                                 // /users: refused without Access, still JSON
      const r = await raw(path);
      expect(r.headers.get("content-type"), path).toContain("application/json");
      expect(csp(r), path).toBe("default-src 'none'; frame-ancestors 'none'");
      expect(r.headers.get("content-security-policy-report-only"), path).toBeNull();
      expect(r.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(r.headers.get("referrer-policy"), path).toBe("same-origin");
    }
  });

  it("a Worker path with no route falls through to the assets, which apply the page policy", async () => {
    const r = await raw("/link/nope");                                           // run_worker_first, but no route: env.ASSETS.fetch
    expect(csp(r)).toContain("frame-ancestors 'none'");
    expect(csp(r)).toContain("script-src 'self';");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("the headers file isn't served, and every moved script is in the service worker's shell", async () => {
    expect((await raw("/_headers")).status).toBe(404);
    const sw = await (await raw("/sw.js")).text();
    expect(sw).toContain('const CACHE = "minty-fork-v7";');                          // installed apps refresh their copy once (v3: Bills)
    for (const src of MOVED_SCRIPTS) expect(sw, src).toContain(`"${src}"`);
  });
});
