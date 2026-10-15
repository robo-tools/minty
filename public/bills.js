import { esc, money, shortDate, daysUntil, cardState } from "/bills-format.js";
const $ = id => document.getElementById(id);
let users = [], data = { banks:[], cards:[] }, manual = [], nextHistory = null, historyRequest = 0, loadRequest = 0, poll, hasLoaded = false;
const label = owner => users.find(u => u.key === owner)?.label || owner;
const stamp = value => value ? new Date(value).toLocaleString(undefined, { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" }) : "Not yet updated";
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.detail || `Request failed (${response.status})`);
  return result;
}
const bankFor = card => data.banks.find(b => b.id === card.item_id);
function render() {
  const available = data.cards.filter(c => c.available), fresh = available.filter(c => !cardState(c, bankFor(c)).stale);
  const dates = fresh.filter(c => { const d = daysUntil(c.payment_due_date); return d !== null && d >= 0 && d <= 30; });
  const bills = manual.filter(b => !b.paid_at && !b.archived_at);
  const manualDates = bills.filter(b => daysUntil(b.due_date) >= 0 && daysUntil(b.due_date) <= 30);
  const missing = available.filter(c => !c.payment_due_date || cardState(c, bankFor(c)).stale).length;
  $("summary").innerHTML = `<div class="stat"><span class="label">Dates in the next 30 days</span><span class="value">${dates.length + manualDates.length}</span><span class="sub">${dates.length} cards · ${manualDates.length} other bills</span></div>
    <div class="stat"><span class="label">Cards with statement tracking</span><span class="value">${available.length}</span><span class="sub">${data.banks.filter(b => b.status === "disabled").length} banks not enabled</span></div>
    <div class="stat"><span class="label">Missing or stale card dates</span><span class="value">${missing}</span><span class="sub">Review details with the issuer</span></div>`;
  const events = [
    ...fresh.filter(c => c.payment_due_date && daysUntil(c.payment_due_date) <= 30).map(c => ({ date:c.payment_due_date, name:c.name,
      detail:`${c.institution_name || "Bank"}${c.mask ? " · ••" + c.mask : ""}`, amount:money(c.minimum_payment_cents,c.currency),
      amountLabel:"Reported minimum", badge:cardState(c,bankFor(c)).label, warn:c.is_overdue === 1 || daysUntil(c.payment_due_date) < 0 })),
    ...bills.filter(b => daysUntil(b.due_date) <= 30).map(b => ({ date:b.due_date, name:b.name, detail:`Manual bill · ${label(b.owner)}`,
      amount:money(b.amount_cents,b.currency), amountLabel:"Bill amount", badge:daysUntil(b.due_date) < 0 ? "Not marked paid" : b.recurrence === "monthly" ? "Monthly" : "One time", warn:daysUntil(b.due_date) < 0 })),
  ].sort((a,b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  $("upcoming").innerHTML = events.length ? events.map(e => {
    const date = new Date(e.date + "T12:00:00Z"), month = date.toLocaleString(undefined,{month:"short",timeZone:"UTC"});
    return `<div class="event"><time class="event-date" datetime="${e.date}" title="${esc(shortDate(e.date))}"><span>${esc(month)} ${date.getUTCFullYear()}</span><strong>${date.getUTCDate()}</strong></time>
      <div><span class="event-name">${esc(e.name)}</span> <span class="badge${e.warn ? " warn" : ""}">${esc(e.badge)}</span><p class="sub">${esc(e.detail)}</p></div>
      <div class="event-amount"><strong>${esc(e.amount)}</strong><span class="sub">${e.amountLabel}</span></div></div>`;
  }).join("") : `<p class="empty">No reported dates in the next 30 days. Enable a bank below or add a bill to start tracking.</p>`;

  $("cards").innerHTML = data.cards.length ? data.cards.map(c => {
    const state = cardState(c,bankFor(c));
    return `<article class="card"><div class="card-head"><div><h3>${esc(c.name)}</h3><p class="sub">${esc(c.institution_name || "Bank")} ${c.mask ? " · ••" + esc(c.mask) : ""} · ${esc(label(c.owner))}</p></div>
      <span class="badge${state.stale || c.is_overdue === 1 ? " warn" : ""}">${esc(state.label)}</span></div>
      <dl><div><dt>Current balance</dt><dd>${esc(money(c.current_balance_cents,c.currency))}</dd></div>
      <div><dt>Last statement balance</dt><dd>${esc(money(c.statement_balance_cents,c.currency))}<small>Issued ${esc(shortDate(c.statement_issue_date))}</small></dd></div>
      <div><dt>Reported payment due date</dt><dd>${esc(shortDate(c.payment_due_date))}</dd></div>
      <div><dt>Minimum payment</dt><dd>${esc(money(c.minimum_payment_cents,c.currency))}</dd></div>
      <div><dt>Last reported payment</dt><dd>${esc(money(c.last_payment_cents,c.currency))}<small>${esc(shortDate(c.last_payment_date))}</small></dd></div>
      <div><dt>Purchase APR</dt><dd>${c.purchase_apr == null ? "Not reported" : esc(c.purchase_apr) + "%"}</dd></div></dl>
      <div class="card-footer"><span class="sub">Checked ${esc(stamp(c.observed_at))}</span><button class="quiet" data-history="${c.id}">History (${c.statement_count})</button></div></article>`;
  }).join("") : `<p class="empty">No statement details yet. Enable a bank under Statement connections. Banks may support transactions without supporting statement details.</p>`;

  const chosen = $("historyCard").value;
  $("historyCard").innerHTML = `<option value="">Choose a card</option>` + data.cards.map(c => `<option value="${c.id}">${esc(c.institution_name || "Bank")} · ${esc(c.name)}${c.mask ? " · ••"+esc(c.mask) : ""}</option>`).join("");
  if (data.cards.some(c => String(c.id) === chosen)) $("historyCard").value = chosen;
  else if (chosen) history();

  $("manual").innerHTML = manual.length ? manual.map(b => `<div class="bill"><div><strong>${esc(b.name)}</strong><p class="sub">${esc(money(b.amount_cents,b.currency))} · ${esc(shortDate(b.due_date))}</p><p class="sub">${esc(label(b.owner))} · ${b.archived_at ? "Archived" : b.paid_at ? "Marked paid" : b.recurrence === "monthly" ? "Monthly" : "One time"}</p></div>
    <div class="bill-actions">${!b.paid_at && !b.archived_at ? `<button data-paid="${b.id}">Mark paid</button>` : ""}${b.archived_at ? `<button class="quiet" data-restore="${b.id}">Restore</button>` : `<button class="quiet" data-archive="${b.id}">Archive</button>`}</div></div>`).join("") : `<p class="empty">No manual bills yet. Add the bills you want to see alongside your cards.</p>`;
  const messages = {
    disabled:"Not enabled. Add statement and payment details to this existing connection.",
    pending:"Access confirmed. First update is queued, usually within 10 minutes.",
    ready:"Statement tracking enabled. Details refresh about daily.",
    consent_required:"Plaid needs you to approve access or sign in again.",
    unsupported:"This bank or connection doesn't currently provide supported credit-card details.",
    error:"The last update failed. Saved details remain visible; another attempt is scheduled.",
  };
  $("banks").innerHTML = data.banks.length ? data.banks.map(b => `<div class="bank"><div><strong>${esc(b.institution_name || "Bank")}</strong><p class="sub">${esc(label(b.owner))} · ${esc(messages[b.status] || "Status unavailable")}</p>
    ${b.synced_at ? `<p class="sub">Last checked ${esc(stamp(b.synced_at))}</p>` : ""}${b.status === "ready" && !data.cards.some(c => c.item_id === b.id && c.available) ? `<p class="sub">No supported credit-card accounts were returned.</p>` : ""}
    ${b.last_error ? `<p class="sub">${esc(b.last_error)}</p>` : ""}</div>
    ${!b.configured ? '<a href="/add-user">Check setup</a>' : ["disabled","consent_required","unsupported","error"].includes(b.status) ? `<a href="/connect?liabilities=${b.id}">${b.status === "disabled" ? "Enable statement details" : "Review access"}</a>` : '<span class="badge">'+(b.status === "pending" ? "Queued" : "Enabled")+'</span>'}</div>`).join("") : '<p class="empty">No banks linked yet. <a href="/connect">Connect an account</a> to get started.</p>';
}

async function load() {
  const version = ++loadRequest;
  clearTimeout(poll);
  $("reload").disabled = true;
  try {
    const query = $("owner").value ? "?owner=" + encodeURIComponent($("owner").value) : "";
    const [nextData, nextManual] = await Promise.all([api("/liabilities"+query),api("/manual-bills"+query)]);
    if (version !== loadRequest) return;
    data=nextData; manual=nextManual; hasLoaded=true; render();
    $("notice").textContent = "";
    if (data.banks.some(b => b.status === "pending")) poll = setTimeout(() => { if (!document.hidden) load(); },30000);
  } catch (e) {
    if (version === loadRequest) {
      $("notice").textContent = "Couldn't load the overview. " + e.message + " Use Reload to try again.";
      if (!hasLoaded) for (const id of ["summary","upcoming","cards","manual","banks"]) $(id).innerHTML='<p class="empty">Unavailable until the overview loads.</p>';
    }
  }
  finally { if (version === loadRequest) $("reload").disabled = false; }
}

async function history(append=false) {
  const version = ++historyRequest, id = $("historyCard").value;
  const before = append ? nextHistory : null;
  $("moreHistory").hidden = true;
  if (!append) $("history").innerHTML = '<p class="empty">'+(id ? "Loading statements…" : "Choose a card to see its saved statements.")+'</p>';
  if (!id) return;
  try {
    const result = await api(`/liabilities/history?account_id=${encodeURIComponent(id)}${before ? "&before="+encodeURIComponent(before) : ""}`);
    if (version !== historyRequest) return;
    const html = result.statements.map(s => `<article class="timeline-entry"><time datetime="${esc(s.issue_date)}">${esc(shortDate(s.issue_date))}</time>
      <strong>${esc(money(s.balance_cents,s.currency))} <span class="sub">statement balance</span></strong><p class="sub">Payment date ${esc(shortDate(s.payment_due_date))} · Minimum ${esc(money(s.minimum_payment_cents,s.currency))}</p>
      <p class="sub">First seen ${esc(stamp(s.first_seen_at))}</p></article>`).join("");
    if (append) $("history").insertAdjacentHTML("beforeend",html); else $("history").innerHTML = html || '<p class="empty">No dated statements have been reported for this card yet.</p>';
    nextHistory = result.next_before; $("moreHistory").hidden = !nextHistory;
  } catch (e) { if (version === historyRequest) $("history").textContent = "Couldn't load history. " + e.message; }
}

$("reload").addEventListener("click",load);
$("owner").addEventListener("change",() => { $("historyCard").value=""; history(); load(); });
$("historyCard").addEventListener("change",() => history());
$("moreHistory").addEventListener("click",() => history(true));
$("cards").addEventListener("click",e => { const button=e.target.closest("[data-history]"); if (!button) return; $("historyCard").value=button.dataset.history; history(); $("historyTitle").scrollIntoView({block:"start"}); $("historyCard").focus({preventScroll:true}); });
$("addBill").addEventListener("click",() => { $("billForm").reset(); $("billError").textContent=""; $("billOwner").value=$("owner").value || users[0]?.key || ""; $("billDialog").showModal(); });
$("cancelBill").addEventListener("click",() => $("billDialog").close());
$("billForm").addEventListener("submit",async e => {
  e.preventDefault(); const button=e.target.querySelector('[type="submit"]'); button.disabled=true;
  const fields=Object.fromEntries(new FormData(e.target));
  try { await api("/manual-bills",{...fields,amount_cents:Math.round(Number(fields.amount)*100)}); $("billDialog").close(); await load(); }
  catch(error) { $("billError").textContent=error.message; } finally { button.disabled=false; }
});
$("manual").addEventListener("click",async e => {
  const button=e.target.closest("button"); if (!button) return;
  const action=button.dataset.paid ? "paid" : button.dataset.restore ? "restore" : "archive";
  const id=Number(button.dataset[action]), bill=manual.find(b => b.id===id); if (!bill) return;
  button.disabled=true;
  try { await api(`/manual-bills/${id}/${action}`,{due_date:bill.due_date}); await load(); }
  catch(error) { $("notice").textContent=error.message; button.disabled=false; }
});
function applyTheme(theme) {
  document.documentElement.dataset.theme=theme;
  const label=theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  $("themeToggle").setAttribute("aria-label",label); $("themeToggle").title=label;
}
applyTheme(document.documentElement.dataset.theme);
$("themeToggle").addEventListener("click",() => { const next=document.documentElement.dataset.theme==="dark" ? "light":"dark"; applyTheme(next); localStorage.setItem("minty-theme",next); });
document.addEventListener("visibilitychange",() => { if (!document.hidden) load(); });

try {
  users=await api("/users");
  $("owner").innerHTML='<option value="">Everyone</option>'+users.map(u => `<option value="${esc(u.key)}">${esc(u.label)}</option>`).join("");
  $("billOwner").innerHTML=users.map(u => `<option value="${esc(u.key)}">${esc(u.label)}</option>`).join("");
  if (users.length === 1) $("owner").value=users[0].key;
  await load();
} catch(error) { $("notice").textContent="Couldn't load setup. "+error.message; }
