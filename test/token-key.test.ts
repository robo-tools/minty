import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { loadConfig } from "../src/config";
import { FernetError, fernetDecrypt, fernetEncrypt } from "../src/fernet";
import { syncItem, type ItemRow } from "../src/sync";
import { openAccessToken, rekeyTokens, tokenKeys } from "../src/token-key";
import type { Env } from "../src/env";
import { FakePlaid, page } from "./fake-plaid";
import { getJson } from "./helpers";

// Changing TOKEN_ENC_KEY (security plan step 5a): TOKEN_ENC_KEY_PREVIOUS opens the old tokens,
// and each is saved again under the new key.
const OLD = "dGhpcy1pcy1hbm90aGVyLXRlc3Qta2V5LTMyYnl0ZXM=";
const OTHER = "eWV0LWFub3RoZXIta2V5LW5vYm9keS1oYXMtMzJieXQ=";
const E = env as unknown as Env;
const ROTATING = { ...E, TOKEN_ENC_KEY_PREVIOUS: OLD } as Env;
const config = loadConfig(E);
const SECRET = "access-sandbox-secret";
let plaid: FakePlaid;
let logs: string[];

async function addItem(key: string, o: { status?: string; last_error?: string | null } = {}): Promise<ItemRow> {
  return (await env.DB.prepare(
    `INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc, status, last_error, last_error_message, last_error_at)
     VALUES ('me', 'me_primary', ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).bind(`item-${crypto.randomUUID()}`, await fernetEncrypt(SECRET, key), o.status ?? "good", o.last_error ?? null,
    o.last_error ? "the key was changed" : null, o.last_error ? "2026-10-01T00:00:00.000Z" : null).first<ItemRow>())!;
}
const stored = async (id: number) => (await env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<any>())!;
const opensWith = async (enc: string, key: string) => fernetDecrypt(enc, key).then((t) => t === SECRET, () => false);

beforeEach(async () => {
  await env.DB.batch(["transaction_tags", "transactions", "accounts", "items"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  plaid = new FakePlaid().install();
  logs = [];
  for (const level of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  }
});
afterEach(() => {
  expect(logs.join("\n")).not.toContain(SECRET);                       // never a decrypted token in the logs
  vi.restoreAllMocks();
});

describe("openAccessToken", () => {
  it("without TOKEN_ENC_KEY_PREVIOUS: the current key only, as before", async () => {
    const now = await addItem(E.TOKEN_ENC_KEY!);
    expect(await openAccessToken(E, now)).toBe(SECRET);
    const old = await addItem(OLD);
    await expect(openAccessToken(E, old)).rejects.toBeInstanceOf(FernetError);
    expect((await stored(old.id)).access_token_enc).toBe(old.access_token_enc);
  });

  it("opens a token on the previous key and saves it again under the current one", async () => {
    const item = await addItem(OLD);
    expect(await openAccessToken(ROTATING, item)).toBe(SECRET);
    const after = await stored(item.id);
    expect(after.access_token_enc).not.toBe(item.access_token_enc);
    expect(await opensWith(after.access_token_enc, E.TOKEN_ENC_KEY!)).toBe(true);
    expect(after.updated_at).toBe((item as ItemRow & { updated_at: string }).updated_at);   // "last synced" doesn't move
  });

  it("never overwrites a token that changed since it was read (a bank linked again meanwhile)", async () => {
    const item = await addItem(OLD);
    const relinked = await fernetEncrypt("access-relinked", E.TOKEN_ENC_KEY!);
    await env.DB.prepare("UPDATE items SET access_token_enc = ? WHERE id = ?").bind(relinked, item.id).run();
    expect(await openAccessToken(ROTATING, item)).toBe(SECRET);
    expect((await stored(item.id)).access_token_enc).toBe(relinked);
  });

  it("a token neither key opens is still an error", async () => {
    await expect(openAccessToken(ROTATING, await addItem(OTHER))).rejects.toBeInstanceOf(FernetError);
  });

  it("an invalid TOKEN_ENC_KEY_PREVIOUS opens nothing, and doesn't break the current key", async () => {
    const bad = { ...E, TOKEN_ENC_KEY_PREVIOUS: "not-a-key" } as Env;
    expect(await openAccessToken(bad, await addItem(E.TOKEN_ENC_KEY!))).toBe(SECRET);
    await expect(openAccessToken(bad, await addItem(OLD))).rejects.toBeInstanceOf(FernetError);
  });
});

describe("sync during a key change", () => {
  it("syncs a bank still on the old key with its real token, and moves it to the new key", async () => {
    const item = await addItem(OLD);
    plaid.syncPages.push(page("c1", false));
    expect(await syncItem(ROTATING, config, item, { pages: 1 })).toBe("good");
    expect(plaid.calls.map((c) => c.body.access_token)).toEqual([SECRET]);
    expect(await opensWith((await stored(item.id)).access_token_enc, E.TOKEN_ENC_KEY!)).toBe(true);
  });
});

describe("rekeyTokens (the hourly cron) and tokenKeys", () => {
  it("does nothing without TOKEN_ENC_KEY_PREVIOUS", async () => {
    const item = await addItem(OLD);
    expect(await rekeyTokens(E)).toEqual({ current: 0, previous: 0, neither: 0, rekeyed: 0 });
    expect((await stored(item.id)).access_token_enc).toBe(item.access_token_enc);
  });

  it("moves every token on the old key, including banks sync skips, and recovers TOKEN_DOES_NOT_DECRYPT", async () => {
    const current = await addItem(E.TOKEN_ENC_KEY!);
    const old = await addItem(OLD);
    const stopped = await addItem(OLD, { status: "error", last_error: "TOKEN_DOES_NOT_DECRYPT" });
    const reconnect = await addItem(OLD, { status: "login_required", last_error: "ITEM_LOGIN_REQUIRED" });
    const lost = await addItem(OTHER, { status: "error", last_error: "TOKEN_DOES_NOT_DECRYPT" });

    expect(await tokenKeys(ROTATING)).toEqual({ current: 1, previous: 3, neither: 1, rekeyed: 0 });   // counting changes nothing
    expect((await stored(old.id)).access_token_enc).toBe(old.access_token_enc);

    expect(await rekeyTokens(ROTATING)).toEqual({ current: 4, previous: 0, neither: 1, rekeyed: 3 });
    expect((await stored(current.id)).access_token_enc).toBe(current.access_token_enc);            // already on the new key: untouched
    for (const i of [old, stopped, reconnect]) expect(await opensWith((await stored(i.id)).access_token_enc, E.TOKEN_ENC_KEY!)).toBe(true);
    expect(await stored(stopped.id)).toMatchObject({ status: "good", last_error: null, last_error_message: null, last_error_at: null });
    expect(await stored(reconnect.id)).toMatchObject({ status: "login_required", last_error: "ITEM_LOGIN_REQUIRED" });   // other errors stay
    expect(await stored(lost.id)).toMatchObject({ status: "error", last_error: "TOKEN_DOES_NOT_DECRYPT", access_token_enc: lost.access_token_enc });
    expect(await tokenKeys(ROTATING)).toEqual({ current: 4, previous: 0, neither: 1, rekeyed: 0 });
    expect(plaid.calls).toEqual([]);
  });

  it("runs in the hourly cron, after sync", async () => {
    const stopped = await addItem(OLD, { status: "error", last_error: "TOKEN_DOES_NOT_DECRYPT" });
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "17 * * * *" }), ROTATING, ctx);
    await waitOnExecutionContext(ctx);
    expect(await stored(stopped.id)).toMatchObject({ status: "good", last_error: null });
    expect(await opensWith((await stored(stopped.id)).access_token_enc, E.TOKEN_ENC_KEY!)).toBe(true);
  });
});

describe("Setup checks during a key change", () => {
  const check = async (overrides: Record<string, string>) =>
    (await getJson("/status", { envOverrides: overrides })).body.checks.find((c: any) => c.id === "token_key_previous");

  it("say nothing while TOKEN_ENC_KEY_PREVIOUS isn't set", async () => {
    await addItem(OLD);
    expect((await getJson("/status")).body.checks.find((c: any) => c.id === "token_key_previous")).toBeUndefined();
  });

  it("count the banks still on the old key, then say the old key can go", async () => {
    const old = await addItem(OLD);
    await addItem(E.TOKEN_ENC_KEY!);
    expect(await check({ TOKEN_ENC_KEY_PREVIOUS: OLD })).toMatchObject({ ok: false, level: "warn", message: expect.stringContaining("1 bank still on the old key") });
    await openAccessToken(ROTATING, old);
    const done = await check({ TOKEN_ENC_KEY_PREVIOUS: OLD });
    expect(done).toMatchObject({ ok: false, level: "warn", message: expect.stringContaining("isn't needed any more"), fix: expect.stringContaining("Delete the secret TOKEN_ENC_KEY_PREVIOUS") });
    expect(JSON.stringify(done)).not.toContain(OLD);
  });

  it("flag an invalid previous key, and one that's the same as the current key", async () => {
    expect(await check({ TOKEN_ENC_KEY_PREVIOUS: "not-a-key" })).toMatchObject({ ok: false, level: "error" });
    expect(await check({ TOKEN_ENC_KEY_PREVIOUS: E.TOKEN_ENC_KEY! })).toMatchObject({ ok: false, level: "warn", message: expect.stringContaining("same as TOKEN_ENC_KEY") });
  });
});
