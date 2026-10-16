import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { Env } from "../src/env";
import { loadConfig } from "../src/config";
import { fernetEncrypt } from "../src/fernet";
import { saveLiabilities } from "../src/liabilities";
import { syncItem, type ItemRow } from "../src/sync";
import { account, FakePlaid, page } from "./fake-plaid";
import { call, getJson, HOST, loadFixture } from "./helpers";

const E = env as unknown as Env;
const PATH = "/liabilities/card-display";
const prefs = (extra: Record<string, unknown> = {}) => ({ transaction_account_id: 10, nickname: "Travel", display_mask: "35678", ...extra });
const post = (body: unknown, query = "", init: Parameters<typeof call>[1] = {}) => getJson(`${PATH}${query}`, {
  method: "POST", body: JSON.stringify(body), ...init,
});
const rows = async () => (await E.DB.prepare("SELECT * FROM card_display_preferences").all()).results;
const overview = async () => (await getJson("/liabilities")).body.cards;
const card = async () => (await overview()).find((c: any) => c.transaction_account_id === 10);
const statementPayload = (name = "Bank statement name", mask = "6611") => ({
  accounts: [account("acct-10", { name, mask, type: "credit", subtype: "credit card" })],
  liabilities: { credit: [{ account_id: "acct-10", last_statement_balance: 300,
    last_statement_issue_date: "2026-09-20", next_payment_due_date: "2026-10-17" }] },
});
const statement = async () => {
  await saveLiabilities(E, 1, statementPayload());
  return (await E.DB.prepare("SELECT id FROM card_liabilities WHERE item_id=1").first<{ id: number }>())!.id;
};

beforeEach(async () => {
  await loadFixture();
  await E.DB.prepare("DELETE FROM app_state WHERE key LIKE 'rows_read:%'").run();
});
afterEach(() => vi.restoreAllMocks());

describe("card display preferences", () => {
  it("saves an account-only card without changing reported data, transactions, or sync cursors", async () => {
    await E.DB.prepare("UPDATE items SET txn_cursor='existing-cursor',sync_start_cursor='in-progress' WHERE id=1").run();
    const before = await E.DB.batch([E.DB.prepare("SELECT * FROM accounts"), E.DB.prepare("SELECT * FROM items"), E.DB.prepare("SELECT * FROM transactions")]);
    expect((await post(prefs({ nickname: "  Biz Plat  " }))).body).toEqual({ nickname: "Biz Plat", display_mask: "35678" });
    expect(await card()).toMatchObject({ id: null, transaction_account_id: 10, name: "Sapphire", mask: "9912",
      nickname: "Biz Plat", display_mask: "35678" });
    const after = await E.DB.batch([E.DB.prepare("SELECT * FROM accounts"), E.DB.prepare("SELECT * FROM items"), E.DB.prepare("SELECT * FROM transactions")]);
    expect(after.map(result => result.results)).toEqual(before.map(result => result.results));
  });

  it("keeps preferences through transaction sync, statement opt-in, and statement refresh", async () => {
    await post(prefs());
    await E.DB.prepare("UPDATE items SET access_token_enc=?,txn_cursor='before' WHERE id=1")
      .bind(await fernetEncrypt("access-test", E.TOKEN_ENC_KEY!)).run();
    const plaid = new FakePlaid().install();
    plaid.syncPages.push(page("after", false, { accounts: [account("acct-10", {
      type: "credit", subtype: "credit card", name: "Changed by bank", mask: "7777",
    })] }));
    const item = (await E.DB.prepare("SELECT * FROM items WHERE id=1").first<ItemRow>())!;
    expect(await syncItem(E, loadConfig(E), item, { pages: 1 })).toBe("good");
    expect(await card()).toMatchObject({ name: "Changed by bank", mask: "7777", nickname: "Travel", display_mask: "35678" });
    const cardId = await statement();
    await saveLiabilities(E, 1, statementPayload("New statement name", "5555"));
    expect(await card()).toMatchObject({ id: cardId, nickname: "Travel", display_mask: "35678" });
    expect((await getJson(`/liabilities/history?account_id=${cardId}`)).body.card)
      .toMatchObject({ nickname: "Travel", display_mask: "35678" });
    expect(await rows()).toHaveLength(1);
  });

  it("keeps statement-only cards editable and shares one preference across both local ids", async () => {
    const cardId = await statement();
    await post(prefs());
    expect((await post({ card_id: cardId, nickname: "Statement nickname", display_mask: "0042" })).status).toBe(200);
    expect(await rows()).toHaveLength(1);
    await E.DB.prepare("DELETE FROM accounts WHERE id=10").run();
    expect((await post({ card_id: cardId, nickname: "Archived card", display_mask: null })).status).toBe(200);
    expect((await overview()).find((c: any) => c.id === cardId)).toMatchObject({ transaction_account_id: null,
      name: "Bank statement name", mask: "6611", nickname: "Archived card", display_mask: null });
    expect((await getJson(`/liabilities/history?account_id=${cardId}`)).body.card.nickname).toBe("Archived card");
  });

  it("supports either preference by itself and makes repeated reset harmless", async () => {
    expect((await post(prefs({ nickname: null }))).body).toEqual({ nickname: null, display_mask: "35678" });
    expect((await post(prefs({ display_mask: null }))).body).toEqual({ nickname: "Travel", display_mask: null });
    for (const nickname of [null, "   "]) {
      expect((await post(prefs({ nickname, display_mask: null }))).body).toEqual({ nickname: null, display_mask: null });
      expect(await rows()).toEqual([]);
      expect(await card()).toMatchObject({ name: "Sapphire", mask: "9912", nickname: null, display_mask: null });
    }
  });

  it("does not carry a preference to a different bank with the same provider account key", async () => {
    await post(prefs());
    await saveLiabilities(E, 2, statementPayload());
    const other = (await overview()).find((c: any) => c.item_id === 2);
    expect(other).toMatchObject({ nickname: null, display_mask: null });
    await E.DB.prepare("DELETE FROM items WHERE id=1").run();
    expect(await rows()).toEqual([]);
  });

  it.each([
    {}, { card_id: 1, transaction_account_id: 10 }, { card_id: null, transaction_account_id: 10 },
    { transaction_account_id: 0 }, { transaction_account_id: -1 }, { transaction_account_id: 1.5 },
    { transaction_account_id: "10" }, { transaction_account_id: 9007199254740992 },
    { card_id: null }, { card_id: "1" }, { card_id: 0 }, { item_id: 1, plaid_account_id: "acct-10" },
  ])("rejects malformed or ambiguous targets without writing: %j", async target => {
    await post(prefs());
    const before = await rows();
    expect((await post({ ...target, nickname: "Change", display_mask: null })).status).toBe(422);
    expect(await rows()).toEqual(before);
  });

  it.each([
    { nickname: undefined }, { display_mask: undefined }, { nickname: 123 }, { nickname: "x".repeat(81) },
    { nickname: "Hello\nthere" }, { nickname: "\tTrimmed control" }, { nickname: "Bad\u007fname" },
    { nickname: "Bad\u0085name" }, { display_mask: 35678 }, { display_mask: "" }, { display_mask: "123" },
    { display_mask: "123456" }, { display_mask: "123456789012345" }, { display_mask: "35O78" },
    { display_mask: "٣٥٦٧٨" }, { display_mask: " 35678" }, { display_mask: "35678\n" },
  ])("rejects invalid preference fields without writing: %j", async fields => {
    await post(prefs());
    const before = await rows();
    expect((await post(prefs(fields))).status).toBe(422);
    expect(await rows()).toEqual(before);
  });

  it("rejects absent cards, noncredit accounts, unknown owners and owner mismatches without writes", async () => {
    const cardId = await statement();
    await post(prefs());
    const before = await rows();
    for (const target of [{ transaction_account_id: 999 }, { transaction_account_id: 11 }, { card_id: 999 }]) {
      expect((await post({ ...target, nickname: "Change", display_mask: null })).status).toBe(404);
    }
    expect((await post(prefs(), "?owner=unknown")).status).toBe(422);
    expect((await post(prefs(), "?owner=spouse")).status).toBe(404);
    expect((await post({ card_id: cardId, nickname: null, display_mask: null }, "?owner=spouse")).status).toBe(404);
    expect((await post(prefs(), "", { envOverrides: { MINTY_USERS: "spouse:Spouse" } })).status).toBe(404);
    expect((await post(prefs(), "", { envOverrides: { PLAID_SLOTS: "backup" } })).status).toBe(404);
    expect(await rows()).toEqual(before);
    expect((await post(prefs(), "?owner=me", { envOverrides: { PLAID_SECRET_ME_PRIMARY: "" } })).status).toBe(200);
  });

  it("requires an object body and accepts an 80-character nickname and leading-zero mask", async () => {
    for (const body of [null, [], "text", 1]) expect((await post(body)).status).toBe(422);
    expect((await call(PATH, { method: "POST", body: "{" })).status).toBe(422);
    expect(await rows()).toEqual([]);
    expect((await post(prefs({ nickname: "x".repeat(80), display_mask: "00008" }))).status).toBe(200);
  });

  it("preserves Access, same-origin, general rate limiting, no-cache and identifier privacy", async () => {
    const init = { method: "POST", body: JSON.stringify(prefs()) };
    expect((await call(PATH, { ...init, token: null })).status).toBe(403);
    expect((await call(PATH, { ...init, headers: { origin: "https://elsewhere.test" } })).status).toBe(403);
    expect((await call(PATH, { ...init, headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await call(PATH, { ...init, envOverrides: { ALLOWED_LOGINS: "other@example.com" } })).status).toBe(403);
    expect((await call(PATH, { ...init, envOverrides: { RL_GENERAL: { limit: async () => ({ success: false }) } } })).status).toBe(429);
    expect(await rows()).toEqual([]);
    const response = await call(PATH, { ...init, headers: { origin: HOST } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).not.toMatch(/plaid_account|access_token|acct-10|gAAAA/);
    expect((await call(PATH)).status).toBe(405);
  });
});
