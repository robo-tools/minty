import type { Env } from "../env";
import type { Config } from "../config";
import { HttpError, json, jsonBody, unprocessable } from "../http";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
type Bill = { id: number; owner: string; name: string; due_date: string; amount_cents: number; currency: string;
  recurrence: "once" | "monthly"; anchor_day: number; paid_at: string | null; archived_at: string | null };

async function body(request: Request): Promise<Record<string, unknown>> {
  let value;
  try { value = await jsonBody(request); } catch (e) {
    if (e instanceof HttpError) throw e;
    throw unprocessable("body must be a JSON object");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unprocessable("body must be a JSON object");
  return value as Record<string, unknown>;
}

const validDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

/** Retain the original day when February clamps the date (Jan 31 → Feb 28 → Mar 31). */
export function nextMonth(value: string, anchor: number): string {
  const [year, month] = value.split("-").map(Number);
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(anchor, last))).toISOString().slice(0, 10);
}

export async function list(env: Env, config: Config, url: URL): Promise<Response> {
  const owner = url.searchParams.get("owner") || null;
  if (owner && !config.users.has(owner)) throw unprocessable("unknown owner");
  const { results } = await env.DB.prepare(`SELECT * FROM manual_bills WHERE (?1 IS NULL OR owner=?1)
    ORDER BY archived_at IS NOT NULL, paid_at IS NOT NULL, due_date, id LIMIT 1000`).bind(owner).all<Bill>();
  return json(results);
}

export async function create(env: Env, config: Config, request: Request): Promise<Response> {
  const b = await body(request);
  if (typeof b.owner !== "string" || !config.users.has(b.owner)) throw unprocessable("choose an account owner");
  if (typeof b.name !== "string" || !b.name.trim() || b.name.trim().length > 100) throw unprocessable("name must be 1–100 characters");
  if (!Number.isSafeInteger(b.amount_cents) || Number(b.amount_cents) < 0 || Number(b.amount_cents) > 100_000_000_00) throw unprocessable("amount must be between 0 and 100 million");
  if (typeof b.currency !== "string" || !/^[A-Z]{3}$/.test(b.currency)) throw unprocessable("currency must be a three-letter code");
  try { new Intl.NumberFormat("en", { style: "currency", currency: b.currency }); } catch { throw unprocessable("invalid currency"); }
  if (!validDate(b.due_date) || b.due_date < "2000-01-01" || b.due_date > "2099-12-31") throw unprocessable("enter a valid due date between 2000 and 2099");
  if (b.recurrence !== "once" && b.recurrence !== "monthly") throw unprocessable("recurrence must be once or monthly");
  const row = await env.DB.prepare(`INSERT INTO manual_bills(owner,name,amount_cents,currency,due_date,recurrence,anchor_day)
    SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE (SELECT count(*) FROM manual_bills WHERE archived_at IS NULL) < 500 RETURNING id`)
    .bind(b.owner, b.name.trim(), b.amount_cents, b.currency, b.due_date, b.recurrence, Number(b.due_date.slice(-2))).first();
  if (!row) throw new HttpError(409, "Archive an old bill before adding more (500 active bills maximum).");
  return json(row, 201);
}

/** Marking is a local record, never a payment instruction. due_date is an optimistic lock:
 * duplicate clicks and stale tabs cannot advance a recurring bill twice. */
export async function markPaid(env: Env, request: Request, id: number): Promise<Response> {
  const b = await body(request);
  const bill = await env.DB.prepare("SELECT * FROM manual_bills WHERE id=?").bind(id).first<Bill>();
  if (!bill || bill.archived_at) throw new HttpError(404, "bill not found");
  if (bill.paid_at || bill.due_date !== b.due_date) throw new HttpError(409, "This bill changed. Reload the page before marking it paid.");
  const next = bill.recurrence === "monthly" ? nextMonth(bill.due_date, bill.anchor_day) : null;
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO manual_bill_payments(bill_id,due_date,amount_cents,currency,marked_at)
      SELECT id,due_date,amount_cents,currency,${NOW} FROM manual_bills
      WHERE id=?1 AND due_date=?2 AND paid_at IS NULL AND archived_at IS NULL
      ON CONFLICT(bill_id,due_date) DO NOTHING`).bind(id, bill.due_date),
    env.DB.prepare(`UPDATE manual_bills SET due_date=coalesce(?3,due_date), paid_at=CASE WHEN ?3 IS NULL THEN ${NOW} END
      WHERE id=?1 AND due_date=?2 AND paid_at IS NULL AND archived_at IS NULL RETURNING id`).bind(id, bill.due_date, next),
  ]);
  if (!results[1].results.length) throw new HttpError(409, "This bill changed. Reload the page.");
  return json({ id, next_due_date: next });
}

export async function archive(env: Env, id: number): Promise<Response> {
  const row = await env.DB.prepare(`UPDATE manual_bills SET archived_at=${NOW} WHERE id=? RETURNING id`).bind(id).first();
  if (!row) throw new HttpError(404, "bill not found");
  return json(row);
}

export async function restore(env: Env, id: number): Promise<Response> {
  const row = await env.DB.prepare(`UPDATE manual_bills SET archived_at=NULL WHERE id=?
    AND (archived_at IS NULL OR (SELECT count(*) FROM manual_bills WHERE archived_at IS NULL) < 500) RETURNING id`).bind(id).first();
  if (!row) {
    if (!await env.DB.prepare("SELECT id FROM manual_bills WHERE id=?").bind(id).first()) throw new HttpError(404, "bill not found");
    throw new HttpError(409, "Archive another bill before restoring this one (500 active bills maximum).");
  }
  return json(row);
}
