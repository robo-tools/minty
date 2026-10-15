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
  if (!card.available) return { label:"No longer reported", stale:true };
  if (!bank || bank.status !== "ready" || !card.observed_at || now - new Date(card.observed_at) > 30 * 3600000) return { label:"Needs update", stale:true };
  if (card.is_overdue === 1) return { label:"Bank reports overdue", stale:false };
  const days = daysUntil(card.payment_due_date, now);
  return { label:days === null ? "Due date not reported" : days < 0 ? "Past reported date" : days === 0 ? "Due today" : `Due in ${days} day${days === 1 ? "" : "s"}`, stale:false };
}
