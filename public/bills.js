import { esc, money, shortDate, daysUntil, cardState, paymentOverview, paymentDueSummaries, attentionItems, statementCurrency, usdScope, upcomingCalendar, filterUpcoming } from "/bills-format.js";
import { cardBaseName, cardEnding, cardDisplayName, cardIssuer, sortCardsByIssuer } from "./card-names.js";
const $ = id => document.getElementById(id);
let users = [], data = { banks:[], cards:[] }, manual = [], horizon = 30, nextHistory = null, historyRequest = 0, loadRequest = 0, poll, hasLoaded = false;
let calendar = null, selectedDay = null, editingCard = null;
const historyVerification=new Map();
let verifyingHistory=null;
const calendarKinds = { statement:true, payment:true };
const UPCOMING_FILTER_KEY='minty-bills-upcoming-filters-v1';
const upcomingFilters=readUpcomingFilters();
function readUpcomingFilters() {
  const defaults={hideNonPositiveCards:false,minimumEnabled:false,minimumCents:10000};
  try {
    const saved=JSON.parse(localStorage.getItem(UPCOMING_FILTER_KEY));
    if (!saved || typeof saved!=='object' || Array.isArray(saved)) return defaults;
    const validMinimum=Number.isSafeInteger(saved.minimumCents) && saved.minimumCents>=0 && saved.minimumCents<=10000000000;
    return {hideNonPositiveCards:saved.hideNonPositiveCards===true,minimumEnabled:saved.minimumEnabled===true && validMinimum,
      minimumCents:validMinimum ? saved.minimumCents : defaults.minimumCents};
  } catch { return defaults; }
}
function saveUpcomingFilters() {
  try { localStorage.setItem(UPCOMING_FILTER_KEY,JSON.stringify(upcomingFilters)); } catch { /* The filters still work for this page when browser storage is unavailable. */ }
}
function syncUpcomingFilterControls() {
  $("hideNonPositiveCards").checked=upcomingFilters.hideNonPositiveCards;
  $("hideSmallAmounts").checked=upcomingFilters.minimumEnabled;
  $("upcomingMinimum").disabled=!upcomingFilters.minimumEnabled;
  $("upcomingMinimum").value=String(upcomingFilters.minimumCents/100);
  $("upcomingMinimum").removeAttribute('aria-invalid');
  $("upcomingFilterError").hidden=true;
  $("showAllUpcoming").hidden=!upcomingFilters.hideNonPositiveCards && !upcomingFilters.minimumEnabled;
}
const label = owner => users.find(u => u.key === owner)?.label || owner;
const stamp = value => value ? new Date(value).toLocaleString(undefined, { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" }) : "Not yet updated";
async function api(path, body) {
  const response = await fetch(path, { cache:"no-store", ...(body === undefined ? {} : { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.detail || `Request failed (${response.status})`);
  return result;
}
function historyVerificationMessage(result) {
  const messages={complete:'History checked against all available Plaid records. Estimates also depend on current connection and statement data.',
    partial:`Verified ${result.checked || 0} of ${result.total || 0} transactions so far. Continue to check the next page.`,
    busy:'Verification is already running. Try again shortly.',
    needs_sync:'History could not be verified. Review this connection’s data status before continuing.',
    retry:'The verification request could not finish. Existing coverage has not been changed.',
    unavailable:'History cannot be verified yet. Check this connection’s status and statement dates.',
    not_found:'No statement period is available to verify.'};
  const reasons={ALREADY_COVERED:'Saved transaction history already covers this statement period. Estimates also depend on current connection and statement data.',
    TRANSACTIONS_NOT_READY:'Saved transactions are not ready for verification. Check for an unfinished download, stale data, or a connection warning.',
    SOURCE_NOT_READY:'Plaid has not supplied a recent successful transaction update, so history cannot be verified yet.',
    SOURCE_ITEM_MISMATCH:'Plaid returned a different bank connection. Verification stopped without changing coverage.',
    SOURCE_ITEM_ERROR:'Plaid reports a problem with this bank connection. Review its connection status before verifying history.',
    SOURCE_ITEM_STATUS_MISSING:'Plaid did not return this bank’s connection status. History cannot be verified from that response.',
    SOURCE_MARKER_MISSING:'Plaid has not supplied the time of its last successful transaction update. History cannot be verified yet.',
    SOURCE_MARKER_INVALID:'Plaid returned an unreadable transaction update time. History cannot be verified from that response.',
    SOURCE_MARKER_FUTURE:'Plaid’s transaction update time is in the future. History cannot be verified until that timestamp is valid.',
    SOURCE_MARKER_STALE:'Plaid’s last successful transaction update was more than 30 hours ago. Verification needs a fresher update from the bank; reloading Minty does not refresh Plaid’s data.',
    SOURCE_FAILURE_MARKER_INVALID:'Plaid returned an unreadable transaction failure time. History cannot be verified from that response.',
    SOURCE_UPDATE_FAILED:'Plaid’s latest transaction update failed. Verification needs a successful bank update; review any connection warning.',
    HISTORY_PAGE_INVALID:'Plaid returned an incomplete or invalid transaction page. Verification stopped without changing coverage.',
    HISTORY_ITEM_MISMATCH:'Plaid’s transaction page belongs to a different bank connection. Verification stopped without changing coverage.',
    HISTORY_ITEM_ERROR:'Plaid reported a connection problem while returning transactions. Review the bank’s connection status.',
    HISTORY_ACCOUNTS_CHANGED:'The accounts in Plaid’s transaction feed differ from the saved accounts. That account mismatch needs review before verification can finish.',
    HISTORY_SOURCE_ACCOUNT_INVALID:'Plaid returned an account without a valid identifier. Verification stopped without changing coverage.',
    HISTORY_SOURCE_ACCOUNT_UNKNOWN:'Plaid returned an account that is not in this bank’s saved accounts. The account list needs to be reconciled before verification can finish.',
    HISTORY_UNREQUESTED_TRANSACTION:'Plaid returned transactions outside the accounts requested for this check. Verification stopped without changing coverage.',
    HISTORY_ACCOUNT_OWNER_CHANGED:'A saved account belongs to a different owner. Verification stopped; the account ownership needs review.',
    HISTORY_SAVED_CREDIT_ACCOUNT_MISSING:'A saved credit card is missing from Plaid’s current account list. That mismatch needs review; it does not confirm the card was closed.',
    HISTORY_DUPLICATE_TRANSACTIONS:'Plaid returned duplicate transactions across the checked pages. Verification stopped rather than counting them twice.',
    HISTORY_TRANSACTION_MISSING:'Plaid includes transactions missing from the saved history. Those missing records need to be retrieved before verification can finish.',
    HISTORY_TRANSACTION_OWNER_CHANGED:'A saved transaction belongs to a different owner. Verification stopped; the account ownership needs review.',
    HISTORY_TRANSACTION_INVALID:'Plaid returned a transaction with invalid or missing fields. Verification stopped without changing coverage.',
    HISTORY_AMOUNT_CHANGED:'Saved transaction amounts differ from Plaid. Those records need to be reconciled before verification can finish.',
    HISTORY_CURRENCY_CHANGED:'Saved transaction currencies differ from Plaid. Those records need review before verification can finish.',
    HISTORY_DATE_CHANGED:'Transaction dates differ from Plaid or fall outside the checked period. Those records need review before verification can finish.',
    HISTORY_NAME_CHANGED:'Saved transaction descriptions differ from Plaid. Those records need review because descriptions can affect payment detection.',
    HISTORY_MERCHANT_CHANGED:'Saved merchant descriptions differ from Plaid. Those records need review because descriptions can affect payment detection.',
    HISTORY_PENDING_CHANGED:'Saved pending or posted status differs from Plaid. Those records need to be reconciled before verification can finish.',
    HISTORY_CLASSIFICATION_CHANGED:'Saved transaction classifications differ from Plaid. Those records need review before verification can finish.',
    HISTORY_TOTAL_CHANGED:'Plaid’s transaction count changed during verification. Start again to check a consistent set.',
    HISTORY_PAGE_MISSING:'Plaid returned no transactions before all reported records were checked. Verification stopped with history still incomplete.',
    HISTORY_MISMATCH:'Saved transactions differ from Plaid. The mismatch needs review; repeating a sync may not resolve older records.',
    PAYMENT_CLASSIFICATION_CHANGED:'Plaid’s current classifications would change which payments are included or their confidence. Those records need review before verification can finish.',
    LOCAL_DATA_CHANGED:'Saved history changed or no longer matches the checked records. Start again if an update just finished; a persistent mismatch needs review.',
    SOURCE_CHANGED:'Plaid’s data changed during verification. Start again to check a consistent set.',
    VERIFICATION_EXPIRED:'This verification session expired. Start again to recheck the records.',
    VERIFICATION_FAILED:'The verification request could not finish. Try again; existing coverage has not been changed.',
    STATEMENT_WINDOW_UNAVAILABLE:'A supported statement period is not available to verify.',
    ITEM_UNAVAILABLE:'This bank is not configured for history verification.'};
  return reasons[result.code] || messages[result.status] || 'History verification did not finish. Review the connection status before continuing.';
}
function historyVerificationNotice(bank) {
  const message=bank.history_verification_status==='failed'
    ? historyVerificationMessage({status:'failed',code:bank.history_verification_code})
    : historyVerification.get(bank.id)?.message;
  return message ? `<p class="coverage-note" role="status">${esc(message)}</p>` : '';
}
const bankFor = card => data.banks.find(b => b.id === card.item_id);
const cardKey = card => card.transaction_account_id != null ? `account:${card.transaction_account_id}` : `card:${card.id}`;
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
    <p class="sub">${summary.strong_count || 0} classified payment${summary.strong_count===1 ? '' : 's'}${summary.likely_count ? ` · <span class="uncertain">${summary.likely_count} likely match${summary.likely_count===1 ? '' : 'es'} ${complete ? 'included' : 'observed'} (${esc(money(summary.likely_payment_cents,currency))})</span>` : ''}</p>
    ${!complete ? `<p class="coverage-note">${esc(reasons.join(" · ") || "Complete posted transaction history is not available.")} This statement is excluded from totals.</p>` : ''}
    ${summary.discrepancy ? `<p class="coverage-note">${esc(summary.discrepancy_reason || "The last payment reported by the bank differs from the observed transactions.")}</p>` : ''}
    ${summary.coverage?.source==='plaid_available_history' ? '<p class="sub">History checked against all transactions available from Plaid. The bank may provide a limited history.</p>' : ''}
    <p class="footnote">Payments observed after this statement${summary.window_end_date ? ` through ${esc(shortDate(summary.window_end_date))}` : ''}; not issuer-confirmed allocation. The bank's separate last payment is not subtracted again.</p>
    ${statementId != null ? `<button class="quiet payment-toggle" data-payments="${esc(statementId)}" aria-expanded="false">View detected payments (${summary.payment_count || 0})</button><div class="payment-detail" hidden><div class="payment-list" aria-live="polite"></div><button class="quiet more-payments" data-more-payments="${esc(statementId)}" hidden>More payments</button></div>` : ''}
  </div>`;
}
function eventHtml(event) {
  const card=event.card, bill=event.bill, past=daysUntil(event.date)<0;
  const date = new Date(event.date + "T12:00:00Z"), month = date.toLocaleString(undefined,{month:"short",timeZone:"UTC"});
  const state=card ? cardState(card,bankFor(card)) : null;
  const badge=card ? state.label
    : past ? "Past date · review" : bill.recurrence === "monthly" ? "Monthly" : "One time";
  const detail=card ? `${card.institution_name || "Bank"}${cardEnding(card) ? " · ••"+cardEnding(card) : ""} · ${label(card.owner)}` : `Manual bill · ${label(bill.owner)}`;
  const unverified=card && event.amount==null;
  const amount=money(unverified ? card.statement_balance_cents : event.amount,event.currency);
  const amountLabel=card ? unverified ? 'Original statement' : paymentLabel(event.amount) : "Bill amount";
  return `<div class="event"><time class="event-date" datetime="${esc(event.date)}" title="${esc(shortDate(event.date))}"><span>${esc(month)} ${date.getUTCFullYear()}</span><strong>${date.getUTCDate()}</strong></time>
    <div class="event-info"><span class="event-name">${esc(event.name)}</span> <span class="badge${card?.is_overdue===1 || state?.stale ? ' warn' : ''}">${esc(badge)}</span><p class="sub">${esc(detail)}</p>
    ${unverified ? '<p class="sub">Reported statement due date</p>' : ''}
    ${card?.payment_summary?.likely_count ? `<p class="sub uncertain">${event.amount == null ? 'Likely payments observed · estimate unavailable' : 'Includes likely payment matches'}</p>` : ''}</div>
    <div class="event-amount"><strong>${esc(amount)}</strong><span class="sub">${esc(amountLabel)}</span>${unverified ? '<span class="sub">Remaining unverified</span>' : ''}${unverified && card.payment_summary?.detected_payment_cents>0 ? `<span class="sub">Payments observed ${esc(money(card.payment_summary.detected_payment_cents,event.currency))}</span>` : ''}${card ? `<span class="sub">Reported minimum ${esc(money(card.minimum_payment_cents,event.currency))}${state.stale ? ' · needs update' : ''}</span>` : ''}</div></div>`;
}
const calendarType = event => event.kind === 'statement' ? event.estimated ? 'Estimated statement' : 'Reported statement' : event.kind === 'card' ? 'Reported payment date' : 'Bill due';
function calendarCounts(events) {
  const statements=events.filter(event=>event.kind==='statement').length, payments=events.length-statements;
  return [calendarKinds.statement ? `${statements} statement date${statements===1 ? '' : 's'}` : '',
    calendarKinds.payment ? `${payments} due date${payments===1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') || 'No event types selected';
}
function calendarName(event) {
  const ending=event.card && cardEnding(event.card), name=event.name;
  return ending && name.endsWith(ending)
    ? `<span class="calendar-chip-name">${esc(name.slice(0,-ending.length).trimEnd())}</span><span class="calendar-chip-ending">${esc(ending)}</span>`
    : `<span class="calendar-chip-name">${esc(name)}</span>`;
}
function renderCalendarDay() {
  const day=calendar?.days.find(d=>d.date===selectedDay);
  if (!day) { $("calendarDay").innerHTML=''; return; }
  const empty=!calendarKinds.statement && !calendarKinds.payment ? 'Choose Statements or Payments & bills to show dates.'
    : calendarKinds.statement && calendarKinds.payment ? 'No reported due dates or expected statements for this day.'
    : calendarKinds.statement ? 'No statements for this day.' : 'No payments or bills due this day.';
  $("calendarDay").innerHTML=`<h3>${esc(shortDate(day.date))}${day.date===calendar.start ? ' · Today' : ''}</h3>`+(day.events.length ? day.events.map(event=>event.kind==='statement'
    ? `<div class="statement-event"><span class="calendar-key statement-key" aria-hidden="true"></span><div><strong>${esc(event.name)}</strong><span class="badge">${esc(calendarType(event))}</span><p class="sub">${esc(event.card.institution_name || 'Bank')}${cardEnding(event.card) ? ' · ••'+esc(cardEnding(event.card)) : ''} · ${esc(label(event.card.owner))}</p><p class="sub">${event.estimated ? 'Expected cycle date; the actual date may change.' : 'Statement issue date reported by the bank.'} ${cardState(event.card,bankFor(event.card)).stale ? 'Statement data needs an update.' : ''}</p></div></div>`
    : eventHtml(event)).join('') : `<p class="empty">${esc(empty)}</p>`);
}
function renderCalendar(scope) {
  calendar=upcomingCalendar(scope.cards,scope.bills,scope.banks,horizon);
  for (const day of calendar.days) day.events=day.events.filter(event=>calendarKinds[event.kind==='statement' ? 'statement' : 'payment']);
  if (!calendar.days.some(day=>day.date===selectedDay)) selectedDay=calendar.days.find(day=>day.events.length)?.date || calendar.start;
  $("calendarRange").textContent=`Today through ${shortDate(calendar.end)} · ${calendarCounts(calendar.days.flatMap(day=>day.events))}`;
  const leading=new Date(calendar.start+'T12:00:00Z').getUTCDay(), trailing=(7-(leading+calendar.days.length)%7)%7;
  const blank='<td class="calendar-blank" aria-hidden="true"></td>';
  const cells=[...Array(leading).fill(blank),...calendar.days.map(day=>{
    const date=new Date(day.date+'T12:00:00Z'), statements=day.events.filter(event=>event.kind==='statement').length, payments=day.events.length-statements;
    return `<td><button class="calendar-date${day.date===calendar.start ? ' today' : ''}" data-calendar-date="${day.date}" aria-pressed="${day.date===selectedDay}" aria-controls="calendarDay" aria-label="${esc(shortDate(day.date))}${day.date===calendar.start ? ', today' : ''}, ${esc(calendarCounts(day.events))}"><span class="calendar-number">${date.getUTCDate()}${date.getUTCDate()===1 || day.date===calendar.start ? `<small>${esc(date.toLocaleString(undefined,{month:'short',timeZone:'UTC'}))}</small>` : ''}</span>
      <span class="calendar-chips" aria-hidden="true">${day.events.slice(0,3).map(event=>`<span class="calendar-chip ${event.kind==='statement' ? 'statement-chip' : 'payment-chip'}" title="${esc(event.name)}"><span>${calendarName(event)}</span><small>${event.kind==='statement' ? event.estimated ? 'Estimated statement' : 'Statement issued' : event.kind==='card' ? event.amount===0 ? 'Estimated covered' : 'Reported payment date' : 'Bill due'}</small></span>`).join('')}${day.events.length>3 ? `<span class="calendar-more">+${day.events.length-3} more</span>` : ''}</span>
      <span class="calendar-markers" aria-hidden="true">${statements ? `<span class="statement-key">${statements}</span>` : ''}${payments ? `<span class="payment-key">${payments}</span>` : ''}</span></button></td>`;
  }),...Array(trailing).fill(blank)];
  const rows=[];for(let i=0;i<cells.length;i+=7)rows.push('<tr>'+cells.slice(i,i+7).join('')+'</tr>');
  $("calendar").innerHTML=`<table class="calendar-grid" aria-label="Statements and payment due dates"><thead><tr>${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(day=>`<th scope="col">${day}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
  renderCalendarDay();
}
function renderUpcoming(overview) {
  const filtered=filterUpcoming(overview.upcoming,data.banks,{hideNonPositiveCards:upcomingFilters.hideNonPositiveCards,
    minimumCents:upcomingFilters.minimumEnabled ? upcomingFilters.minimumCents : null});
  const active=upcomingFilters.hideNonPositiveCards || upcomingFilters.minimumEnabled;
  $("upcomingFilterStatus").hidden=!active;
  $("upcomingFilterStatus").textContent=`${filtered.hiddenCount} hidden · ${filtered.visible.length} shown. Totals include all upcoming items.`;
  $("showAllUpcoming").hidden=!active;
  $("upcoming").innerHTML=filtered.visible.length ? filtered.visible.map(eventHtml).join('') : overview.upcoming.length
    ? '<p class="empty">All upcoming items are hidden by your filters. Choose Show all to see them.</p>'
    : `<p class="empty">No payment dates in the next ${horizon} days. Dates not reported by a bank appear in Needs attention.</p>`;
}
function updateUpcomingFilters() {
  saveUpcomingFilters();
  if(hasLoaded) {
    const scope=usdScope(data.cards,manual,data.banks);
    renderUpcoming(paymentOverview(scope.statementCards,scope.bills,scope.banks,horizon));
  }
}
function dueSummaryHtml(total) {
  const count=total.card_count+total.bill_count, hasAmount=total.amount_cents!=null;
  const minimumLabel=total.minimum_count<total.card_count ? `Reported minimums (${total.minimum_count} of ${total.card_count} cards)` : 'Reported card minimums';
  const value=hasAmount ? money(total.amount_cents,'USD') : total.minimum_cents!=null ? money(total.minimum_cents,'USD') : `${count} payment date${count===1 ? '' : 's'}`;
  const label=!count ? 'No reported payment dates' : hasAmount ? total.excluded ? 'Partial full-payment estimate' : 'Estimated full payments'
    : total.minimum_cents!=null ? `${minimumLabel} only` : 'Amounts need review';
  return `<article class="payment-total"><h3>Due in the next ${total.days} days</h3>
    <strong>${esc(value)}</strong><p class="total-label${total.excluded ? ' uncertain' : ''}">${esc(label)}</p>
    ${count ? `<p class="sub">${total.card_count} card date${total.card_count===1 ? '' : 's'} · ${total.bill_count} bill${total.bill_count===1 ? '' : 's'}</p>` : ''}
    ${hasAmount && total.card_count ? `<p class="minimum-total">${esc(minimumLabel)}: <b>${esc(money(total.minimum_cents,'USD'))}</b><span class="sub"> · separate reference</span></p>` : ''}
    ${total.excluded ? `<details class="total-coverage"><summary>${total.excluded} statement amount${total.excluded===1 ? '' : 's'} ${hasAmount ? 'excluded' : 'unverified'}</summary>
      <p>${hasAmount ? `${total.included} of ${count} amounts included. ` : ''}The full-payment total needs more data.</p>
      <ul>${total.reasons.map(item=>`<li>${esc(item.reason)} (${item.count} card${item.count===1 ? '' : 's'})</li>`).join('')}</ul></details>` : ''}
  </article>`;
}
function render() {
  const scope=usdScope(data.cards,manual,data.banks);
  const overview=paymentOverview(scope.statementCards,scope.bills,scope.banks,horizon), attention=attentionItems(scope.cards.filter(card=>card.show_usd_statement || card.id==null),scope.bills,scope.banks);
  const cards=overview.upcoming.filter(e=>e.kind==='card'), bills=overview.upcoming.filter(e=>e.kind==='bill');
  $("summary").innerHTML=`<div class="stat"><span class="label">Payment dates in the next ${horizon} days</span><span class="value">${overview.upcoming.length}</span><span class="sub">${cards.length} card${cards.length===1 ? '' : 's'} · ${bills.length} other bill${bills.length===1 ? '' : 's'}</span></div>
    <div class="stat"><span class="label">Credit cards</span><span class="value">${scope.cards.length}</span><span class="sub">${scope.statementCards.filter(c=>c.available).length} with statement details</span></div>
    <div class="stat"><span class="label">Needs attention</span><span class="value">${attention.length}</span><span class="sub">Dates, coverage, and connections</span></div>`;
  $("horizonDescription").textContent=`Payment dates in the next ${horizon} days, including today.`;
  renderCalendar(scope);
  $("totals").innerHTML=paymentDueSummaries(data.cards,manual,data.banks).map(dueSummaryHtml).join('');
  renderUpcoming(overview);
  $("pastPanel").hidden=!overview.past.length;
  $("past").innerHTML=overview.past.map(eventHtml).join('');
  $("attention").innerHTML=attention.length ? `<ul class="attention-list">${attention.map(item=>`<li><a href="#${item.target}">${esc(item.name)}</a><p class="sub">${esc(item.detail)}</p></li>`).join('')}</ul>` : '<p class="empty">No upcoming dates or data issues need attention right now.</p>';
  $("cards").innerHTML = scope.cards.length ? scope.cards.map(c => {
    const state=c.id!=null && !c.show_usd_statement ? {label:'Balance only',stale:false} : cardState(c,bankFor(c)), enabled=c.show_usd_statement, statementUnit=statementCurrency(c);
    return `<article class="card"><div class="card-head"><div><h3>${esc(cardDisplayName(c))}</h3><p class="sub">${esc(c.institution_name || 'Bank')}${cardEnding(c) ? ' · ••'+esc(cardEnding(c)) : ''} · ${esc(label(c.owner))}</p></div><span class="badge${state.stale || c.is_overdue===1 ? ' warn' : ''}">${esc(state.label)}</span></div>
      ${c.show_usd_balance ? `<dl class="balance-grid"><div><dt>Current balance</dt><dd>${esc(money(c.current_balance_cents,c.currency))}</dd></div>${!c.is_charge_card || c.credit_limit_cents>0 ? `<div><dt>${c.is_charge_card ? 'Reported limit' : 'Credit limit'}</dt><dd>${esc(money(c.credit_limit_cents,c.currency))}</dd></div>` : ''}
      ${!c.is_charge_card ? `<div class="utilization"><dt>Current utilization</dt><dd>${c.current_utilization == null ? 'Unknown' : `${esc(new Intl.NumberFormat(undefined,{maximumFractionDigits:1}).format(c.current_utilization))}%`}<small>Current balance ÷ reported limit; not credit-bureau utilization.</small></dd></div>` : ''}</dl>` : '<p class="sub">Current balance and limit use another currency and are excluded from this view.</p>'}
      ${enabled ? `${paymentBreakdown(c.payment_summary,statementUnit,c.statement_id,state.stale)}<dl><div><dt>Original statement balance</dt><dd>${esc(money(c.statement_balance_cents,statementUnit))}<small>Issued ${esc(shortDate(c.statement_issue_date))}</small></dd></div>
      <div><dt>Reported minimum</dt><dd>${esc(money(c.minimum_payment_cents,statementUnit))}</dd></div><div><dt>Reported payment due date</dt><dd>${esc(shortDate(c.payment_due_date))}</dd></div>
      <div><dt>Next statement · Estimated</dt><dd>${c.estimated_next_statement_date ? esc(shortDate(c.estimated_next_statement_date)) : 'Unavailable'}<small>Forecast date only; no amount predicted.</small></dd></div>
      <div><dt>Last bank-reported payment</dt><dd>${esc(money(c.last_payment_cents,statementUnit))}<small>${esc(shortDate(c.last_payment_date))} · supporting information only</small></dd></div>
      <div><dt>Purchase APR</dt><dd>${c.purchase_apr == null ? 'Not reported' : esc(c.purchase_apr)+'%'}</dd></div></dl>` : c.id!=null ? '<div class="enable-details"><p>Statement amounts use another currency and are excluded from this view.</p></div>' : c.statement_access ? '<div class="enable-details"><p>This bank has not reported statement details for this card. Review its statement connection below.</p><a href="#banksTitle">Review connection</a></div>' : `<div class="enable-details"><p>Enable Liabilities to see reported statements, minimums, payment due dates, and payment estimates.</p><a href="/connect?liabilities=${c.item_id}">Enable statement details</a></div>`}
      <div class="card-footer"><span class="sub">${enabled ? 'Statement checked' : 'Balance checked'} ${esc(stamp(enabled ? c.observed_at : c.balance_updated_at || c.updated_at))}</span><div class="card-actions"><button class="quiet" data-edit-card="${esc(cardKey(c))}" aria-label="Edit name for ${esc(cardDisplayName(c))}">Edit name</button>${enabled ? `<button class="quiet" data-history="${c.id}">History</button>` : ''}</div></div></article>`;
  }).join('') : '<p class="empty">No credit cards to show. <a href="/connect">Connect an account</a> to see its balances.</p>';
  const chosen=$("historyCard").value, historyCards=sortCardsByIssuer(scope.statementCards), issuerGroups=new Map();
  for(const card of historyCards) {
    const issuer=cardIssuer(card), key=issuer.toLocaleLowerCase();
    if(!issuerGroups.has(key)) issuerGroups.set(key,{issuer,cards:[]});
    issuerGroups.get(key).cards.push(card);
  }
  $("historyCard").innerHTML='<option value="">Choose a card</option>'+[...issuerGroups.values()].map(group=>`<optgroup label="${esc(group.issuer)}">${group.cards.map(c=>`<option value="${c.id}">${esc(cardDisplayName(c))} · ${esc(label(c.owner))}</option>`).join('')}</optgroup>`).join('');
  if (historyCards.some(c=>String(c.id)===chosen)) $("historyCard").value=chosen;
  else if (chosen) history();
  $("manual").innerHTML=scope.bills.length ? scope.bills.map(b=>`<div class="bill"><div><strong>${esc(b.name)}</strong><p class="sub">${esc(money(b.amount_cents,b.currency))} · ${esc(shortDate(b.due_date))}</p><p class="sub">${esc(label(b.owner))} · ${b.archived_at ? 'Archived' : b.paid_at ? 'Marked paid' : b.recurrence==='monthly' ? 'Monthly' : 'One time'}</p></div>
    <div class="bill-actions">${!b.paid_at && !b.archived_at ? `<button data-paid="${b.id}">Mark paid</button>` : ''}${b.archived_at ? `<button class="quiet" data-restore="${b.id}">Restore</button>` : `<button class="quiet" data-archive="${b.id}">Archive</button>`}</div></div>`).join('') : '<p class="empty">No manual bills yet. Add the bills you want to see alongside your cards.</p>';
  const messages={disabled:'Not enabled. Add statement and payment details to this existing connection.',pending:'Access confirmed. First update is queued, usually within 10 minutes.',ready:'Statement tracking enabled. Details refresh about daily.',consent_required:'Plaid needs you to approve access or sign in again.',unsupported:"This bank or connection doesn't currently provide supported credit-card details.",error:'The last update failed. Saved details remain visible; another attempt is scheduled.'};
  $("banks").innerHTML=scope.banks.length ? scope.banks.map(b=>`<div class="bank"><div><strong>${esc(b.institution_name || 'Bank')}</strong><p class="sub">${esc(label(b.owner))} · ${esc(messages[b.status] || 'Status unavailable')}</p>
    ${b.synced_at ? `<p class="sub">Statements checked ${esc(stamp(b.synced_at))}</p>` : ''}${b.health?.last_success ? `<p class="sub">Transactions synced ${esc(stamp(b.health.last_success))}</p>` : ''}
    ${b.transactions_verified_at ? `<p class="sub">History checked against Plaid ${esc(stamp(b.transactions_verified_at))}</p>` : ''}
    ${b.health?.message ? `<p class="coverage-note">${esc(b.health.message)}</p>` : ''}${b.health?.fix ? `<p class="sub">${esc(b.health.fix)}</p>` : ''}
    ${b.last_error ? `<p class="sub">${esc(b.last_error)}</p>` : ''}${historyVerificationNotice(b)}</div>
    <div class="bank-actions">${!b.configured ? '<a href="/add-user">Check setup</a>' : ['disabled','consent_required','unsupported','error'].includes(b.status) ? `<a href="/connect?liabilities=${b.id}">${b.status==='disabled' ? 'Enable statement details' : 'Review statement access'}</a>` : `<span class="badge">${b.status==='pending' ? 'Queued' : 'Enabled'}</span>`}${b.health?.action ? '<a href="/">Review bank connection</a>' : ''}
    ${b.configured && b.status==='ready' && scope.statementCards.some(c=>c.item_id===b.id && c.statement_issue_date && (!b.transactions_history_start_date || c.statement_issue_date<b.transactions_history_start_date) && (['failed','active'].includes(b.history_verification_status) || !(b.transactions_verified_start_date && b.transactions_verified_start_date<=c.statement_issue_date && b.transactions_verified_end_date>=b.transactions_history_start_date && b.transactions_verified_at))) ? `<button class="quiet" data-verify-history="${b.id}"${verifyingHistory!==null ? ' disabled' : ''}>${verifyingHistory===b.id ? 'Verifying…' : b.history_verification_status==='active' || historyVerification.get(b.id)?.status==='partial' ? 'Continue history verification' : 'Verify payment history'}</button>` : ''}</div></div>`).join('') : '<p class="empty">No statement connections to show.</p>';
}
$("banks").addEventListener('click',async e=>{
  const button=e.target.closest('[data-verify-history]');if(!button || verifyingHistory!==null)return;
  const itemId=Number(button.dataset.verifyHistory),owner=$("owner").value;
  verifyingHistory=itemId;
  for(const control of $("banks").querySelectorAll('[data-verify-history]'))control.disabled=true;
  button.textContent='Verifying…';
  try {
    const result=await api('/liabilities/verify-history'+(owner ? '?owner='+encodeURIComponent(owner) : ''),{item_id:itemId});
    historyVerification.set(itemId,{status:result.status,message:historyVerificationMessage(result)});
  }catch(error){historyVerification.set(itemId,{status:'error',message:'Could not verify history. '+error.message});}
  finally {verifyingHistory=null;await load();if($("historyCard").value)history();}
});
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
      if (!hasLoaded) for (const id of ['summary','calendar','totals','upcoming','attention','cards','manual','banks']) $(id).innerHTML='<p class="empty">Unavailable until the overview loads.</p>';
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
    const html=result.statements.filter(s=>s.currency==='USD').map(s=>`<article class="timeline-entry"><time datetime="${esc(s.issue_date)}">${esc(shortDate(s.issue_date))}</time>
      <strong>${esc(money(s.balance_cents,s.currency))} <span class="sub">original statement</span></strong><p class="sub">Payment date ${esc(shortDate(s.payment_due_date))} · Reported minimum ${esc(money(s.minimum_payment_cents,s.currency))}</p>
      ${paymentBreakdown(s.payment_summary,s.currency,s.id,s.statement_stale)}<p class="sub">First seen ${esc(stamp(s.first_seen_at))}</p></article>`).join('');
    if (append) { if(html) $("history").querySelector('.empty')?.remove(); $("history").insertAdjacentHTML('beforeend',html); } else $("history").innerHTML=html || '<p class="empty">No statements on this page.</p>';
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
    const html=result.payments.filter(p=>p.currency==='USD').map(p=>`<div class="detected-payment"><div><strong>${esc(p.name || 'Card payment')}</strong><span class="sub">${esc(shortDate(p.date))} · ${p.evidence==='likely' ? 'Likely match' : 'Payment classification'}</span><span class="sub">${esc(p.reason)}</span></div><strong>${esc(money(p.payment_cents,p.currency))}</strong></div>`).join('');
    if (append) list.insertAdjacentHTML('beforeend',html); else list.innerHTML=html || '<p class="sub">No qualifying posted card payments were observed in this statement window.</p>';
    toggle.dataset.loaded='true'; more.dataset.before=result.next_before || ''; more.hidden=!result.next_before;
  } catch(e) { list.textContent="Couldn't load detected payments. "+e.message; } finally { button.disabled=false; }
}
$("horizon").addEventListener('click',e=>{const button=e.target.closest('[data-days]');if(!button)return;horizon=Number(button.dataset.days);for(const option of $("horizon").querySelectorAll('button'))option.setAttribute('aria-pressed',String(option===button));if(hasLoaded)render();});
syncUpcomingFilterControls();
$("upcomingFilters").addEventListener('submit',e=>{e.preventDefault();});
$("hideNonPositiveCards").addEventListener('change',()=>{upcomingFilters.hideNonPositiveCards=$("hideNonPositiveCards").checked;updateUpcomingFilters();});
$("hideSmallAmounts").addEventListener('change',()=>{upcomingFilters.minimumEnabled=$("hideSmallAmounts").checked;syncUpcomingFilterControls();updateUpcomingFilters();});
$("upcomingMinimum").addEventListener('input',()=>{
  const field=$("upcomingMinimum"),valid=field.validity.valid && field.value!=='' && Number.isFinite(field.valueAsNumber);
  field.setAttribute('aria-invalid',String(!valid));$("upcomingFilterError").hidden=valid;
  if(!valid) $("upcomingFilterError").textContent=`Enter an amount from $0 to $100,000,000, with up to two decimal places. Still using ${money(upcomingFilters.minimumCents,'USD')}.`;
  if(valid) {upcomingFilters.minimumCents=Math.round(field.valueAsNumber*100);updateUpcomingFilters();}
});
$("showAllUpcoming").addEventListener('click',()=>{upcomingFilters.hideNonPositiveCards=false;upcomingFilters.minimumEnabled=false;syncUpcomingFilterControls();updateUpcomingFilters();$("hideNonPositiveCards").focus({preventScroll:true});});
$("calendarFilters").addEventListener('click',e=>{
  const button=e.target.closest('[data-calendar-kind]');if(!button)return;
  const kind=button.dataset.calendarKind;calendarKinds[kind]=!calendarKinds[kind];
  button.setAttribute('aria-pressed',String(calendarKinds[kind]));
  if(hasLoaded)renderCalendar(usdScope(data.cards,manual,data.banks));
});
$("calendar").addEventListener('click',e=>{const button=e.target.closest('[data-calendar-date]');if(!button)return;selectedDay=button.dataset.calendarDate;for(const day of $("calendar").querySelectorAll('button'))day.setAttribute('aria-pressed',String(day===button));renderCalendarDay();});
$("reload").addEventListener('click',()=>{load();if($("historyCard").value)history();});
$("owner").addEventListener('change',()=>{$("historyCard").value='';history();load();});
$("historyCard").addEventListener('change',()=>history());
$("moreHistory").addEventListener('click',()=>history(true));
function previewCardName() {
  if (!editingCard) return;
  $("cardNamePreview").textContent=cardDisplayName({...editingCard,nickname:$("cardNickname").value,display_mask:$("cardEnding").value});
}
function editCard(card) {
  editingCard=card;
  $("cardDisplayForm").reset();
  $("cardNickname").value=card.nickname || '';
  $("cardNickname").placeholder=cardBaseName({...card,nickname:null});
  $("cardEnding").value=card.display_mask || '';
  const amex=/\b(?:American Express|Amex)\b/i.test(card.institution_name || '');
  $("cardEndingLabel").textContent=amex ? 'Last 5 digits (optional)' : 'Card ending (optional)';
  $("cardEnding").placeholder=amex ? 'Last 5 digits from your card' : card.mask || '4 or 5 digits';
  $("cardEndingHelp").textContent=amex ? 'Uses the 4 digits reported by Plaid by default. Enter your card’s last 5 digits to show those instead, or leave blank to keep the default.' : 'Enter 4 or 5 digits, or leave blank to use the ending reported by Plaid.';
  $("cardReportedName").textContent=card.name || 'Not reported';
  $("cardReportedEnding").textContent=card.mask || 'Not reported';
  $("cardDisplayError").textContent='';
  previewCardName();
  $("cardDisplayDialog").showModal();
}
$("cards").addEventListener('click',e=>{
  const edit=e.target.closest('[data-edit-card]');
  if (edit) { const card=data.cards.find(c=>cardKey(c)===edit.dataset.editCard); if(card)editCard(card); return; }
  const button=e.target.closest('[data-history]');if(!button)return;$("historyCard").value=button.dataset.history;history();$("historyTitle").scrollIntoView({block:'start'});$("historyCard").focus({preventScroll:true});
});
$("cardDisplayForm").addEventListener('input',previewCardName);
$("cancelCardDisplay").addEventListener('click',()=>$("cardDisplayDialog").close());
$("resetCardDisplay").addEventListener('click',()=>{$("cardNickname").value='';$("cardEnding").value='';previewCardName();});
$("cardDisplayDialog").addEventListener('close',()=>{editingCard=null;});
$("cardDisplayDialog").addEventListener('cancel',e=>{if($("saveCardDisplay").disabled)e.preventDefault();});
$("cardDisplayForm").addEventListener('submit',async e=>{
  e.preventDefault();if(!editingCard)return;
  const card=editingCard, target=card.transaction_account_id!=null ? {transaction_account_id:card.transaction_account_id} : {card_id:card.id};
  const fields={...target,nickname:$("cardNickname").value.trim() || null,display_mask:$("cardEnding").value.trim() || null};
  const controls=[...e.target.querySelectorAll('button,input')];controls.forEach(control=>control.disabled=true);$("cardDisplayError").textContent='';
  try {
    await api('/liabilities/card-display',fields);$("cardDisplayDialog").close();await load();
    [...$("cards").querySelectorAll('[data-edit-card]')].find(button=>button.dataset.editCard===cardKey(card))?.focus({preventScroll:true});
  } catch(error) {$("cardDisplayError").textContent=error.message;}
  finally {controls.forEach(control=>control.disabled=false);}
});
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
