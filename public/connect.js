let USERS = [];                    // from /users, in MINTY_USERS order (sets each person's colour)
let owner = null;
let capacity = null;
const statusEl = document.getElementById("status");
const connectBtn = document.getElementById("connect");

function setStatus(msg, kind="") { statusEl.textContent = msg; statusEl.className = "status " + kind; }
// The API's own words for a refusal ({"detail": ...}), else the status code.
const why = async res => { try { return (await res.json()).detail || res.status; } catch { return res.status; } };

// Link sessions (src/routes/link.ts): one localStorage entry each, minty_link:<session_id> =
// {id, token, mode: "link" | "update" | "liabilities", item, expires}, so a bank's OAuth redirect can resume it;
// sessionStorage remembers which one is this tab's. Cleared on success, exit and expiry.
const LINK_PREFIX = "minty_link:", TAB_KEY = "minty_link_tab";
const OLD_LINK_KEYS = ["plaid_link_token", "plaid_link_owner", "plaid_link_account", "plaid_link_update_item"];
const linkStore = {
  save(e) { try { localStorage.setItem(LINK_PREFIX + e.id, JSON.stringify(e)); sessionStorage.setItem(TAB_KEY, e.id); } catch {} },
  drop(id) {
    try { localStorage.removeItem(LINK_PREFIX + id); if (sessionStorage.getItem(TAB_KEY) === id) sessionStorage.removeItem(TAB_KEY); } catch {}
  },
  all() {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(LINK_PREFIX)) continue;
        try { out.push(JSON.parse(localStorage.getItem(k))); } catch { out.push({ id: k.slice(LINK_PREFIX.length), expires: "" }); }
      }
    } catch {}
    return out;
  },
  /** Drops expired entries and the pre-session keys; returns this tab's session, else the newest. */
  resume() {
    try { OLD_LINK_KEYS.forEach(k => localStorage.removeItem(k)); } catch {}
    const live = linkStore.all().filter(e => {
      if (e && Date.parse(e.expires) > Date.now()) return true;
      if (e) linkStore.drop(e.id);
      return false;
    });
    let mine = null;
    try { mine = sessionStorage.getItem(TAB_KEY); } catch {}
    return live.find(e => e.id === mine) || live.sort((a, b) => b.expires.localeCompare(a.expires))[0] || null;
  },
};
/** Link was closed without finishing: the reserved slot goes back (or a reconnect's cooldown ends). */
function cancelSession(entry) {
  linkStore.drop(entry.id);
  fetch("/link/cancel", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: entry.id }) }).catch(() => {});
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const colorOf = k => { const i = USERS.findIndex(u => u.key === k); return i < 0 ? "var(--accent)" : `var(--u${i % 6})`; };

async function loadUsers() {
  try { const r = await fetch("/users"); if (r.ok) USERS = await r.json(); } catch {}
  owner = USERS[0]?.key ?? null;
  renderOwners();
}

function renderOwners() {
  // One person: no choice to make, so hide the question (links go to that person).
  const single = USERS.length < 2;
  document.getElementById("whoLabel").hidden = single;
  document.getElementById("owners").hidden = single;
  document.getElementById("owners").innerHTML = USERS.map(u =>
    `<button class="owner" data-owner="${esc(u.key)}" aria-pressed="${u.key === owner}">` +
    `<span class="dot" style="background:${colorOf(u.key)}"></span>${esc(u.label)}</button>`).join("");
  // Can't link for someone whose Plaid keys aren't set yet — say so instead of failing at Plaid.
  const u = USERS.find(x => x.key === owner);
  const ready = !!u && u.slots.some(s => s.configured);
  connectBtn.disabled = !ready;
  const retire = document.getElementById("connectRetirement");
  if (retire) retire.disabled = !ready;                // the same keys and slots as a bank
  if (u && !ready) {
    statusEl.className = "status err";
    statusEl.innerHTML = `Plaid keys for ${esc(u.label)} aren't set yet. See <a href="/add-user">Add user</a>.`;
  } else if (statusEl.querySelector("a[href='/add-user']")) {
    setStatus("");
  }
}

document.getElementById("owners").addEventListener("click", e => {
  const b = e.target.closest(".owner");
  if (!b) return;
  owner = b.dataset.owner;
  renderOwners(); renderCapacity();
});

// Banks that need you to sign in again, or whose consent through Plaid ends soon (the dashboard's
// "Reconnect" links here): repair them with Link update mode.
async function loadReconnect() {
  const box = document.getElementById("reconnect");
  let items = [];
  try {
    const r = await fetch("/items");
    if (r.ok) items = (await r.json()).filter(i => i.health?.action === "reconnect" || i.status === "login_required");
  } catch {}
  box.hidden = !items.length;
  const label = k => USERS.find(u => u.key === k)?.label ?? k;
  box.innerHTML = items.length ? `<div class="title">Needs you to sign in again</div>` + items.map(i =>
    `<div class="line"><span>${esc(i.institution_name || "Bank")} · ${esc(label(i.owner))}` +
    `${i.health?.detail ? `<span class="why">${esc(i.health.detail)}</span>` : ""}</span>` +
    `<button type="button" data-reconnect="${i.id}">Reconnect</button></div>`).join("") : "";
  if (items.length && location.hash === "#reconnect") box.scrollIntoView({ block: "center" });
}

document.getElementById("reconnect").addEventListener("click", async e => {
  const b = e.target.closest("button[data-reconnect]");
  if (!b) return;
  b.disabled = true;
  setStatus("Preparing…");
  try {
    const itemId = Number(b.dataset.reconnect);
    const res = await fetch("/link/token/update", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_id: itemId }),
    });
    if (!res.ok) throw new Error(await why(res));
    const { link_token, session_id, expires_at } = await res.json();
    const entry = { id: session_id, token: link_token, mode: "update", item: itemId, expires: expires_at };
    linkStore.save(entry);
    openLink(entry, null);
  } catch (err) {
    setStatus("Couldn't start reconnect: " + err.message, "err");
    b.disabled = false;
  }
});

async function loadCapacity() {
  try {
    const r = await fetch("/capacity");
    if (r.ok) { capacity = await r.json(); renderCapacity(); }
  } catch {}
}

function renderCapacity() {
  const box = document.getElementById("cap");
  if (!capacity || !capacity[owner]) { box.hidden = true; return; }
  const slots = capacity[owner];
  const hasKeys = s => s.configured !== false;
  // The next link goes to the first slot with keys that's under the cap (the server's overflow logic).
  const taken = s => s.used + (s.reserved || 0);                // banks + links in progress
  const active = slots.find(s => hasKeys(s) && taken(s) < s.cap);
  const shown = slots.filter(s => hasKeys(s) || s.used > 0);   // slots in use, or holding banks
  const idle = slots.filter(s => !hasKeys(s) && s.used === 0).map(s => s.slot);
  box.hidden = false;
  box.style.setProperty("--c", colorOf(owner));
  box.innerHTML = shown.map(s => {
    const pct = Math.min(100, Math.round((s.used / s.cap) * 100));
    const isActive = active && s.account === active.account;
    const label = !hasKeys(s) ? `${esc(s.slot)} · no keys, ${s.used} bank(s) can't sync`
      : `${esc(s.slot)}${isActive ? " · next link" : ""}${s.reserved ? ` · ${s.reserved} being linked` : ""}`;
    return `<div class="line"${hasKeys(s) ? "" : ' style="color:var(--err)"'}>
      <span class="${isActive ? "active" : ""}">${label}</span>
      <span class="bar"><span class="fill" style="width:${pct}%"></span></span>
      <b>${s.used}/${s.cap}</b>
    </div>`;
  }).join("")
    + (idle.length ? `<div class="line idle">${esc(idle.join(", "))}: no keys yet (add them to use ${idle.length === 1 ? "this Plaid account" : "these Plaid accounts"})</div>` : "")
    + (active ? "" : `<div class="line" style="color:var(--err);margin-top:8px">${idle.length
        ? `Every Plaid account with keys is full. Add keys for ${esc(idle[0])} to link more.`
        : "All Plaid trial accounts are full. Add another slot to PLAID_SLOTS (with its keys) or upgrade Plaid."}</div>`);
}

// Investment accounts for EGG (docs/cfa.md §3): per bank, ask for Investments through Plaid Link
// (update mode: the same connection, no new Trial slot), or turn it off. Listed: banks with it on,
// and banks that already show investment accounts.
const INVESTMENT_STATE = {
  off: "Off",
  pending: "On: the accounts arrive within about ten minutes.",
  ready: "On",
  consent_required: "The bank needs your consent again: add them again.",
  unsupported: "This bank doesn't share investment accounts through Plaid.",
  error: "Couldn't fetch them; Minty retries every hour.",
};
async function loadInvestments() {
  const box = document.getElementById("investments");
  let banks = [];
  try { const r = await fetch("/investments"); if (r.ok) banks = await r.json(); } catch {}
  banks = banks.filter(b => b.investments !== "off" || b.investment_accounts > 0);
  box.hidden = !banks.length;
  const label = k => USERS.find(u => u.key === k)?.label ?? k;
  box.innerHTML = banks.length ? `<div class="title">Investment accounts (for EGG)</div>` + banks.map(b => {
    const on = b.investments !== "off";
    const action = b.products === "investments" ? ""
      : !on || b.investments === "consent_required"
      ? `<button type="button" data-investments-on="${b.item_id}">Add</button>`
      : `<button type="button" data-investments-off="${b.item_id}">Turn off</button>`;
    return `<div class="line"><span>${esc(b.bank || "Bank")} · ${esc(label(b.owner))}` +
      `<span class="why${b.investments === "ready" || b.investments === "pending" ? " on" : ""}">${esc(INVESTMENT_STATE[b.investments] ?? b.investments)}</span></span>${action}</div>`;
  }).join("") : "";
  if (banks.length && location.hash === "#investments") box.scrollIntoView({ block: "center" });
}

document.getElementById("investments").addEventListener("click", async e => {
  const on = e.target.closest("button[data-investments-on]"), off = e.target.closest("button[data-investments-off]");
  if (!on && !off) return;
  (on || off).disabled = true;
  try {
    if (off) {
      const res = await fetch("/investments/off", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_id: Number(off.dataset.investmentsOff) }) });
      if (!res.ok) throw new Error(await why(res));
      setStatus("That bank's investment accounts won't update any more. What was saved stays.", "ok");
      return loadInvestments();
    }
    setStatus("Preparing…");
    const itemId = Number(on.dataset.investmentsOn);
    const res = await fetch("/link/token/investments", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_id: itemId }) });
    if (!res.ok) throw new Error(await why(res));
    const { link_token, session_id, expires_at } = await res.json();
    const entry = { id: session_id, token: link_token, mode: "investments", item: itemId, expires: expires_at };
    linkStore.save(entry);
    openLink(entry, null);
  } catch (err) {
    setStatus("Couldn't add the investment accounts: " + err.message, "err");
    (on || off).disabled = false;
  }
});

document.getElementById("connectRetirement").addEventListener("click", async e => {
  const btn = e.currentTarget;
  btn.disabled = true;
  setStatus("Preparing…");
  try {
    const res = await fetch("/link/token", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner, kind: "investments" }) });
    if (!res.ok) throw new Error(await why(res));
    const { link_token, session_id, expires_at } = await res.json();
    const entry = { id: session_id, token: link_token, mode: "link-investments", expires: expires_at };
    linkStore.save(entry);
    openLink(entry, null);
  } catch (err) {
    setStatus("Couldn't start Link: " + err.message, "err");
    btn.disabled = false;
  }
});

// OAuth return: resume with the SAME link_token and session saved before the redirect.
const params = new URLSearchParams(window.location.search);
const resumable = linkStore.resume();                    // also clears expired sessions
const statementItem = Number(params.get("liabilities") || (params.has("oauth_state_id") && resumable?.mode === "liabilities" ? resumable.item : 0));
let statementRetry = null;
async function confirmStatements(entry) {
  setStatus("Checking statement access with Plaid…");
  const res = await fetch("/link/liabilities/complete", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({session_id:entry.id}) });
  if (!res.ok) throw new Error(await why(res));
  linkStore.drop(entry.id);
  location.assign("/bills");
}
async function loadStatementConsent() {
  document.getElementById("connectRetirement").hidden=true;
  document.getElementById("retirementHint").hidden=true;
  if (!statementItem || !Number.isSafeInteger(statementItem) || statementItem < 1) return;
  document.getElementById("statementConsent").hidden = false;
  document.querySelector("h1").textContent = "Enable statement details";
  for (const id of ["whoLabel","owners","cap","reconnect","connect"]) document.getElementById(id).hidden = true;
  const back = document.querySelector("a.back"); back.href="/bills"; back.textContent="← Back to Bills";
  const button = document.getElementById("statementConnect");
  try {
    const response = await fetch("/items");
    if (!response.ok) throw new Error(await why(response));
    const item = (await response.json()).find(i => i.id === statementItem);
    if (!item) throw new Error("Bank not found. Return to Bills and choose a connection.");
    document.getElementById("statementBank").textContent = item.institution_name || "Your bank";
  } catch (e) { button.disabled=true; setStatus(e.message,"err"); }
}
document.getElementById("statementConnect").addEventListener("click",async () => {
  const button=document.getElementById("statementConnect"); button.disabled=true; setStatus("Preparing statement access…");
  try {
    if (statementRetry) { await confirmStatements(statementRetry); return; }
    const response=await fetch("/link/token/liabilities", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({item_id:statementItem})});
    if (!response.ok) throw new Error(await why(response));
    const value=await response.json();
    const entry={id:value.session_id,token:value.link_token,mode:"liabilities",item:statementItem,expires:value.expires_at};
    linkStore.save(entry); openLink(entry,null);
  } catch(e) { setStatus(e.message,"err"); button.disabled=false; }
});
if (params.get("oauth_state_id")) {
  if (resumable) openLink(resumable, window.location.href);
  else setStatus("Could not resume the connection (it may have taken longer than 30 minutes). Please start again.", "err");
}

connectBtn.addEventListener("click", async () => {
  connectBtn.disabled = true;
  setStatus("Preparing…");
  try {
    const res = await fetch("/link/token", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner }),
    });
    if (!res.ok) throw new Error(await why(res));
    const { link_token, session_id, expires_at } = await res.json();
    // kept across a possible OAuth redirect; the session holds a slot until it's used or cancelled
    const entry = { id: session_id, token: link_token, mode: "link", expires: expires_at };
    linkStore.save(entry);
    openLink(entry, null);
  } catch (e) {
    setStatus("Couldn't start Link: " + e.message, "err");
    connectBtn.disabled = false;
  }
});

// entry.mode "update" = reconnect: Plaid repairs the existing Item; nothing to exchange.
function openLink(entry, receivedRedirectUri) {
  let finished = false;
  const handler = Plaid.create({
    token: entry.token,
    receivedRedirectUri,
    onLoad: () => setStatus("Continue in the Plaid window."),
    onSuccess: async (public_token, metadata) => {
      finished = true;
      if (entry.mode === "liabilities") {
        try { await confirmStatements(entry); }
        catch(e) {
          statementRetry=entry;
          setStatus("Couldn't confirm statement access: " + e.message,"err");
          const button=document.getElementById("statementConnect");
          button.textContent="Retry confirming access"; button.disabled=false;
        }
        return;
      }
      if (entry.mode === "investments") {
        // Plaid must confirm the bank's consent before Minty fetches anything (src/routes/investments.ts).
        setStatus("Checking the bank's consent with Plaid…");
        try {
          const res = await fetch("/link/investments/complete", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: entry.id }),
          });
          linkStore.drop(entry.id);
          if (!res.ok) throw new Error(await why(res));
          setStatus("Investment accounts are on. They arrive within about ten minutes, in EGG on the dashboard.", "ok");
        } catch (err) {
          setStatus("The investment accounts aren't on yet: " + err.message, "err");
        }
        loadInvestments();
        return;
      }
      if (entry.mode === "update") {
        linkStore.drop(entry.id);
        const updateItemId = entry.item;
        setStatus("Reconnected. Checking the connection with Plaid…");
        try {
          // Plaid's view of the connection now, so the dashboard's warning clears right away.
          const res = await fetch("/link/reconnected", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ item_id: updateItemId }),
          });
          if (!res.ok) throw new Error(await why(res));
          const { health } = await res.json();
          if (health.action === "reconnect" || health.action === "relink") {
            setStatus(`${health.message} ${health.detail ?? ""}`.trim(), "err");
          } else {
            setStatus("Reconnected. New transactions arrive with the next hourly sync.", "ok");
          }
        } catch {
          setStatus("Reconnected. It will refresh on the next hourly sync.", "ok");
        }
        loadReconnect();
        return;
      }
      setStatus("Linking and pulling transactions…");
      try {
        const res = await fetch("/link/exchange", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: entry.id, public_token, institution_name: metadata?.institution?.name ?? null }),
        });
        linkStore.drop(entry.id);                        // used (or refused): a public token works once
        if (!res.ok) throw new Error(await why(res));
        const data = await res.json();
        setStatus(entry.mode === "link-investments"
          ? "Connected. Its investment accounts arrive within about ten minutes, in EGG on the dashboard (not in the feed)."
          : data.status === "good" ? "Connected. Transactions are syncing." : "Connected (status: " + data.status + ").", "ok");
        loadCapacity();
        loadInvestments();
        connectBtn.disabled = false;
        document.getElementById("connectRetirement").disabled = false;
      } catch (e) {
        setStatus("Exchange failed: " + e.message, "err");
        connectBtn.disabled = false;
        document.getElementById("connectRetirement").disabled = false;
      }
    },
    onExit: (err) => {
      if (finished) return;
      if (!finished) cancelSession(entry);
      if (err) setStatus("Link closed: " + (err.error_message || err.error_code || "cancelled"), "err");
      else setStatus("");
      connectBtn.disabled = false;
      if (!statementItem) loadReconnect();
      document.getElementById("statementConnect").disabled=false;
      document.getElementById("connectRetirement").disabled = false;
      if (!statementItem) loadInvestments();
    },
  });
  handler.open();
}

// Light/dark toggle (shares the "minty-theme" preference with the dashboard).
(function themeToggle() {
  const root = document.documentElement, btn = document.getElementById("themeToggle");
  const apply = t => {
    root.dataset.theme = t;
    const label = t === "dark" ? "Switch to light mode" : "Switch to dark mode";
    btn.setAttribute("aria-label", label); btn.title = label;
  };
  apply(root.dataset.theme);
  btn.addEventListener("click", () => {
    const t = root.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem("minty-theme", t); apply(t);
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", e => {
    if (!localStorage.getItem("minty-theme")) apply(e.matches ? "dark" : "light");
  });
})();

loadUsers().then(() => {
  if (statementItem) loadStatementConsent();
  else { loadCapacity(); loadReconnect(); loadInvestments(); }
});
