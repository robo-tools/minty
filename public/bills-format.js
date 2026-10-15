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
  if (card.statement_stale ?? (!bank || bank.status !== "ready" || !card.observed_at || now - new Date(card.observed_at) > 30 * 3600000)) return { label:"Needs update", stale:true };
  if (card.is_overdue === 1) return { label:"Bank reports overdue", stale:false };
  const days = daysUntil(card.payment_due_date, now);
  return { label:days === null ? "Due date not reported" : days < 0 ? "Past reported date" : days === 0 ? "Due today" : `Due in ${days} day${days === 1 ? "" : "s"}`, stale:false };
}

export const statementCurrency = card => card.statement_currency === undefined ? card.currency : card.statement_currency;
export const hasEstimate = (card, bank, now = new Date()) => !!statementCurrency(card) && !cardState(card, bank, now).stale
  && card.payment_summary?.coverage?.complete === true && card.payment_summary.remaining_cents != null;

/** All amounts stay in their own currency. Minimums are a separate reference, never added. */
export function paymentOverview(cards, bills, banks, horizon = 30, now = new Date()) {
  const bankFor = card => banks.find(bank => bank.id === card.item_id);
  const events = [
    ...cards.filter(card => card.payment_due_date).map(card => ({ kind:"card", date:card.payment_due_date, name:card.name, card,
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
    if (reasons.length) items.push({name:card.name,detail:reasons.join(" · "),target:"cardsTitle"});
  }
  for (const bill of bills) {
    const days=daysUntil(bill.due_date,now);
    if (!bill.paid_at && !bill.archived_at && days != null && days >= 0 && days <= 7)
      items.push({name:bill.name,detail:`Manual bill · ${days===0 ? "due today" : `due in ${days} day${days===1 ? "" : "s"}`} · ${money(bill.amount_cents,bill.currency)}`,target:"manualTitle"});
  }
  return items;
}
