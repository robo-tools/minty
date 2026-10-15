import { esc, money, shortDate, daysUntil, cardState, hasEstimate, paymentOverview, attentionItems, statementCurrency } from "/bills-format.js";
const $ = id => document.getElementById(id);
let users = [], data = { banks:[], cards:[] }, manual = [], horizon = 30, nextHistory = null, historyRequest = 0, loadRequest = 0, poll, hasLoaded = false;
const label = owner => users.find(u => u.key === owner)?.label || owner;
const stamp = value => value ? new Date(value).toLocaleString(undefined, { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" }) : "Not yet updated";
async function api(path, body) {
  const response = await fetch(path, { cache:"no-store", ...(body === undefined ? {} : { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.detail || `Request failed (${response.status})`);
  return result;
}
const bankFor = card => data.banks.find(b => b.id === card.item_id);
const paymentLabel = remaining => remaining === 0 ? "Estimated covered" : "Estimated remaining full statement";
function paymentBreakdown(summary, currency, statementId, stale = false) {
  const complete = summary?.coverage?.complete && summary.remaining_cents != null && !stale;
  if (!summary) return '<div class="payment-breakdown"><p class="sub">Payment coverage unavailable. The reported statement is excluded from upcoming totals.</p></div>';
  const reasons = [...(summary.coverage?.reasons || [])];
  if (stale && !reasons.some(reason => reason.startsWith("Statement details need an update"))) reasons.unshift("Statement details need an update");
  return `<div class="payment-breakdown">
    <div class="remaining"><span class="label">${complete ? paymentLabel(summary.remaining_cents) : "Remaining estimate unavailable"}</span>
      ${complete ? `<strong>${esc(money(summary.remaining_cents,currency))}</strong>` : '<span class="badge warn">Incomplete coverage</span>'}</div>
    <p class="calculation">${summary.statement_balance_cents == null ? 'Statement amount not reported;' : esc(money(summary.statement_balance_cents,currency))+' statement −'} ${esc(money(summary.detected_payment_cents,currency))} observed payments${complete ? ` = ${esc(money(summary.remaining_cents,currency))} estimated remaining` : ''}</p>
    ${complete && summary.detected_payment_cents > Math.max(summary.statement_balance_cents,0) ? '<p class="sub">Remaining estimates stop at zero; excess payments are not carried to another statement.</p>' : ''}
    <p class="sub">${summary.strong_count || 0} classified payment${summary.strong_count===1 ? '' : 's'}${summary.likely_count ? ` · <span class="uncertain">${summary.likely_count} likely match${summary.likely_count===1 ? '' : 'es'} included (${esc(money(summary.likely_payment_cents,currency))})</span>` : ''}</p>
    ${!complete ? `<p class="coverage-note">${esc(reasons.join(" · ") || "Complete posted transaction history is not available.")} This statement is excluded from totals.</p>` : ''}
    ${summary.discrepancy ? `<p class="coverage-note">${esc(summary.discrepancy_reason || "The last payment reported by the bank differs from the observed transactions.")}</p>` : ''}
    <p class="footnote">Payments observed after this statement${summary.window_end_date ? ` through ${esc(shortDate(summary.window_end_date))}` : ''}; not issuer-confirmed allocation. The bank's separate last payment is not subtracted again.</p>
    ${statementId != null ? `<button class="quiet payment-toggle" data-payments="${esc(statementId)}" aria-expanded="false">View detected payments (${summary.payment_count || 0})</button><div class="payment-detail" hidden><div class="payment-list" aria-live="polite"></div><button class="quiet more-payments" data-more-payments="${esc(statementId)}" hidden>More payments</button></div>` : ''}
  </div>`;
}
function eventHtml(event) {
  const card=event.card, bill=event.bill, past=daysUntil(event.date)<0;
  const date = new Date(event.date + "T12:00:00Z"), month = date.toLocaleString(undefined,{month:"short",timeZone:"UTC"});
  const state=card ? cardState(card,bankFor(card)) : null;
  const badge=card ? card.is_overdue===1 ? "Bank reports overdue" : past ? "Past date · review" : event.amount===0 ? "Estimated covered" : state.label
    : past ? "Past date · review" : bill.recurrence === "monthly" ? "Monthly" : "One time";
  const detail=card ? `${card.institution_name || "Bank"}${card.mask ? " · ••"+card.mask : ""} · ${label(card.owner)}` : `Manual bill · ${label(bill.owner)}`;
  const amount=event.amount == null ? money(card.statement_balance_cents,event.currency) : money(event.amount,event.currency);
  const amountLabel=card ? event.amount == null ? "Reported statement · excluded" : paymentLabel(event.amount) : "Bill amount";
  return `<div class="event"><time class="event-date" datetime="${esc(event.date)}" title="${esc(shortDate(event.date))}"><span>${esc(month)} ${date.getUTCFullYear()}</span><strong>${date.getUTCDate()}</strong></time>
    <div class="event-info"><span class="event-name">${esc(event.name)}</span> <span class="badge${card?.is_overdue===1 || state?.stale ? ' warn' : ''}">${esc(badge)}</span><p class="sub">${esc(detail)}</p>
    ${card?.payment_summary?.likely_count ? `<p class="sub uncertain">${event.amount == null ? 'Likely payments observed · estimate unavailable' : 'Includes likely payment matches'}</p>` : ''}</div>
    <div class="event-amount"><strong>${esc(amount)}</strong><span class="sub">${esc(amountLabel)}</span>${card ? `<span class="sub">Reported minimum ${esc(money(card.minimum_payment_cents,event.currency))}${state.stale ? ' · needs update' : ''}</span>` : ''}</div></div>`;
}
function render() {
  const overview=paymentOverview(data.cards,manual,data.banks,horizon), attention=attentionItems(data.cards,manual,data.banks);
  const cards=overview.upcoming.filter(e=>e.kind==='card'), bills=overview.upcoming.filter(e=>e.kind==='bill');
  $("summary").innerHTML=`<div class="stat"><span class="label">Dates in the next ${horizon} days</span><span class="value">${overview.upcoming.length}</span><span class="sub">${cards.length} cards · ${bills.length} other bills</span></div>
    <div class="stat"><span class="label">Linked credit cards</span><span class="value">${data.cards.length}</span><span class="sub">${data.cards.filter(c=>c.id != null && c.available).length} with statement details</span></div>
    <div class="stat"><span class="label">Needs attention</span><span class="value">${attention.length}</span><span class="sub">Dates, coverage, and connections</span></div>`;
  $("horizonDescription").textContent=`Payment dates in the next ${horizon} days, including today.`;
  $("totals").innerHTML=overview.totals.map(t=>`<div class="currency-total"><span class="eyebrow">${esc(t.currency)} outlook</span><strong>${t.included ? esc(money(t.amount_cents,t.currency)) : 'Estimate unavailable'}</strong><p class="sub">Estimated statements + manual bills</p><p class="minimum-total">Reported card minimums: ${t.minimum_count ? esc(money(t.minimum_cents,t.currency)) : 'Not available'} <span class="sub">· separate reference</span></p></div>`).join('')
    + (overview.excluded ? `<p class="excluded">${overview.excluded} dated amount${overview.excluded===1 ? ' is' : 's are'} excluded because statement/payment coverage or currency is incomplete. See the reported amounts below.</p>` : '');
  $("upcoming").innerHTML=overview.upcoming.length ? overview.upcoming.map(eventHtml).join('') : `<p class="empty">No payment dates in the next ${horizon} days. Dates not reported by a bank appear in Needs attention.</p>`;
  $("pastPanel").hidden=!overview.past.length;
  $("past").innerHTML=overview.past.map(eventHtml).join('');
  $("attention").innerHTML=attention.length ? `<ul class="attention-list">${attention.map(item=>`<li><a href="#${item.target}">${esc(item.name)}</a><p class="sub">${esc(item.detail)}</p></li>`).join('')}</ul>` : '<p class="empty">No upcoming dates or data issues need attention right now.</p>';
  $("cards").innerHTML = data.cards.length ? data.cards.map(c => {
    const state=cardState(c,bankFor(c)), enabled=c.id != null, statementUnit=statementCurrency(c);
    return `<article class="card"><div class="card-head"><div><h3>${esc(c.name)}</h3><p class="sub">${esc(c.institution_name || 'Bank')}${c.mask ? ' · ••'+esc(c.mask) : ''} · ${esc(label(c.owner))}</p></div><span class="badge${state.stale || c.is_overdue===1 ? ' warn' : ''}">${esc(state.label)}</span></div>
      <dl class="balance-grid"><div><dt>Current balance</dt><dd>${esc(money(c.current_balance_cents,c.currency))}</dd></div><div><dt>Credit limit</dt><dd>${esc(money(c.credit_limit_cents,c.currency))}</dd></div>
      <div class="utilization"><dt>Current utilization</dt><dd>${c.current_utilization == null ? 'Unknown' : `${esc(new Intl.NumberFormat(undefined,{maximumFractionDigits:1}).format(c.current_utilization))}%`}<small>Current balance ÷ reported limit; not credit-bureau utilization.</small></dd></div></dl>
      ${enabled ? `${paymentBreakdown(c.payment_summary,statementUnit,c.statement_id,state.stale)}<dl><div><dt>Original statement balance</dt><dd>${esc(money(c.statement_balance_cents,statementUnit))}<small>Issued ${esc(shortDate(c.statement_issue_date))}</small></dd></div>
      <div><dt>Reported minimum</dt><dd>${esc(money(c.minimum_payment_cents,statementUnit))}</dd></div><div><dt>Reported payment due date</dt><dd>${esc(shortDate(c.payment_due_date))}</dd></div>
      <div><dt>Next statement · Estimated</dt><dd>${c.estimated_next_statement_date ? esc(shortDate(c.estimated_next_statement_date)) : 'Unavailable'}<small>Forecast date only; no amount predicted.</small></dd></div>
      <div><dt>Last bank-reported payment</dt><dd>${esc(money(c.last_payment_cents,statementUnit))}<small>${esc(shortDate(c.last_payment_date))} · supporting information only</small></dd></div>
      <div><dt>Purchase APR</dt><dd>${c.purchase_apr == null ? 'Not reported' : esc(c.purchase_apr)+'%'}</dd></div></dl>` : c.statement_access ? '<div class="enable-details"><p>This bank has not reported statement details for this card. Review its statement connection below.</p><a href="#banksTitle">Review connection</a></div>' : `<div class="enable-details"><p>Enable Liabilities to see reported statements, minimums, payment due dates, and payment estimates.</p><a href="/connect?liabilities=${c.item_id}">Enable statement details</a></div>`}
      <div class="card-footer"><span class="sub">${enabled ? 'Statement checked' : 'Balance checked'} ${esc(stamp(enabled ? c.observed_at : c.balance_updated_at || c.updated_at))}</span>${enabled ? `<button class="quiet" data-history="${c.id}">History (${c.statement_count || 0})</button>` : ''}</div></article>`;
  }).join('') : '<p class="empty">No linked credit cards yet. <a href="/connect">Connect an account</a> to see its balances.</p>';
  const chosen=$("historyCard").value, historyCards=data.cards.filter(c=>c.id!=null);
  $("historyCard").innerHTML='<option value="">Choose a card</option>'+historyCards.map(c=>`<option value="${c.id}">${esc(c.institution_name || 'Bank')} · ${esc(c.name)}${c.mask ? ' · ••'+esc(c.mask) : ''}</option>`).join('');
  if (historyCards.some(c=>String(c.id)===chosen)) $("historyCard").value=chosen;
  else if (chosen) history();
  $("manual").innerHTML=manual.length ? manual.map(b=>`<div class="bill"><div><strong>${esc(b.name)}</strong><p class="sub">${esc(money(b.amount_cents,b.currency))} · ${esc(shortDate(b.due_date))}</p><p class="sub">${esc(label(b.owner))} · ${b.archived_at ? 'Archived' : b.paid_at ? 'Marked paid' : b.recurrence==='monthly' ? 'Monthly' : 'One time'}</p></div>
    <div class="bill-actions">${!b.paid_at && !b.archived_at ? `<button data-paid="${b.id}">Mark paid</button>` : ''}${b.archived_at ? `<button class="quiet" data-restore="${b.id}">Restore</button>` : `<button class="quiet" data-archive="${b.id}">Archive</button>`}</div></div>`).join('') : '<p class="empty">No manual bills yet. Add the bills you want to see alongside your cards.</p>';
  const messages={disabled:'Not enabled. Add statement and payment details to this existing connection.',pending:'Access confirmed. First update is queued, usually within 10 minutes.',ready:'Statement tracking enabled. Details refresh about daily.',consent_required:'Plaid needs you to approve access or sign in again.',unsupported:"This bank or connection doesn't currently provide supported credit-card details.",error:'The last update failed. Saved details remain visible; another attempt is scheduled.'};
  $("banks").innerHTML=data.banks.length ? data.banks.map(b=>`<div class="bank"><div><strong>${esc(b.institution_name || 'Bank')}</strong><p class="sub">${esc(label(b.owner))} · ${esc(messages[b.status] || 'Status unavailable')}</p>
    ${b.synced_at ? `<p class="sub">Statements checked ${esc(stamp(b.synced_at))}</p>` : ''}${b.health?.last_success ? `<p class="sub">Transactions synced ${esc(stamp(b.health.last_success))}</p>` : ''}
    ${b.health?.message ? `<p class="coverage-note">${esc(b.health.message)}</p>` : ''}${b.health?.fix ? `<p class="sub">${esc(b.health.fix)}</p>` : ''}
    ${b.last_error ? `<p class="sub">${esc(b.last_error)}</p>` : ''}</div>
    <div class="bank-actions">${!b.configured ? '<a href="/add-user">Check setup</a>' : ['disabled','consent_required','unsupported','error'].includes(b.status) ? `<a href="/connect?liabilities=${b.id}">${b.status==='disabled' ? 'Enable statement details' : 'Review statement access'}</a>` : `<span class="badge">${b.status==='pending' ? 'Queued' : 'Enabled'}</span>`}${b.health?.action ? '<a href="/">Review bank connection</a>' : ''}</div></div>`).join('') : '<p class="empty">No banks linked yet. <a href="/connect">Connect an account</a> to get started.</p>';
}
async function load() {
  const version=++loadRequest; clearTimeout(poll); $("reload").disabled=true;
  try {
    const query=$("owner").value ? '?owner='+encodeURIComponent($("owner").value) : '';
    const [nextData,nextManual]=await Promise.all([api('/liabilities'+query),api('/manual-bills'+query)]);
    if (version!==loadRequest) return;
    data=nextData; manual=nextManual; hasLoaded=true; render(); $("notice").textContent='';
    if (data.banks.some(b=>b.status==='pending' || b.health?.state==='downloading')) poll=setTimeout(()=>{if (!document.hidden) load();},30000);
  } catch(e) {
    if (version===loadRequest) {
      $("notice").textContent="Couldn't load the overview. "+e.message+' Use Reload to try again.';
      if (!hasLoaded) for (const id of ['summary','totals','upcoming','attention','cards','manual','banks']) $(id).innerHTML='<p class="empty">Unavailable until the overview loads.</p>';
    }
  } finally { if (version===loadRequest) $("reload").disabled=false; }
}
async function history(append=false) {
  const version=++historyRequest,id=$("historyCard").value,before=append ? nextHistory : null; $("moreHistory").hidden=true;
  if (!append) $("history").innerHTML='<p class="empty">'+(id ? 'Loading statements…' : 'Choose a card to see its saved statements.')+'</p>';
  if (!id) return;
  try {
    const result=await api(`/liabilities/history?account_id=${encodeURIComponent(id)}${before ? '&before='+encodeURIComponent(before) : ''}`);
    if (version!==historyRequest) return;
    const html=result.statements.map(s=>`<article class="timeline-entry"><time datetime="${esc(s.issue_date)}">${esc(shortDate(s.issue_date))}</time>
      <strong>${esc(money(s.balance_cents,s.currency))} <span class="sub">original statement</span></strong><p class="sub">Payment date ${esc(shortDate(s.payment_due_date))} · Reported minimum ${esc(money(s.minimum_payment_cents,s.currency))}</p>
      ${paymentBreakdown(s.payment_summary,s.currency,s.id,s.statement_stale)}<p class="sub">First seen ${esc(stamp(s.first_seen_at))}</p></article>`).join('');
    if (append) $("history").insertAdjacentHTML('beforeend',html); else $("history").innerHTML=html || '<p class="empty">No dated statements have been reported for this card yet.</p>';
    nextHistory=result.next_before; $("moreHistory").hidden=!nextHistory;
  } catch(e) { if(version===historyRequest) $("history").textContent="Couldn't load history. "+e.message; }
}
async function payments(button, append=false) {
  const box=button.closest('.payment-breakdown'), detail=box.querySelector('.payment-detail'), list=box.querySelector('.payment-list'), toggle=box.querySelector('.payment-toggle'), more=box.querySelector('.more-payments');
  if (!append && toggle.dataset.loaded) { detail.hidden=!detail.hidden; toggle.setAttribute('aria-expanded',String(!detail.hidden)); return; }
  detail.hidden=false; toggle.setAttribute('aria-expanded','true'); button.disabled=true;
  if (!append) list.innerHTML='<p class="sub">Loading detected payments…</p>';
  try {
    const id=toggle.dataset.payments,before=append ? more.dataset.before : null;
    const result=await api(`/liabilities/payments?statement_id=${encodeURIComponent(id)}${before ? '&before='+encodeURIComponent(before) : ''}`);
    if (!box.isConnected) return;
    const html=result.payments.map(p=>`<div class="detected-payment"><div><strong>${esc(p.name || 'Card payment')}</strong><span class="sub">${esc(shortDate(p.date))} · ${p.evidence==='likely' ? 'Likely match' : 'Payment classification'}</span><span class="sub">${esc(p.reason)}</span></div><strong>${esc(money(p.payment_cents,p.currency))}</strong></div>`).join('');
    if (append) list.insertAdjacentHTML('beforeend',html); else list.innerHTML=html || '<p class="sub">No qualifying posted card payments were observed in this statement window.</p>';
    toggle.dataset.loaded='true'; more.dataset.before=result.next_before || ''; more.hidden=!result.next_before;
  } catch(e) { list.textContent="Couldn't load detected payments. "+e.message; } finally { button.disabled=false; }
}
$("horizon").addEventListener('click',e=>{const button=e.target.closest('[data-days]');if(!button)return;horizon=Number(button.dataset.days);for(const option of $("horizon").querySelectorAll('button'))option.setAttribute('aria-pressed',String(option===button));if(hasLoaded)render();});
$("reload").addEventListener('click',()=>{load();if($("historyCard").value)history();});
$("owner").addEventListener('change',()=>{$("historyCard").value='';history();load();});
$("historyCard").addEventListener('change',()=>history());
$("moreHistory").addEventListener('click',()=>history(true));
$("cards").addEventListener('click',e=>{const button=e.target.closest('[data-history]');if(!button)return;$("historyCard").value=button.dataset.history;history();$("historyTitle").scrollIntoView({block:'start'});$("historyCard").focus({preventScroll:true});});
document.querySelector('main').addEventListener('click',e=>{const button=e.target.closest('[data-payments],[data-more-payments]');if(button)payments(button,button.hasAttribute('data-more-payments'));});
$("addBill").addEventListener('click',()=>{$("billForm").reset();$("billError").textContent='';$("billOwner").value=$("owner").value || users[0]?.key || '';$("billDialog").showModal();});
$("cancelBill").addEventListener('click',()=>$("billDialog").close());
$("billForm").addEventListener('submit',async e=>{
  e.preventDefault();const button=e.target.querySelector('[type="submit"]');button.disabled=true;const fields=Object.fromEntries(new FormData(e.target));
  try {await api('/manual-bills',{...fields,amount_cents:Math.round(Number(fields.amount)*100)});$("billDialog").close();await load();}
  catch(error){$("billError").textContent=error.message;}finally{button.disabled=false;}
});
$("manual").addEventListener('click',async e=>{
  const button=e.target.closest('button');if(!button)return;const action=button.dataset.paid ? 'paid' : button.dataset.restore ? 'restore' : 'archive';
  const id=Number(button.dataset[action]),bill=manual.find(b=>b.id===id);if(!bill)return;button.disabled=true;
  try{await api(`/manual-bills/${id}/${action}`,{due_date:bill.due_date});await load();}catch(error){$("notice").textContent=error.message;button.disabled=false;}
});
function applyTheme(theme){document.documentElement.dataset.theme=theme;const label=theme==='dark' ? 'Switch to light mode' : 'Switch to dark mode';$("themeToggle").setAttribute('aria-label',label);$("themeToggle").title=label;}
applyTheme(document.documentElement.dataset.theme);
$("themeToggle").addEventListener('click',()=>{const next=document.documentElement.dataset.theme==='dark' ? 'light' : 'dark';applyTheme(next);localStorage.setItem('minty-theme',next);});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)load();});
try {
  users=await api('/users');$("owner").innerHTML='<option value="">Everyone</option>'+users.map(u=>`<option value="${esc(u.key)}">${esc(u.label)}</option>`).join('');
  $("billOwner").innerHTML=users.map(u=>`<option value="${esc(u.key)}">${esc(u.label)}</option>`).join('');if(users.length===1)$("owner").value=users[0].key;await load();
}catch(error){$("notice").textContent="Couldn't load setup. "+error.message;}
