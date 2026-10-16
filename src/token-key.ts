import type { Env } from "./env";
import { FernetError, fernetDecrypt, fernetEncrypt } from "./fernet";

/** Opening stored Plaid access tokens, and changing the key they're stored under (security plan
 * step 5a; SETUP.md, "Changing the encryption key"). TOKEN_ENC_KEY encrypts every token. While the
 * key is being changed, TOKEN_ENC_KEY_PREVIOUS (the old key) still opens the tokens saved under
 * it, and each is saved again under TOKEN_ENC_KEY: when sync next opens it, or by the hourly cron
 * (rekeyTokens), which also reaches banks that don't sync. Setup checks say when none are left
 * and the old key can be deleted. Nothing here logs, returns or stores a decrypted token. */

const MAX_PER_RUN = 50;

// The new ciphertext, only if the row still holds the one that was opened (a bank linked again
// meanwhile keeps its new token). A bank stopped by TOKEN_DOES_NOT_DECRYPT (the key changed before
// TOKEN_ENC_KEY_PREVIOUS was set) is cleared, so sync picks it up again.
// updated_at stays: it means "last synced" to the dashboard.
const SAVE = `UPDATE items SET access_token_enc = ?1,
    status = CASE WHEN last_error = 'TOKEN_DOES_NOT_DECRYPT' THEN 'good' ELSE status END,
    last_error_message = CASE WHEN last_error = 'TOKEN_DOES_NOT_DECRYPT' THEN NULL ELSE last_error_message END,
    last_error_at = CASE WHEN last_error = 'TOKEN_DOES_NOT_DECRYPT' THEN NULL ELSE last_error_at END,
    last_error = CASE WHEN last_error = 'TOKEN_DOES_NOT_DECRYPT' THEN NULL ELSE last_error END
  WHERE id = ?2 AND access_token_enc = ?3`;

const opens = async (enc: string, key: string | undefined): Promise<string | null> => {
  if (!key) return null;
  try {
    return await fernetDecrypt(enc, key);
  } catch (e) {
    if (e instanceof FernetError) return null;
    throw e;
  }
};

async function saveUnderCurrentKey(env: Env, item: { id: number; access_token_enc: string }, token: string): Promise<boolean> {
  const enc = await fernetEncrypt(token, env.TOKEN_ENC_KEY as string);
  const r = await env.DB.prepare(SAVE).bind(enc, item.id, item.access_token_enc).run();
  return (r.meta.changes ?? 0) > 0;
}

/** The access token stored in `item`, opened with TOKEN_ENC_KEY, else with TOKEN_ENC_KEY_PREVIOUS.
 * Throws FernetError when neither opens it. When the previous key opened it, the item is saved
 * again under the current key (best effort: if that fails, the cron tries again). */
export async function openAccessToken(env: Env, item: { id: number; access_token_enc: string }): Promise<string> {
  if (!env.TOKEN_ENC_KEY) throw new FernetError("TOKEN_ENC_KEY is not set");
  const current = await opens(item.access_token_enc, env.TOKEN_ENC_KEY);
  if (current !== null) return current;
  const old = await opens(item.access_token_enc, env.TOKEN_ENC_KEY_PREVIOUS);
  if (old === null) throw new FernetError("invalid token");
  await saveUnderCurrentKey(env, item, old).catch((e) =>
    console.error(`token key: item ${item.id}: saving under the new key failed: ${e instanceof Error ? e.message : e}`));
  return old;
}

export interface TokenKeys { current: number; previous: number; neither: number }

/** How many stored tokens each key opens. With `rekey`, the ones on the previous key are saved
 * again under the current one (the hourly cron). Only while TOKEN_ENC_KEY_PREVIOUS is set: without
 * it there's nothing to do, and this reads nothing. */
export async function tokenKeys(env: Env, rekey = false): Promise<TokenKeys & { rekeyed: number }> {
  const out = { current: 0, previous: 0, neither: 0, rekeyed: 0 };
  if (!env.TOKEN_ENC_KEY || !env.TOKEN_ENC_KEY_PREVIOUS) return out;
  const { results } = await env.DB.prepare("SELECT id, access_token_enc FROM items WHERE access_token_enc <> '' ORDER BY id")
    .all<{ id: number; access_token_enc: string }>();
  for (const item of results) {
    if (await opens(item.access_token_enc, env.TOKEN_ENC_KEY) !== null) { out.current++; continue; }
    const old = await opens(item.access_token_enc, env.TOKEN_ENC_KEY_PREVIOUS);
    if (old === null) { out.neither++; continue; }
    if (rekey && out.rekeyed < MAX_PER_RUN && await saveUnderCurrentKey(env, item, old)) { out.rekeyed++; out.current++; continue; }
    out.previous++;
  }
  return out;
}

/** The hourly cron: every token still on TOKEN_ENC_KEY_PREVIOUS, saved again under TOKEN_ENC_KEY. */
export const rekeyTokens = (env: Env) => tokenKeys(env, true);
