// People come from /users (MINTY_USERS order sets their colour). The offline preview
// falls back to the two people in SAMPLE.
let USERS = [{ key: "me", label: "Alex" }, { key: "sam", label: "Sam" }];   // offline preview only (SAMPLE's two people)
const colorOf = k => { const i = USERS.findIndex(u => u.key === k); return i < 0 ? "var(--muted)" : `var(--u${i % 6})`; };
const labelOf = k => USERS.find(u => u.key === k)?.label ?? k;
// cards: card members picked on multi-card accounts, as "<account_id>:<member>" ("" member = none)
let state = { owner: "all", q: "", start: "", end: "", tags: [], tagMode: "any", banks: [], accounts: [], cards: [] };
let ITEMS = null;                  // linked bank logins from /items (null until loaded)
let ACCOUNTS = null;               // their accounts and cards from /accounts (null until loaded)
let openRows = new Set();          // plaid_txn_id of expanded rows (survives re-render)
let current = new Map();           // plaid_txn_id -> txn object (for tag edits)
let allTags = [];
let offline = false;

const fmt = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
// Plaid: POSITIVE amount = money OUT. Flip for display (spending negative/red, income positive/green).
function displayAmount(a) { return -Number(a ?? 0); }

async function loadUsers() {
  try { const r = await fetch("/users"); if (r.ok) USERS = await r.json(); } catch {}
  renderOwnerSeg();
}

function renderOwnerSeg() {
  const seg = document.getElementById("ownerSeg");
  seg.hidden = USERS.length < 2;                 // one person: nothing to switch between
  if (seg.hidden) { seg.innerHTML = ""; state.owner = "all"; return; }
  const n = USERS.length;
  const stops = USERS.map((u, i) => `${colorOf(u.key)} ${i * 100 / n}% ${(i + 1) * 100 / n}%`).join(", ");
  const btn = (key, label, bg) => `<button data-owner="${escapeAttr(key)}" aria-pressed="${state.owner === key}">` +
    `<span class="dot" style="background:${bg}"></span>${escapeHtml(label)}</button>`;
  document.getElementById("ownerSeg").innerHTML = btn("all", "Combined", `linear-gradient(90deg, ${stops})`) +
    USERS.map(u => btn(u.key, u.label, colorOf(u.key))).join("");
}

// Pages of transactions, newest first. More come from "Show more" (before=<date>:<id>), so a page
// load reads only what it shows from D1.
const PAGE = 500;
let loaded = [], hasMore = false, loadSeq = 0;

async function load(more = false) {
  const seq = ++loadSeq;
  const p = new URLSearchParams();
  if (state.owner !== "all") p.set("owner", state.owner);
  if (state.q) p.set("q", state.q);
  if (state.start) p.set("start", state.start);
  if (state.end) p.set("end", state.end);
  for (const t of state.tags) p.append("tag", t);
  if (state.tags.length > 1 && state.tagMode === "all") p.set("tag_mode", "all");
  for (const id of state.banks) p.append("item_id", id);
  for (const id of state.accounts) p.append("account_id", id);
  for (const k of state.cards) p.append("card", k);
  p.set("limit", String(PAGE + 1));                  // one extra says whether there's more
  const last = more ? loaded[loaded.length - 1] : null;
  if (last) p.set("before", `${last.date}:${last.id}`);

  let txns;
  try {
    const res = await fetch("/transactions?" + p.toString());
    if (res.status === 429 || res.status === 422) {  // a limit, or a filter the API refused: say why, keep the list
      const d = await res.json().catch(() => ({}));
      if (seq !== loadSeq) return;
      notice(d.detail || "Too many requests. Wait a minute and try again.");
      return;
    }
    if (!res.ok) throw new Error(res.status);
    txns = await res.json();
    if (seq !== loadSeq) return;                     // filters changed meanwhile: a newer load wins
    hasMore = txns.length > PAGE;
    txns = (more ? loaded : []).concat(txns.slice(0, PAGE));
    loaded = txns;
    offline = false; banner(false);
    if (!more) refreshTags();
  } catch (e) {
    if (seq !== loadSeq) return;
    offline = true; banner(true); hasMore = false;
    txns = SAMPLE.filter(t =>
      (state.owner === "all" || t.owner === state.owner) &&
      matchesTags(t.tags || []));
    allTags = [...new Set(SAMPLE.flatMap(t => t.tags || []))].sort();
    populateTagFilter();
  }
  render(txns);
}

async function refreshTags() {
  try {
    const r = await fetch("/tags");
    if (r.ok) { allTags = await r.json(); populateTagFilter(); }
  } catch {}
}

function matchesTags(tags) {
  if (!state.tags.length) return true;
  return state.tagMode === "all" ? state.tags.every(t => tags.includes(t)) : state.tags.some(t => tags.includes(t));
}

function populateTagFilter() {
  // Keep selected tags listed even if no transaction carries them any more, so they can be unticked.
  const names = [...new Set([...allTags, ...state.tags])].sort((a, b) => a.localeCompare(b));
  const html = names.length
    ? names.map(t => `<label><input type="checkbox" value="${escapeAttr(t)}" ${state.tags.includes(t) ? "checked" : ""} />${escapeHtml(t)}</label>`).join("")
    : `<div class="none">No tags yet — use “+ tag” on a transaction.</div>`;
  const opts = document.getElementById("tagOpts");
  if (opts.dataset.html !== html) { opts.innerHTML = html; opts.dataset.html = html; }   // don't steal focus mid-menu
  renderTagControls();
}

function renderTagControls() {
  const n = state.tags.length;
  const btn = document.getElementById("tagBtn");
  btn.textContent = !n ? "All tags" : n === 1 ? state.tags[0] : `${n} tags · ${state.tagMode}`;
  btn.title = n ? `Tags (${state.tagMode}): ${state.tags.join(", ")}` : "";
  btn.classList.toggle("active", n > 0);
  for (const b of document.querySelectorAll("#tagMode button")) b.setAttribute("aria-pressed", b.dataset.mode === state.tagMode);
  document.getElementById("tagClear").disabled = !n;
}

// --- bank filter: linked bank logins (Plaid Items), grouped by person -------------------------
async function loadItems() {
  try {
    const r = await fetch("/items");
    if (r.ok) ITEMS = await r.json();
  } catch {}
  populateBankFilter();
  populateAccountFilter();          // group headings use the bank names
}

const bankName = it => it.institution_name || `Bank #${it.id}`;
const BANK_NOTES = { reconnect: "needs reconnect", broken: "sync error", stalled: "not syncing", stranded: "can't sync",
                     expiring: "access ending", downloading: "downloading" };

// --- status strip: every bank that needs attention, from GET /health. Never silent: a bank that
// stops syncing shows here, with what went wrong and what to do, until it's fixed. ------------
const HEALTH_SHOWN = 3;            // problems shown before "Show N more"
let healthOpen = false;

async function loadHealth() {
  const box = document.getElementById("health");
  let h;
  try {
    const r = await fetch("/health");
    if (!r.ok) throw new Error(r.status);
    h = await r.json();
  } catch { box.hidden = true; return; }      // offline preview: the sample-data banner says so
  const who = b => USERS.length > 1 ? ` (${labelOf(b.owner)})` : "";
  const problems = [];
  if (h.sync && !h.sync.ok) problems.push({ level: "error", message: h.sync.message, fix: h.sync.fix });
  for (const b of h.banks) if (b.health.level !== "info") problems.push({ ...b.health, message: b.health.message + who(b) });
  const downloads = h.banks.filter(b => b.health.level === "info");

  const line = p => {
    const code = p.error_code ? escapeHtml(p.error_code) + (p.plaid_message ? ` · “${escapeHtml(p.plaid_message)}”` : "") : "";
    const what = [p.detail, p.fix].filter(Boolean).map(escapeHtml).join(" ");
    const act = p.action === "reconnect" ? `<a class="act" href="/connect#reconnect">Reconnect</a>`
              : p.action === "relink" ? `<a class="act" href="/connect">Link again</a>` : "";
    return `<div class="hl ${p.level}" role="${p.level === "error" ? "alert" : "status"}">
      <span class="mark" aria-hidden="true">${p.level === "error" ? "✕" : "!"}</span>
      <span class="msg">${escapeHtml(p.message)}</span>${act}
      ${what ? `<span class="what">${what}</span>` : ""}${code ? `<span class="code">${code}</span>` : ""}</div>`;
  };
  const shown = healthOpen ? problems : problems.slice(0, HEALTH_SHOWN);
  let html = shown.map(line).join("");
  if (problems.length > shown.length) html += `<button type="button" class="more" id="healthMore">Show ${problems.length - shown.length} more</button>`;
  if (downloads.length) {
    html += `<div class="hl info" role="status"><span class="mark" aria-hidden="true">↓</span><span class="msg">Downloading history: ${
      downloads.map(b => escapeHtml(b.health.message.replace(/: downloading its history \((.*)\)\.$/, " ($1)")) + escapeHtml(who(b))).join(", ")
    }</span><span class="what">Newer transactions appear once each download is done.</span></div>`;
  }
  box.innerHTML = html;
  box.hidden = !html;
  document.getElementById("healthMore")?.addEventListener("click", () => { healthOpen = true; loadHealth(); });
}

function visibleBanks() {
  return (ITEMS || []).filter(it => state.owner === "all" || it.owner === state.owner);
}

function populateBankFilter() {
  const banks = visibleBanks();
  let html;
  if (ITEMS === null) html = `<div class="none">Banks load from the Minty API.</div>`;
  else if (!banks.length) html = `<div class="none">No banks linked${state.owner === "all" ? "" : " for " + escapeHtml(labelOf(state.owner))} yet. Use “+ Add account”.</div>`;
  else {
    // one group per person, in MINTY_USERS order, then anyone since removed from it
    const owners = [...USERS.map(u => u.key), ...new Set(banks.map(b => b.owner))].filter((o, i, a) => a.indexOf(o) === i);
    html = owners.filter(o => banks.some(b => b.owner === o)).map(o =>
      `<div class="optgroup"><span class="dot" style="background:${colorOf(o)}"></span>${escapeHtml(labelOf(o))}</div>` +
      banks.filter(b => b.owner === o).map(b => {
        const note = BANK_NOTES[b.health?.state] ?? (b.status === "login_required" ? "needs reconnect" : b.status === "error" ? "sync error" : "");
        return `<label><input type="checkbox" value="${b.id}" ${state.banks.includes(b.id) ? "checked" : ""} />` +
          `${escapeHtml(bankName(b))}${note ? `<span class="note">${note}</span>` : ""}</label>`;
      }).join("")).join("");
  }
  const opts = document.getElementById("bankOpts");
  if (opts.dataset.html !== html) { opts.innerHTML = html; opts.dataset.html = html; }   // don't steal focus mid-menu
  renderBankControls();
}

function renderBankControls() {
  const chosen = (ITEMS || []).filter(it => state.banks.includes(it.id));
  const btn = document.getElementById("bankBtn");
  const withOwner = it => state.owner === "all" && USERS.length > 1 ? `${bankName(it)} (${labelOf(it.owner)})` : bankName(it);
  btn.textContent = !chosen.length ? "All banks" : chosen.length === 1 ? withOwner(chosen[0]) : `${chosen.length} banks`;
  btn.title = chosen.length ? `Banks: ${chosen.map(withOwner).join(", ")}` : "";
  btn.classList.toggle("active", chosen.length > 0);
  document.getElementById("bankClear").disabled = !chosen.length;
}

function setBanks(ids) {
  state.banks = ids;
  populateBankFilter();
  pruneAccounts(); populateAccountFilter();
  load();
}

// --- card/account filter: every account when no bank is picked, else only the picked banks' ---
async function loadAccounts() {
  try {
    const r = await fetch("/accounts");
    if (r.ok) ACCOUNTS = await r.json();
  } catch {}
  populateAccountFilter();
}

const acctName = a => `${a.name || "Account"}${a.mask ? ` ••${a.mask}` : ""}`;

function visibleAccounts() {
  return (ACCOUNTS || []).filter(a =>
    (state.owner === "all" || a.owner === state.owner) &&
    (!state.banks.length || state.banks.includes(a.item_id)));
}

// Drop picked accounts and card members that the person or bank selection no longer shows.
function pruneAccounts() {
  const shown = new Set(visibleAccounts().map(a => a.id));
  state.accounts = state.accounts.filter(id => shown.has(id));
  state.cards = state.cards.filter(k => shown.has(Number(k.slice(0, k.indexOf(":")))));
}

const cardKey = (acctId, name) => `${acctId}:${name ?? ""}`;
const memberName = name => name ?? "No card member";

function populateAccountFilter() {
  const accts = visibleAccounts();
  let html;
  if (ACCOUNTS === null) html = `<div class="none">Accounts load from the Minty API.</div>`;
  else if (!accts.length) html = `<div class="none">${state.banks.length ? "No accounts at the selected banks." : "No accounts yet. Use “+ Add account”."}</div>`;
  else {
    // one group per bank, in /items order, then any account whose bank isn't listed
    const order = [...(ITEMS || []).map(it => it.id), ...new Set(accts.map(a => a.item_id))].filter((id, i, xs) => xs.indexOf(id) === i);
    html = order.filter(id => accts.some(a => a.item_id === id)).map(id => {
      const bank = (ITEMS || []).find(it => it.id === id);
      const owner = bank?.owner ?? accts.find(a => a.item_id === id).owner;
      const who = state.owner === "all" && USERS.length > 1 ? ` · ${escapeHtml(labelOf(owner))}` : "";
      return `<div class="optgroup"><span class="dot" style="background:${colorOf(owner)}"></span>${escapeHtml(bank ? bankName(bank) : `Bank #${id}`)}${who}</div>` +
        accts.filter(a => a.item_id === id).map(a =>
          `<label><input type="checkbox" data-acct="${a.id}" ${state.accounts.includes(a.id) ? "checked" : ""} />` +
          `${escapeHtml(acctName(a))}${a.subtype || a.type ? `<span class="kind">${escapeHtml(titleCase(a.subtype || a.type))}</span>` : ""}</label>` +
          // card members on a multi-card account (e.g. Amex authorized users), indented under it
          (a.card_members || []).map(m => {
            const key = cardKey(a.id, m.name);
            return `<label class="sub"><input type="checkbox" data-card="${escapeAttr(key)}" ${state.cards.includes(key) ? "checked" : ""} />` +
              `${escapeHtml(memberName(m.name))}<span class="kind">${m.count}</span></label>`;
          }).join("")
        ).join("");
    }).join("");
  }
  const opts = document.getElementById("acctOpts");
  if (opts.dataset.html !== html) { opts.innerHTML = html; opts.dataset.html = html; }   // don't steal focus mid-menu
  renderAccountControls();
}

function renderAccountControls() {
  const byId = new Map((ACCOUNTS || []).map(a => [a.id, a]));
  const labels = [
    ...state.accounts.filter(id => byId.has(id)).map(id => acctName(byId.get(id))),
    ...state.cards.map(k => {
      const id = Number(k.slice(0, k.indexOf(":"))), name = k.slice(k.indexOf(":") + 1);
      return `${byId.has(id) ? acctName(byId.get(id)) : `Account #${id}`} · ${memberName(name || null)}`;
    }),
  ];
  const btn = document.getElementById("acctBtn");
  btn.textContent = !labels.length ? "All cards & accounts" : labels.length === 1 ? labels[0] : `${labels.length} selected`;
  btn.title = labels.length ? `Cards & accounts: ${labels.join(", ")}` : "";
  btn.classList.toggle("active", labels.length > 0);
  document.getElementById("acctClear").disabled = !labels.length;
}

function setAccounts(ids) {
  state.accounts = ids;
  populateAccountFilter();
  load();
}

function setTags(tags) {
  state.tags = tags;
  populateTagFilter();
  load();
}

function banner(show) {
  const b = document.getElementById("banner");
  b.hidden = !show;
  if (show) b.textContent = "Showing sample data — couldn't reach the API. Deploy this file behind the Minty API to see live transactions.";
}

/** A message from the API in the banner (e.g. a rate limit); the next successful load clears it. */
function notice(text) {
  const b = document.getElementById("banner");
  b.hidden = false;
  b.textContent = text;
}

function render(txns) {
  current = new Map(txns.map(t => [t.plaid_txn_id, t]));
  document.getElementById("count").textContent =
    !txns.length ? "no transactions"
    : hasMore ? `latest ${txns.length.toLocaleString()} transactions`
    : `${txns.length.toLocaleString()} transaction${txns.length === 1 ? "" : "s"}`;
  renderTotals(txns);

  const feed = document.getElementById("feed");
  if (!txns.length) { feed.innerHTML = `<div class="empty">Nothing here yet. Link an account, or widen your filters.</div>`; return; }

  const groups = {};
  for (const t of txns) (groups[t.date] ??= []).push(t);
  feed.innerHTML = Object.entries(groups).map(([date, items]) => `
    <section class="daygroup">
      <div class="daylabel">${prettyDate(date)}</div>
      <div class="rows">${items.map(txnHTML).join("")}</div>
    </section>`).join("")
    + (hasMore && !offline ? `<button type="button" class="moreload" id="moreBtn">Show more</button>` : "");
}

function txnHTML(t) {
  const amt = displayAmount(t.amount);
  const cls = amt < 0 ? "out" : "in";
  const merchant = t.merchant_name || t.name || "—";
  const isOpen = openRows.has(t.plaid_txn_id);
  const tagChips = (t.tags || []).map(tg =>
    `<span class="tag${state.tags.includes(tg) ? " sel" : ""}" data-tag="${escapeAttr(tg)}" title="Filter by ${escapeAttr(tg)}">${escapeHtml(tg)}</span>`).join("") +
    `<button type="button" class="tag addtag" data-addtag aria-label="Add a tag to ${escapeAttr(merchant)}">+ tag</button>`;
  // name each row's person only when there's more than one (or it's someone since removed)
  const meta = USERS.length > 1 || !USERS.some(u => u.key === t.owner) ? [`<span>${escapeHtml(labelOf(t.owner))}</span>`] : [];
  if (t.account_owner) meta.push(`<span title="Card member">${escapeHtml(t.account_owner)}</span>`);
  if (t.category) meta.push(`<span>${escapeHtml(titleCase(t.category))}</span>`);
  if (t.pending) meta.push(`<span class="chip pending">Pending</span>`);
  return `
    <div class="txn ${isOpen ? "open" : ""}" data-txnid="${escapeAttr(t.plaid_txn_id)}">
      <div class="row" role="button" tabindex="0" aria-expanded="${isOpen}">
        <div class="stripe" style="background:${colorOf(t.owner)}"></div>
        <div class="desc">
          <div class="name">${escapeHtml(merchant)}</div>
          <div class="meta">${meta.join("")} ${tagChips}</div>
        </div>
        <div class="amt ${cls} num">${amt < 0 ? "−" : "+"}${fmt.format(Math.abs(amt))}</div>
      </div>
      <div class="detail">${detailHTML(t)}</div>
    </div>`;
}

function detailHTML(t) {
  const acct = t.account_name
    ? `${t.institution_name ? `${escapeHtml(t.institution_name)} · ` : ""}${escapeHtml(t.account_name)}${t.account_mask ? ` ····${escapeHtml(t.account_mask)}` : ""}${t.account_subtype ? ` · ${escapeHtml(titleCase(t.account_subtype))}` : ""}`
    : "—";
  const when = t.datetime ? new Date(t.datetime).toLocaleString() : prettyDate(t.date);
  const chips = (t.tags || []).map(tg =>
    `<span class="tag editable">${escapeHtml(tg)}<button class="x" data-removetag="${escapeAttr(tg)}" aria-label="Remove tag ${escapeAttr(tg)}">×</button></span>`
  ).join("") || `<span class="notags">No tags yet</span>`;
  return `
    <dl class="kv">
      <dt>Account</dt><dd>${acct}</dd>
      ${t.account_owner ? `<dt>Card member</dt><dd>${escapeHtml(t.account_owner)}</dd>` : ""}
      <dt>When</dt><dd>${escapeHtml(when)}</dd>
      <dt>Amount</dt><dd class="num">${fmt.format(Math.abs(displayAmount(t.amount)))} ${displayAmount(t.amount) < 0 ? "out" : "in"}</dd>
      <dt>Plaid ID</dt><dd class="mono">${escapeHtml(t.plaid_txn_id)}</dd>
    </dl>
    <div class="tagedit">
      <div class="tagchips">${chips}</div>
      <input class="taginput" type="text" placeholder="Add a tag, press Enter" />
    </div>`;
}

function renderTotals(txns) {
  const by = {};
  for (const t of txns) by[t.owner] = (by[t.owner] ?? 0) + displayAmount(t.amount);
  // everyone configured, plus anyone with rows who has since been removed from MINTY_USERS
  const owners = state.owner === "all"
    ? [...USERS.map(u => u.key), ...Object.keys(by).filter(k => !USERS.some(u => u.key === k))]
    : [state.owner];
  document.getElementById("totals").innerHTML = owners.map(o => {
    const v = by[o] ?? 0;
    return `<div class="stat">
      <div class="k"><span class="dot" style="width:8px;height:8px;border-radius:50%;display:inline-block;background:${colorOf(o)}"></span>${escapeHtml(labelOf(o))} · net</div>
      <div class="v num" style="color:${v < 0 ? "var(--out)" : "var(--in)"}">${v < 0 ? "−" : "+"}${fmt.format(Math.abs(v))}</div>
    </div>`;
  }).join("");
}

// --- interaction (event delegation on the feed) ------------------------------
const feed = document.getElementById("feed");

feed.addEventListener("click", (e) => {
  const filterTag = e.target.closest(".tag[data-tag]");
  if (filterTag && !e.target.closest(".detail")) {         // row tag chip → filter by it
    e.stopPropagation();                                    // add it to the tag filter
    const tg = filterTag.dataset.tag;
    if (!state.tags.includes(tg)) setTags([...state.tags, tg]);
    return;
  }
  const addTag = e.target.closest("[data-addtag]");
  if (addTag) {                                             // "+ tag": open the row, focus its input
    const txnEl = addTag.closest(".txn");
    if (!openRows.has(txnEl.dataset.txnid)) toggle(txnEl);
    txnEl.querySelector(".taginput").focus();
    return;
  }
  const removeBtn = e.target.closest("[data-removetag]");
  if (removeBtn) {                                          // remove a tag
    const txn = txnFromEl(removeBtn);
    saveTags(txn, (txn.tags || []).filter(x => x !== removeBtn.dataset.removetag));
    return;
  }
  const row = e.target.closest(".row");
  if (row) toggle(row.closest(".txn"));
});

feed.addEventListener("keydown", (e) => {
  if (e.target.classList.contains("taginput") && e.key === "Enter") {
    e.preventDefault();
    const txn = txnFromEl(e.target);
    const val = e.target.value.trim();
    if (val) {
      const tags = [...(txn.tags || [])];
      if (!tags.some(x => x.toLowerCase() === val.toLowerCase())) tags.push(val);
      saveTags(txn, tags, { refocus: true });
    }
    e.target.value = "";
  }
  if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("row")) {
    e.preventDefault();
    toggle(e.target.closest(".txn"));
  }
});

function txnFromEl(el) { return current.get(el.closest(".txn").dataset.txnid); }

function toggle(txnEl) {
  const id = txnEl.dataset.txnid;
  if (openRows.has(id)) openRows.delete(id); else openRows.add(id);
  txnEl.classList.toggle("open");
  txnEl.querySelector(".row").setAttribute("aria-expanded", openRows.has(id));
}

function focusTagInput(txnId) {
  const el = [...feed.querySelectorAll(".txn")].find(x => x.dataset.txnid === txnId);
  el?.querySelector(".taginput")?.focus();
}

async function saveTags(txn, tags, { refocus = false } = {}) {
  const rerender = () => { render([...current.values()]); if (refocus) focusTagInput(txn.plaid_txn_id); };
  txn.tags = tags;                                          // optimistic
  rerender();
  if (offline || txn.id == null) {                          // preview mode: local only
    allTags = [...new Set([...allTags, ...tags])].sort(); populateTagFilter(); return;
  }
  try {
    const res = await fetch(`/transactions/${txn.id}/tags`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    txn.tags = data.tags;
    refreshTags();
    rerender();
  } catch (e) {
    load();                                                 // revert to server truth on failure
  }
}

// helpers
function prettyDate(d) {
  const dt = new Date(d + "T00:00:00");
  return isNaN(dt) ? d : dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}
function titleCase(s) { return String(s).toLowerCase().replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function escapeAttr(s) { return String(s).replace(/[&"']/g, c => ({ "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c])); }

// wiring
document.getElementById("ownerSeg").addEventListener("click", e => {
  const b = e.target.closest("button[data-owner]");
  if (!b) return;
  state.owner = b.dataset.owner; renderOwnerSeg();
  if (state.owner !== "all" && ITEMS) {
    state.banks = state.banks.filter(id => ITEMS.some(it => it.id === id && it.owner === state.owner));
  }
  populateBankFilter();
  pruneAccounts(); populateAccountFilter();
  load();
});
let deb;
document.getElementById("q").addEventListener("input", e => { clearTimeout(deb); deb = setTimeout(() => { state.q = e.target.value.trim(); load(); }, 250); });
// Filter dropdowns (tags, banks, cards & accounts): opening one closes the others; a click
// outside or Escape closes them.
const DROPDOWNS = [["tagPick", "tagBtn", "tagMenu"], ["bankPick", "bankBtn", "bankMenu"], ["acctPick", "acctBtn", "acctMenu"], ["datePick", "dateBtn", "dateMenu"]]
  .map(([pick, btn, menu]) => ({ pick: document.getElementById(pick), btn: document.getElementById(btn), menu: document.getElementById(menu) }));
function setDropdown(d, open) { d.menu.hidden = !open; d.btn.setAttribute("aria-expanded", open); }
for (const d of DROPDOWNS) d.btn.addEventListener("click", () => {
  const open = d.menu.hidden;
  for (const o of DROPDOWNS) setDropdown(o, o === d && open);
});
document.addEventListener("click", e => { for (const d of DROPDOWNS) if (!d.pick.contains(e.target)) setDropdown(d, false); });
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  const d = DROPDOWNS.find(x => !x.menu.hidden);
  if (d) { setDropdown(d, false); d.btn.focus(); }
});
// The ⋯ menu (Bills, and more features later): opens and closes like the filter menus; picking an
// item closes it (the item's own handler, e.g. bills.js, does the rest).
const moreBtn = document.getElementById("moreMenuBtn"), moreMenu = document.getElementById("moreMenu");
const setMore = open => { moreMenu.hidden = !open; moreBtn.setAttribute("aria-expanded", open); };
moreBtn.addEventListener("click", () => setMore(moreMenu.hidden));
moreMenu.addEventListener("click", e => { if (e.target.closest("button")) setMore(false); });
document.addEventListener("click", e => { if (!document.getElementById("morePick").contains(e.target)) setMore(false); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !moreMenu.hidden) { setMore(false); moreBtn.focus(); } });
// Phones: once the header has scrolled away, the filters move into a small strip pinned to the top
// (the same elements, so their state and handlers come along) and move back when the header shows
// again. The header keeps its height meanwhile, so the list doesn't jump.
const PHONE = matchMedia("(max-width: 640px)");
const header = document.querySelector("body > header"), controls = header.querySelector(".controls");
const strip = document.getElementById("miniStrip"), ownerSeg = document.getElementById("ownerSeg");
let compact = false;
function setCompact(on) {
  if (on === compact) return;
  compact = on;
  for (const d of DROPDOWNS) setDropdown(d, false);
  ownerSeg.classList.remove("open");
  const typing = document.activeElement === document.getElementById("q");
  if (on) {
    header.style.minHeight = header.offsetHeight + "px";
    strip.hidden = false;
    strip.append(controls);
    strip.style.setProperty("--strip-bottom", strip.offsetHeight + 6 + "px");   // its height: it sits at the top (and may be sliding in)
  } else {
    header.append(controls);
    header.style.minHeight = "";
    strip.hidden = true;
  }
  if (typing) document.getElementById("q").focus({ preventScroll: true });
}
new IntersectionObserver(([e]) => setCompact(PHONE.matches && !e.isIntersecting && e.boundingClientRect.top < 0)).observe(header);
PHONE.addEventListener("change", () => { if (!PHONE.matches) setCompact(false); });
document.getElementById("miniTop").addEventListener("click", () => scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }));
// In the strip the person switch shows only the current choice; a tap opens the full list.
ownerSeg.addEventListener("click", e => {
  if (!compact) return;
  if (!ownerSeg.classList.contains("open")) {
    e.stopPropagation();
    for (const d of DROPDOWNS) setDropdown(d, false);
    ownerSeg.classList.add("open");
  } else setTimeout(() => ownerSeg.classList.remove("open"));
}, true);
document.addEventListener("click", e => { if (!ownerSeg.contains(e.target)) ownerSeg.classList.remove("open"); });
// tag filter
document.getElementById("tagOpts").addEventListener("change", e => {
  const boxes = [...document.querySelectorAll("#tagOpts input:checked")].map(b => b.value);
  state.tags = boxes; renderTagControls(); load();
});
document.getElementById("tagMode").addEventListener("click", e => {
  const b = e.target.closest("button[data-mode]");
  if (!b || b.dataset.mode === state.tagMode) return;
  state.tagMode = b.dataset.mode; renderTagControls();
  if (state.tags.length > 1) load();
});
document.getElementById("tagClear").addEventListener("click", () => setTags([]));
// bank filter
document.getElementById("bankOpts").addEventListener("change", () => {
  state.banks = [...document.querySelectorAll("#bankOpts input:checked")].map(b => Number(b.value));
  renderBankControls();
  pruneAccounts(); populateAccountFilter();      // only the picked banks' accounts stay listed
  load();
});
document.getElementById("bankClear").addEventListener("click", () => setBanks([]));
// card/account filter
document.getElementById("acctOpts").addEventListener("change", e => {
  // A whole account and its card members are alternatives: ticking one unticks the other.
  const box = e.target.closest("input[type=checkbox]");
  if (box?.checked && box.dataset.acct) {
    for (const m of document.querySelectorAll(`#acctOpts input[data-card^="${box.dataset.acct}:"]`)) m.checked = false;
  } else if (box?.checked && box.dataset.card) {
    const whole = document.querySelector(`#acctOpts input[data-acct="${box.dataset.card.slice(0, box.dataset.card.indexOf(":"))}"]`);
    if (whole) whole.checked = false;
  }
  state.accounts = [...document.querySelectorAll("#acctOpts input[data-acct]:checked")].map(b => Number(b.dataset.acct));
  state.cards = [...document.querySelectorAll("#acctOpts input[data-card]:checked")].map(b => b.dataset.card);
  renderAccountControls(); load();
});
document.getElementById("acctClear").addEventListener("click", () => { state.cards = []; setAccounts([]); });
// Dates: quick ranges (in local time) or a custom from/to, in one menu like the other filters.
const ymdLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function rangeFor(key) {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  if (key === "this-month") return [ymdLocal(new Date(y, m, 1)), ymdLocal(now)];
  if (key === "last-month") return [ymdLocal(new Date(y, m - 1, 1)), ymdLocal(new Date(y, m, 0))];
  if (key === "this-year") return [ymdLocal(new Date(y, 0, 1)), ymdLocal(now)];
  if (key === "last-year") return [ymdLocal(new Date(y - 1, 0, 1)), ymdLocal(new Date(y - 1, 11, 31))];
  return [ymdLocal(new Date(y, m, now.getDate() - Number(key) + 1)), ymdLocal(now)];
}
const PRESET_LABEL = { "this-month": "This month", "last-month": "Last month", "30": "Last 30 days", "90": "Last 90 days",
                       "this-year": "This year", "last-year": "Last year" };
const shortDay = s => new Date(s + "T00:00").toLocaleDateString(undefined, { month: "short", day: "numeric",
  ...(s.slice(0, 4) !== String(new Date().getFullYear()) ? { year: "numeric" } : {}) });
function renderDateControls() {
  const preset = Object.keys(PRESET_LABEL).find(k => { const [a, b] = rangeFor(k); return a === state.start && b === state.end; });
  const btn = document.getElementById("dateBtn");
  btn.textContent = preset ? PRESET_LABEL[preset]
    : state.start && state.end ? `${shortDay(state.start)} – ${shortDay(state.end)}`
    : state.start ? `From ${shortDay(state.start)}` : state.end ? `Until ${shortDay(state.end)}` : "All dates";
  btn.classList.toggle("active", !!(state.start || state.end));
  for (const b of document.querySelectorAll("#datePresets button")) b.setAttribute("aria-pressed", b.dataset.range === preset);
  document.getElementById("start").value = state.start;
  document.getElementById("end").value = state.end;
  document.getElementById("dateClear").disabled = !(state.start || state.end);
}
function setDates(start, end) { state.start = start; state.end = end; renderDateControls(); load(); }
document.getElementById("datePresets").addEventListener("click", e => {
  const b = e.target.closest("button[data-range]");
  if (!b) return;
  setDates(...rangeFor(b.dataset.range));
  setDropdown(DROPDOWNS[3], false);
});
document.getElementById("dateClear").addEventListener("click", () => setDates("", ""));
document.getElementById("start").addEventListener("change", e => setDates(e.target.value, state.end));
document.getElementById("end").addEventListener("change", e => setDates(state.start, e.target.value));
renderDateControls();

// sample data for offline preview only (includes account fields + tags)
const SAMPLE = [
  { id: 1, owner:"me",     plaid_txn_id:"s1", date:"2026-07-20", name:"Whole Foods", merchant_name:"Whole Foods Market", amount:84.12, category:"GROCERIES", pending:false, account_name:"Chase Sapphire", account_mask:"4021", account_subtype:"credit card", datetime:null, tags:["groceries"] },
  { id: 2, owner:"sam"   , plaid_txn_id:"s2", date:"2026-07-20", name:"Shell", merchant_name:"Shell", amount:52.40, category:"TRANSPORTATION", pending:true, account_name:"Amex Blue Cash", account_mask:"1007", account_subtype:"credit card", datetime:null, tags:["car"] },
  { id: 3, owner:"me",     plaid_txn_id:"s3", date:"2026-07-19", name:"Payroll", merchant_name:"ACME Corp", amount:-2450.00, category:"INCOME", pending:false, account_name:"Ally Checking", account_mask:"8890", account_subtype:"checking", datetime:null, tags:[] },
  { id: 4, owner:"sam"   , plaid_txn_id:"s4", date:"2026-07-19", name:"Netflix", merchant_name:"Netflix", amount:15.49, category:"ENTERTAINMENT", pending:false, account_name:"Amex Blue Cash", account_mask:"1007", account_subtype:"credit card", datetime:null, tags:["subscription"] },
  { id: 5, owner:"me",     plaid_txn_id:"s5", date:"2026-07-18", name:"Delta Air", merchant_name:"Delta Airlines", amount:312.00, category:"TRAVEL", pending:false, account_name:"Chase Sapphire", account_mask:"4021", account_subtype:"credit card", datetime:null, tags:["travel","reimbursable"] },
  { id: 6, owner:"sam"   , plaid_txn_id:"s6", date:"2026-07-18", name:"Transfer", merchant_name:"From Savings", amount:-500.00, category:"TRANSFER_IN", pending:false, account_name:"Ally Checking", account_mask:"3312", account_subtype:"checking", datetime:null, tags:[] },
];

// Light/dark toggle. The <head> script already applied the initial theme.
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
  // Until the user picks, keep following the OS setting live.
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", e => {
    if (!localStorage.getItem("minty-theme")) apply(e.matches ? "dark" : "light");
  });
})();

// --- Install as an app (the same handling as GRAZE). Chrome and Edge offer their own prompt,
// behind an Install button; iPhones and iPads have none, so the bar says how; Samsung Internet
// and other phone makers' browsers package an installed site as their own app with an
// outdated Android target, which Google Play Protect blocks ("built for an older version of
// Android"), so on those the bar explains and links Open in Chrome instead. "Not now" hides it
// on this device for 30 days.
const OWN_PACKAGE_BROWSER = /Android.*(SamsungBrowser|MiuiBrowser|HuaweiBrowser|HeyTapBrowser|VivoBrowser|OppoBrowser)/;
function setUpInstall() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (standalone) return;
  let later = 0;
  try { later = Number(localStorage.getItem("minty-install-later")) || 0; } catch {}
  const bar = document.getElementById("install"), how = document.getElementById("installHow");
  const show = () => { if (Date.now() - later > 30 * 864e5) bar.hidden = false; };
  document.getElementById("installNo").addEventListener("click", () => {
    bar.hidden = true;
    try { localStorage.setItem("minty-install-later", String(Date.now())); } catch {}
  });
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) {
    how.innerHTML = "In Safari, tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.";
    return show();
  }
  if (OWN_PACKAGE_BROWSER.test(ua)) {
    how.textContent = "This browser builds its own app package, which Google Play Protect blocks as made for an older Android. Open Minty in Chrome, then tap Install.";
    const here = new URL(location.href), link = document.getElementById("openInChrome");
    link.href = `intent://${here.host}${here.pathname}${here.search}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(here.href)};end`;
    link.hidden = false;
    return show();
  }
  let deferred = null;
  addEventListener("beforeinstallprompt", e => {
    e.preventDefault(); deferred = e;
    document.getElementById("installBtn").hidden = false;
    show();
  });
  document.getElementById("installBtn").addEventListener("click", async () => {
    if (!deferred) return;
    deferred.prompt(); await deferred.userChoice; deferred = null; bar.hidden = true;
  });
  addEventListener("appinstalled", () => { bar.hidden = true; });
}
setUpInstall();


// --- Refresh: clicking the coin reloads everything now and asks for a sync with the banks. The
// request only records it: the next cron run (within 10 minutes) syncs every bank, since sync
// runs only from the cron triggers. Until then the coin turns, and the dashboard checks back
// once a minute, reloading itself when the sync has run.
let syncPoll = null;
const syncBtn = document.getElementById("syncBtn"), syncNote = document.getElementById("syncNote");
const hhmm = iso => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
function reloadAll() { loadItems(); loadAccounts(); load(); loadHealth(); }
function showLastSync(iso) {
  if (!iso) return;
  const d = new Date(iso), today = new Date().toDateString() === d.toDateString();
  document.getElementById("lastSync").textContent = "Last synced " + (today ? hhmm(iso)
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + ", " + hhmm(iso));
  document.getElementById("lastSync").title = d.toLocaleString();
}
function showSync(st, justDone = false) {
  if (st && "last_synced_at" in st) showLastSync(st.last_synced_at);
  syncBtn.classList.toggle("syncing", !!st?.pending);
  syncNote.classList.toggle("done", justDone);
  syncNote.textContent = st?.pending ? ` · syncing with your banks by ${hhmm(st.runs_by)}` : justDone ? " · new data loaded" : "";
}
async function checkSync(wasPending) {
  let st;
  try { const r = await fetch("/sync-request"); if (!r.ok) return; st = await r.json(); } catch { return; }
  showSync(st, wasPending && !st.pending);
  if (wasPending && !st.pending) { reloadAll(); setTimeout(() => { syncNote.textContent = ""; syncNote.classList.remove("done"); }, 60000); }
  clearTimeout(syncPoll);
  if (st.pending) syncPoll = setTimeout(() => checkSync(true), 60000);
}
syncBtn.addEventListener("click", async () => {
  reloadAll();                                      // fresh from Minty's database right away
  try {
    const r = await fetch("/sync-request", { method: "POST" });
    if (r.ok) { const st = await r.json(); showSync(st); clearTimeout(syncPoll); if (st.pending) syncPoll = setTimeout(() => checkSync(true), 60000); }
  } catch {}
});
document.getElementById("feed").addEventListener("click", e => { if (e.target.id === "moreBtn") { e.target.disabled = true; load(true); } });

loadUsers().then(() => { loadItems(); loadAccounts(); load(); loadHealth(); checkSync(false); });
setInterval(() => { if (!document.hidden && !syncBtn.classList.contains("syncing")) checkSync(false); }, 10 * 60 * 1000);   // keep "Last synced" current
setInterval(() => { if (!document.hidden) loadHealth(); }, 5 * 60 * 1000);   // downloads move every 10 minutes
