// Minty's live demo: the real dashboard (public/) and the real Worker (src/), running in the
// visitor's browser over an in-memory SQLite database (sql.js) with the real migrations and a
// made-up household (demo/data.ts). The page's API calls (fetch("/transactions") and so on) go to
// the Worker's fetch handler here, never to a server; Plaid is blocked; nothing leaves the
// browser, and everything resets on reload. Built by scripts/build-demo.mjs; see docs/demo.md.
//
// This script runs first in <head>, so fetch is patched before the dashboard's own scripts run.
// Their API calls wait until the database is ready.

import worker from "../src/index.ts";
import { markSwept } from "../src/routes/syncrequest.ts";
import { refreshTotals, snapshotBalances } from "../src/audit/totals.ts";
import { demoEnv, generate, statements } from "./data.ts";
import { DemoD1 } from "./d1.js";

/* global __MIGRATIONS__, __API_PATHS__, __SQLJS__ */
const SQLJS = __SQLJS__;
const API = __API_PATHS__.map((p) => (p.endsWith("/*") ? new RegExp(`^${p.slice(0, -2)}/.+$`) : new RegExp(`^${p}$`)));
const isApi = (path) => API.some((re) => re.test(path));

// --- Start downloading the SQLite engine right away (both files checked against pinned hashes).
const wasm = fetch(SQLJS.wasm, { integrity: SQLJS.wasmSri, mode: "cors" }).then((r) => {
  if (!r.ok) throw new Error(`sql.js wasm: HTTP ${r.status}`);
  return r.arrayBuffer();
});
const engine = new Promise((ok, fail) => {
  const s = document.createElement("script");
  Object.assign(s, { src: SQLJS.js, integrity: SQLJS.jsSri, crossOrigin: "anonymous", referrerPolicy: "no-referrer" });
  s.onload = () => ok(window.initSqlJs);
  s.onerror = () => fail(new Error("sql.js didn't load"));
  document.head.append(s);
});

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} };
let env = null;

const ready = (async () => {
  const t0 = performance.now();
  const [initSqlJs, wasmBinary] = await Promise.all([engine, wasm]);
  const SQL = await initSqlJs({ wasmBinary });
  const sql = new SQL.Database();
  sql.run("PRAGMA foreign_keys = ON");
  for (const m of __MIGRATIONS__) sql.exec(m);
  const data = generate(new Date());
  sql.run("BEGIN");
  const cache = new Map();
  for (const [q, params] of statements(data)) {
    let st = cache.get(q);
    if (!st) cache.set(q, (st = sql.prepare(q)));
    st.run(params);
  }
  for (const st of cache.values()) st.free();
  sql.run("COMMIT");
  env = { DB: new DemoD1(sql), ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
          MINTY_DEV_NO_AUTH: "1", PLAID_ENV: "sandbox", ...demoEnv(data) };
  // What the hourly cron prepares for the audit (CFA): today's balances, and the monthly totals.
  await snapshotBalances(env);
  await refreshTotals(env);
  window.__mintyDemo = { ms: Math.round(performance.now() - t0), rows: data.transactions.length };
  return env;
})();
ready.catch((e) => {
  console.error("demo failed to start", e);
  document.addEventListener("DOMContentLoaded", () => toast("The demo couldn't start (the SQLite engine didn't load). Reload to try again.", 0));
});

// --- fetch: API paths go to the Worker in this page; Plaid is blocked; everything else is normal.
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (/(^|\.)plaid\.com$/.test(url.hostname)) throw new TypeError("The demo never calls Plaid.");
  if (url.origin !== location.origin || !isApi(url.pathname)) return realFetch(input, init);
  await ready;
  // The Worker accepts MINTY_DEV_NO_AUTH only for localhost requests: this one never leaves the page.
  const local = new Request(`http://localhost${url.pathname}${url.search}`, {
    method: request.method, headers: request.headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.text(),
  });
  const response = await worker.fetch(local, env, ctx);
  if (request.method === "POST" && url.pathname === "/sync-request") demoSync();
  // A correction on the audit: what the 10-minute cron run would do, at once.
  if (request.method === "PUT" && url.pathname === "/audit/buckets" && response.ok) await refreshTotals(env);
  return response;
};

// --- Clicking the logo records a sync request, as in Minty. Here the "cron" runs 40 s later:
// a new coffee shows up, the banks' sync time moves, and the dashboard's next check loads it.
let syncTimer = null;
function demoSync() {
  if (syncTimer) return;
  toast("Sync requested. In your own Minty the next cron run syncs every bank; here it takes under a minute.");
  syncTimer = setTimeout(async () => {
    syncTimer = null;
    const today = new Date().toISOString().slice(0, 10);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO transactions (owner, account_id, plaid_txn_id, amount_cents, currency, date, datetime, name, merchant_name, category, pending, account_owner)
                      SELECT owner, id, 'demo-sync-' || abs(random()), 675, 'USD', ?, ?, 'Blue Bottle Coffee', 'Blue Bottle Coffee', 'FOOD_AND_DRINK', 1, 'ALEX MORGAN'
                      FROM accounts WHERE name = 'The Platinum Card®'`).bind(today, new Date().toISOString()),
      env.DB.prepare("UPDATE items SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), attempted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"),
    ]);
    await markSwept(env);
  }, 40_000);
}

// --- Pages that need a real Minty (linking a bank, adding a person, Setup checks).
const NOT_HERE = { "/connect": "Connecting a bank", "/add-user": "Adding a person", "/status": "Setup checks" };
document.addEventListener("click", (e) => {
  const a = e.target.closest?.("a[href]");
  if (!a) return;
  const u = new URL(a.href, location.href);
  if (u.origin === location.origin && NOT_HERE[u.pathname]) {
    e.preventDefault();
    toast(`${NOT_HERE[u.pathname]} needs your own Minty: it isn't part of the demo.`);
  }
}, true);

function toast(text, ms = 5000) {
  let t = document.getElementById("demoToast");
  if (!t) {
    t = Object.assign(document.createElement("div"), { id: "demoToast", className: "demo-toast", role: "status" });
    document.body.append(t);
  }
  t.textContent = text;
  t.hidden = false;
  clearTimeout(t._h);
  if (ms) t._h = setTimeout(() => (t.hidden = true), ms);
}

// --- The demo strip, and the MCP / AI connector button (coming soon; it connects to nothing).
const money = (c) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

document.addEventListener("DOMContentLoaded", () => {
  const strip = document.createElement("div");
  strip.className = "demo-strip";
  strip.innerHTML = "<strong>Live demo</strong> with made-up data for a made-up household. It runs entirely in your browser: nothing is sent anywhere, and changes reset when you reload.";
  document.body.prepend(strip);

  const abc = document.getElementById("abcOpen");
  const btn = document.createElement("button");
  Object.assign(btn, { type: "button", className: "pill", id: "mcpOpen", title: "MCP / AI connector: ask about your money from an AI assistant (coming soon)" });
  btn.setAttribute("aria-haspopup", "dialog");
  btn.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0V7zM12 17v5"/></svg><span class="long">AI connector</span><span class="short">AI</span>`;
  abc.after(btn);

  const dlg = document.createElement("dialog");
  dlg.className = "mcp";
  dlg.setAttribute("aria-labelledby", "mcpTitle");
  dlg.innerHTML = `
    <div class="mcp-head"><h2 id="mcpTitle">MCP / AI connector</h2><span class="soon">Coming soon</span>
      <form method="dialog"><button class="mcp-x" aria-label="Close">×</button></form></div>
    <p class="mcp-lead">Connect Minty to an AI assistant (Claude, ChatGPT or another MCP client) and ask about your money in plain words.
      It reads your transactions and ABC through Minty, as you; anything that would change your data waits for your Confirm, and it can
      never move money (Minty only has read-only access to your banks).</p>
    <ol class="mcp-list" id="mcpList"><li class="mcp-wait">Working out the examples from the demo's data…</li></ol>
    <p class="mcp-fine">Not connected to anything in the demo: these answers are worked out from the demo's data to show what it would do.</p>`;
  document.body.append(dlg);
  btn.addEventListener("click", async () => {
    dlg.showModal();
    try { window.goatcounter?.count?.({ path: "minty-demo-mcp", title: "MCP / AI connector", event: true }); } catch {}
    document.getElementById("mcpList").innerHTML = await examples();
  });
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
});

async function examples() {
  await ready;
  const db = env.DB;
  const now = new Date();
  const first = (y, m) => new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const from = first(now.getUTCFullYear(), now.getUTCMonth() - 1), to = first(now.getUTCFullYear(), now.getUTCMonth());
  const monthName = new Date(from + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });

  const food = (await db.prepare(`SELECT coalesce(merchant_name, name) AS m, sum(amount_cents) AS c, count(*) AS n FROM transactions
      WHERE category = 'FOOD_AND_DRINK' AND amount_cents > 0 AND date >= ? AND date < ? GROUP BY m ORDER BY c DESC`).bind(from, to).all()).results;
  const foodTotal = food.reduce((s, r) => s + r.c, 0);

  const abc = await (await worker.fetch(new Request("http://localhost/benefits"), env, ctx)).json();
  const soon = abc.ending_soon.filter((e) => e.how === "on_card").slice(0, 3);

  const untagged = (await db.prepare(`SELECT count(*) AS n, coalesce(sum(t.amount_cents), 0) AS c FROM transactions t
      WHERE t.amount_cents > 0 AND (t.merchant_name IN ('Costco', 'Whole Foods Market', 'Trader Joe''s'))
        AND NOT EXISTS (SELECT 1 FROM transaction_tags g WHERE g.transaction_id = t.id AND g.tag = 'groceries')`).first());
  const subs = (await db.prepare(`SELECT DISTINCT coalesce(t.merchant_name, t.name) AS m FROM transactions t
      JOIN transaction_tags g ON g.transaction_id = t.id AND g.tag = 'subscriptions' ORDER BY m`).all()).results.map((r) => r.m);

  const ex = (q, a) => `<li><p class="mcp-q">${esc(q)}</p><div class="mcp-a">${a}</div></li>`;
  return [
    ex(`What did we spend on food in ${monthName}, and where?`,
      `<p>${money(foodTotal)} across ${food.reduce((s, r) => s + r.n, 0)} purchases. Most went to ${food.slice(0, 3).map((r) => `${esc(r.m)} (${money(r.c)})`).join(", ")}.</p>`),
    ex("Which card credits are about to run out, and how much is left?",
      soon.length ? `<ul>${soon.map((e) => `<li>${esc(e.benefit)} on ${esc(e.card)}: ${money(e.left_cents)} left, until ${new Date(e.ends + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}</li>`).join("")}</ul>`
        : "<p>Nothing is about to run out: every current credit is used.</p>"),
    ex("Tag every Costco, Whole Foods and Trader Joe's purchase as groceries.",
      `<p>${untagged.n} of them don't have the tag yet (${money(untagged.c)}). Tag them groceries?</p><p><button type="button" class="pill" disabled>Confirm</button> <span class="mcp-note">Changes wait for your Confirm.</span></p>`),
    ex("Tell me when a subscription's price goes up.",
      `<p>Done: after each sync, Minty compares every subscription's charge with the previous one and tells you in the dashboard if it went up. Watching ${subs.length}: ${subs.map(esc).join(", ")}.</p>`),
  ].join("");
}
