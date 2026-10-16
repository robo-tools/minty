import { cardDisplayName } from "./card-names.js";

const BALANCE_FRESH_MS = 30 * 3600000;

export const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
export function money(cents, currency) {
  if (cents == null || !currency) return "Not reported";
  try { return new Intl.NumberFormat(undefined, { style:"currency", currency }).format(cents / 100); }
  catch { return `${(cents / 100).toFixed(2)} ${currency}`; }
}
export const shortDate = value => value ? new Intl.DateTimeFormat(undefined, { month:"short", day:"numeric", year:"numeric", timeZone:"UTC" }).format(new Date(value + "T12:00:00Z")) : "Not reported";
export function daysUntil(value, now = new Date()) {
  if (!value) return null;
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((Date.parse(value + "T00:00:00Z") - today) / 86400000);
}
export function cardState(card, bank, now = new Date()) {
  if (card.id == null && (card.transaction_account_id != null || card.account_id != null)) return { label:card.statement_access ? "Statement details unavailable" : "Statement details not enabled", stale:true };
  if (!card.available) return { label:"No longer reported", stale:true };
  const stale=card.statement_stale ?? (!bank || bank.status !== "ready" || !card.observed_at || now - new Date(card.observed_at) > BALANCE_FRESH_MS);
  if (card.is_overdue === 1) return { label:"Bank reports overdue", stale };
  if (stale) return { label:"Needs update", stale:true };
  const summary=card.payment_summary, estimated=!!statementCurrency(card) && summary?.coverage?.complete === true && summary.remaining_cents != null;
  if (estimated && summary.remaining_cents===0) return { label:"Estimated covered", stale:false };
  if (!estimated && summary?.detected_payment_cents>0) return { label:summary.likely_count>0 && !summary.strong_count ? "Likely payment observed" : "Payment observed", stale:false };
  const days = daysUntil(card.payment_due_date, now);
  return { label:days === null ? "Due date not reported" : days < 0 ? "Past reported date"
    : days === 0 ? estimated ? "Due today" : "Reported date · today"
    : estimated ? `Due in ${days} day${days === 1 ? "" : "s"}` : `Reported date in ${days} day${days === 1 ? "" : "s"}`, stale:false };
}

export const statementCurrency = card => card.statement_currency === undefined ? card.currency : card.statement_currency;
export const hasEstimate = (card, bank, now = new Date()) => !!statementCurrency(card) && !cardState(card, bank, now).stale
  && card.payment_summary?.coverage?.complete === true && card.payment_summary.remaining_cents != null;

/** All amounts stay in their own currency. Minimums are a separate reference, never added. */
export function paymentOverview(cards, bills, banks, horizon = 30, now = new Date()) {
  const bankFor = card => banks.find(bank => bank.id === card.item_id);
  const events = [
    ...cards.filter(card => card.payment_due_date).map(card => ({ kind:"card", date:card.payment_due_date, name:cardDisplayName(card), card,
      amount:hasEstimate(card, bankFor(card), now) ? card.payment_summary.remaining_cents : null, currency:statementCurrency(card),
      minimum:cardState(card, bankFor(card), now).stale ? null : card.minimum_payment_cents })),
    ...bills.filter(bill => !bill.paid_at && !bill.archived_at).map(bill => ({kind:"bill", date:bill.due_date, name:bill.name, bill,
      amount:bill.amount_cents, currency:bill.currency, minimum:null})),
  ].sort((a,b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  const upcoming = events.filter(event => { const days=daysUntil(event.date,now); return days != null && days >= 0 && days <= horizon; });
  const past = events.filter(event => daysUntil(event.date,now) < 0);
  const totals = new Map(); let excluded=0;
  for (const event of upcoming) {
    if (!event.currency) { excluded++; continue; }
    const total=totals.get(event.currency) || { currency:event.currency, amount_cents:0, minimum_cents:0, included:0, minimum_count:0, excluded:0 };
    if (event.amount == null) { total.excluded++; excluded++; } else { total.amount_cents+=event.amount; total.included++; }
    if (event.minimum != null) { total.minimum_cents+=event.minimum; total.minimum_count++; }
    totals.set(event.currency,total);
  }
  return { upcoming,past,totals:[...totals.values()].sort((a,b)=>a.currency.localeCompare(b.currency)),excluded };
}

/** Fixed rolling summaries, independent of calendar/list filters. Unknown amounts
 * stay unknown; reported minimums are only a separate reference. */
export function paymentDueSummaries(cards, bills, banks, now = new Date()) {
  const scope=usdScope(cards,bills,banks);
  return [7,30].map(days => {
    const overview=paymentOverview(scope.statementCards,scope.bills,scope.banks,days,now);
    const total=overview.totals.find(total=>total.currency==='USD');
    const cardEvents=overview.upcoming.filter(event=>event.kind==='card'), reasons=new Map();
    for(const event of cardEvents.filter(event=>event.amount==null)) {
      const card=event.card, coverageReasons=new Set(card.payment_summary?.coverage?.reasons || []);
      if(cardState(card,scope.banks.find(bank=>bank.id===card.item_id),now).stale) coverageReasons.add('Statement details need an update.');
      if(!coverageReasons.size) coverageReasons.add('Complete statement and payment details are not available.');
      for(const reason of coverageReasons) reasons.set(reason,(reasons.get(reason)||0)+1);
    }
    return {days,amount_cents:total?.included ? total.amount_cents : overview.upcoming.length ? null : 0,
      minimum_cents:total?.minimum_count ? total.minimum_cents : null,
      included:total?.included || 0,excluded:overview.excluded,minimum_count:total?.minimum_count || 0,
      card_count:cardEvents.length,bill_count:overview.upcoming.length-cardEvents.length,
      reasons:[...reasons].map(([reason,count])=>({reason,count}))};
  });
}

/** Only changes the Coming up list. Current card balances are not amounts due;
 * keep uncertain balances visible instead of hiding them using statement estimates. */
export function filterUpcoming(events, banks = [], options = {}, now = new Date()) {
  const minimum=Number.isSafeInteger(options.minimumCents) && options.minimumCents >= 0 ? options.minimumCents : null;
  const visible=events.filter(event => {
    if (event.kind === "card") {
      const card=event.card, bank=banks.find(bank => bank.id === card?.item_id);
      const balanceAt=Date.parse(card?.balance_updated_at), age=now - balanceAt;
      if (card?.currency !== "USD" || !Number.isFinite(card?.current_balance_cents)
        || !["ok","expiring"].includes(bank?.health?.state) || !Number.isFinite(balanceAt) || age < 0 || age > BALANCE_FRESH_MS) return true;
      return !(options.hideNonPositiveCards && card.current_balance_cents <= 0)
        && !(minimum !== null && card.current_balance_cents < minimum);
    }
    if (event.kind === "bill") {
      const amount=event.amount ?? event.bill?.amount_cents, currency=event.currency === undefined ? event.bill?.currency : event.currency;
      return minimum === null || currency !== "USD" || !Number.isFinite(amount) || amount >= minimum;
    }
    return true;
  });
  return {visible,hiddenCount:events.length-visible.length};
}

/** Scope this page without converting or relabeling amounts in other currencies. */
export function usdScope(cards, bills, banks) {
  const scopedCards=cards.filter(card => card.currency === "USD" || statementCurrency(card) === "USD").map(card => ({
    ...card, show_usd_balance:card.currency === "USD", show_usd_statement:card.id != null && statementCurrency(card) === "USD",
  }));
  const bankIds=new Set(scopedCards.map(card => card.item_id));
  return { cards:scopedCards, statementCards:scopedCards.filter(card => card.show_usd_statement),
    bills:bills.filter(bill => bill.currency === "USD"), banks:banks.filter(bank => bankIds.has(bank.id)) };
}

const dateOnly = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0,10) === value;

/** Date-only calendar matches the outlook's inclusive today-through-horizon range.
 * Statements are date markers only; their amounts never enter the payment outlook. */
export function upcomingCalendar(cards, bills, banks, horizon = 30, now = new Date()) {
  const scoped=usdScope(cards,bills,banks), startTime=Date.UTC(now.getFullYear(),now.getMonth(),now.getDate());
  const days=Array.from({length:horizon+1},(_,offset) => ({date:new Date(startTime+offset*86400000).toISOString().slice(0,10),events:[]}));
  const byDate=new Map(days.map(day => [day.date,day]));
  for (const event of paymentOverview(scoped.statementCards,scoped.bills,scoped.banks,horizon,now).upcoming)
    byDate.get(event.date)?.events.push({...event,estimated:false});
  for (const card of scoped.statementCards) {
    const reported=[...new Set([card.statement_issue_date,card.next_issue_date].filter(dateOnly))].sort();
    for (const date of reported) byDate.get(date)?.events.push({kind:"statement",date,name:cardDisplayName(card),card,estimated:false,amount:null,currency:null,minimum:null});
    const forecast=card.estimated_next_statement_date, latest=reported.at(-1);
    if (dateOnly(forecast) && (!latest || forecast > latest))
      byDate.get(forecast)?.events.push({kind:"statement",date:forecast,name:cardDisplayName(card),card,estimated:true,amount:null,currency:null,minimum:null});
  }
  const order={card:0,bill:1,statement:2};
  for (const day of days) day.events.sort((a,b) => order[a.kind]-order[b.kind] || a.name.localeCompare(b.name));
  return {start:days[0].date,end:days.at(-1).date,days};
}

/** Reuses the API's bank health and payment coverage; a past date alone is not an unpaid verdict. */
export function attentionItems(cards, bills, banks, now = new Date()) {
  const items=[];
  for (const bank of banks) if (bank.health?.state && bank.health.state !== "ok")
    items.push({ name:bank.institution_name || "Bank", detail:bank.health.message || "Review this connection.", target:"banksTitle" });
  for (const card of cards) {
    const bank=banks.find(b=>b.id===card.item_id), summary=card.payment_summary, reasons=[];
    const state=cardState(card,bank,now), days=daysUntil(card.payment_due_date,now);
    if (card.is_overdue === 1) reasons.push("Bank reports overdue");
    if (days != null && days >= 0 && days <= 7 && (!hasEstimate(card,bank,now) || summary.remaining_cents > 0)) reasons.push(days === 0 ? "Payment date is today" : `Payment date in ${days} day${days===1 ? "" : "s"}`);
    if (card.id == null) reasons.push(card.statement_access ? "This bank has not reported statement details for this card" : "Statement details require Liabilities access");
    else {
      if (state.stale) reasons.push("Statement details need an update");
      if (!card.payment_due_date) reasons.push("Payment date not reported; confirm with the issuer");
      if (!summary?.coverage?.complete) reasons.push("Payment history is incomplete; remaining amount unavailable");
      if (summary?.likely_count) reasons.push(`${summary.likely_count} likely payment match${summary.likely_count===1 ? "" : "es"} ${hasEstimate(card,bank,now) ? "included in the estimate" : "observed; estimate unavailable"}`);
      if (summary?.discrepancy) reasons.push(summary.discrepancy_reason || "Reported last payment differs from observed transactions");
    }
    if (reasons.length) items.push({name:cardDisplayName(card),detail:reasons.join(" · "),target:"cardsTitle"});
  }
  for (const bill of bills) {
    const days=daysUntil(bill.due_date,now);
    if (!bill.paid_at && !bill.archived_at && days != null && days >= 0 && days <= 7)
      items.push({name:bill.name,detail:`Manual bill · ${days===0 ? "due today" : `due in ${days} day${days===1 ? "" : "s"}`} · ${money(bill.amount_cents,bill.currency)}`,target:"manualTitle"});
  }
  return items;
}
