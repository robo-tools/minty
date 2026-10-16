import type { Env } from "../env";
import type { Config } from "../config";
import { HttpError, json, jsonBody, unprocessable } from "../http";

type Target = { item_id: number; plaid_account_id: string; owner: string; plaid_account: string };

/** Only local numeric ids are accepted. The stable provider account key stays inside D1,
 * and the separate preference row survives bank syncs and later statement opt-in. */
export async function save(env: Env, config: Config, request: Request, url: URL): Promise<Response> {
  const owner = url.searchParams.get("owner") || null;
  if (owner && !config.users.has(owner)) throw unprocessable("unknown owner");
  let value: unknown;
  try { value = await jsonBody(request); } catch (e) {
    if (e instanceof HttpError) throw e;
    throw unprocessable("body must be a JSON object");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unprocessable("body must be a JSON object");
  const body = value as Record<string, unknown>;
  const accountTarget = Object.hasOwn(body, "transaction_account_id");
  const cardTarget = Object.hasOwn(body, "card_id");
  if (accountTarget === cardTarget) throw unprocessable("choose exactly one transaction_account_id or card_id");
  const id = accountTarget ? body.transaction_account_id : body.card_id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) throw unprocessable("card target must be a positive integer");
  if (body.nickname !== null && (typeof body.nickname !== "string" || body.nickname.trim().length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(body.nickname))) {
    throw unprocessable("nickname must be null or up to 80 characters without control characters");
  }
  if (body.display_mask !== null && (typeof body.display_mask !== "string" || !/^[0-9]{4,5}$/.test(body.display_mask))) {
    throw unprocessable("display_mask must be null or the last 4 or 5 digits");
  }
  const nickname = typeof body.nickname === "string" ? body.nickname.trim() || null : null;
  const displayMask = body.display_mask as string | null;
  const source = accountTarget
    ? "accounts a JOIN items i ON i.id=a.item_id WHERE a.id=?1 AND a.type='credit'"
    : "card_liabilities a JOIN items i ON i.id=a.item_id WHERE a.id=?1";
  const target = await env.DB.prepare(`SELECT a.item_id,a.plaid_account_id,i.owner,i.plaid_account
    FROM ${source} AND (?2 IS NULL OR i.owner=?2)`).bind(id, owner).first<Target>();
  if (!target || !config.users.has(target.owner) || config.accountOwner.get(target.plaid_account) !== target.owner) {
    throw new HttpError(404, "card not found");
  }
  if (nickname === null && displayMask === null) {
    await env.DB.prepare("DELETE FROM card_display_preferences WHERE item_id=? AND plaid_account_id=?")
      .bind(target.item_id, target.plaid_account_id).run();
  } else {
    await env.DB.prepare(`INSERT INTO card_display_preferences(item_id,plaid_account_id,nickname,display_mask)
      VALUES(?1,?2,?3,?4) ON CONFLICT(item_id,plaid_account_id) DO UPDATE SET
      nickname=excluded.nickname,display_mask=excluded.display_mask,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
      .bind(target.item_id, target.plaid_account_id, nickname, displayMask).run();
  }
  return json({ nickname, display_mask: displayMask });
}
