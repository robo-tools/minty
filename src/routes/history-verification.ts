import type { Env } from "../env";
import type { Config } from "../config";
import { HttpError, json, jsonBody, unprocessable } from "../http";
import type { ItemRow } from "../sync";
import { verifyHistoryPage } from "../history-verification";

/** Deliberate, bounded reconciliation against Plaid. Never changes the sync cursor. */
export async function verify(env: Env, config: Config, request: Request, url: URL): Promise<Response> {
  const owner = url.searchParams.get("owner") || null;
  if (owner && !config.users.has(owner)) throw unprocessable("unknown owner");
  let value: unknown;
  try { value = await jsonBody(request); } catch (e) {
    if (e instanceof HttpError) throw e;
    throw unprocessable("body must be a JSON object");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unprocessable("body must be a JSON object");
  const id = (value as Record<string, unknown>).item_id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) throw unprocessable("item_id must be a positive integer");
  const item = await env.DB.prepare("SELECT * FROM items WHERE id=?1 AND (?2 IS NULL OR owner=?2)")
    .bind(id, owner).first<ItemRow>();
  if (!item || !config.users.has(item.owner) || config.accountOwner.get(item.plaid_account) !== item.owner) {
    throw new HttpError(404, "bank not found");
  }
  return json(await verifyHistoryPage(env, config, item.id, owner));
}
