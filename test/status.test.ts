import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { EXPECTED_MIGRATIONS } from "../src/routes/status";
import { call, getJson } from "./helpers";

const byId = (checks: any[]) => Object.fromEntries(checks.map((c) => [c.id, c]));

beforeEach(async () => {
  await env.DB.batch(["transaction_tags", "transactions", "accounts", "items"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

describe("GET /status", () => {
  it("lists every migration file", () => {
    expect(EXPECTED_MIGRATIONS).toEqual(env.TEST_MIGRATIONS.map((m) => m.name));
  });

  it("is behind Access like every API route", async () => {
    expect((await call("/status", { token: null })).status).toBe(403);
  });

  it("reports a healthy setup without revealing any values", async () => {
    const r = await call("/status");
    const text = await r.text();
    const body = JSON.parse(text);
    expect(body.backend).toBe("workers");
    const c = byId(body.checks);
    expect(c.access).toMatchObject({ ok: true, message: expect.stringContaining("me@example.com") });
    expect(c.token_key.ok).toBe(true);
    expect(c.migrations.ok).toBe(true);
    expect(c.plaid_keys_me).toMatchObject({ ok: true, message: "Me: Plaid keys set for primary, backup (2 of 2 slots, up to 20 bank logins)." });
    expect(c.plaid_keys_spouse).toMatchObject({ ok: true, message: "Spouse: Plaid keys set for primary (1 of 2 slots, up to 10 bank logins); backup unused." });
    expect(c.plaid_env).toMatchObject({ ok: false, level: "warn" });            // tests run on sandbox
    expect(text).not.toMatch(/secret_|cid_|uJ2Cr7/);                             // never values
  });

  it("explains a missing or invalid TOKEN_ENC_KEY with how to make one", async () => {
    for (const TOKEN_ENC_KEY of ["", "not-a-key"]) {
      const c = byId((await getJson("/status", { envOverrides: { TOKEN_ENC_KEY } })).body.checks);
      expect(c.token_key).toMatchObject({ ok: false, level: "error", fix: expect.stringContaining("openssl rand -base64 32") });
    }
  });

  it("describes three slots and flags half-set keys as an error", async () => {
    const c = byId((await getJson("/status", { envOverrides: { PLAID_SLOTS: "primary,backup,extra1",
      PLAID_CLIENT_ID_ME_EXTRA1: "c", PLAID_SECRET_ME_EXTRA1: "s", PLAID_SECRET_SPOUSE_BACKUP: "secret-without-id" } })).body.checks);
    expect(c.plaid_keys_me.message).toBe("Me: Plaid keys set for primary, backup, extra1 (3 of 3 slots, up to 30 bank logins).");
    expect(c.plaid_keys_partial_spouse_backup).toMatchObject({ ok: false, level: "error",
      fix: expect.stringContaining("PLAID_CLIENT_ID_SPOUSE_BACKUP") });
    expect(c.plaid_keys_partial_me_primary).toBeUndefined();
  });

  it("flags banks that can't sync because their slot, person or keys are gone", async () => {
    await env.DB.prepare(
      `INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc) VALUES
       ('me', 'me_primary', 'ok', 'x'),
       ('me', 'me_extra1', 'slot-removed', 'x'),
       ('alex', 'alex_primary', 'person-removed', 'x'),
       ('spouse', 'spouse_backup', 'no-keys', 'x')`).run();
    const c = byId((await getJson("/status")).body.checks);
    expect(c.items_stranded).toMatchObject({ ok: false, level: "error" });
    expect(c.items_stranded.message).toMatch(/^3 bank\(s\) can't sync/);
    expect(c.items_stranded.message).toContain("me_extra1 (not in MINTY_USERS / PLAID_SLOTS)");
    expect(c.items_stranded.message).toContain("spouse_backup (no keys)");
    expect(c.items_stranded.message).not.toContain("me_primary");
  });

  it("reports card members per bank for Amex, and for any bank that has them; never as a warning", async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO items (id, owner, plaid_account, plaid_item_id, access_token_enc, institution_name) VALUES
        (1, 'me', 'me_primary', 'amex-au', 'x', 'American Express'),
        (2, 'me', 'me_primary', 'chase', 'x', 'Chase'),
        (3, 'me', 'me_primary', 'amex-solo', 'x', 'American Express'),
        (4, 'me', 'me_primary', 'other', 'x', 'Capital One')`),
      env.DB.prepare(`INSERT INTO accounts (id, owner, item_id, plaid_account_id, name, mask) VALUES
        (10, 'me', 1, 'a10', 'Gold', '1001'), (20, 'me', 2, 'a20', 'Checking', '4821'),
        (30, 'me', 3, 'a30', 'Blue', '1005'), (40, 'me', 4, 'a40', 'Venture', '7777')`),
      env.DB.prepare(`INSERT INTO transactions (owner, account_id, plaid_txn_id, amount_cents, date, account_owner) VALUES
        ('me', 10, 't1', 100, '2026-10-01', 'ALEX MORGAN'), ('me', 10, 't2', 200, '2026-10-02', 'SAM MORGAN -1013'),
        ('me', 10, 't3', 300, '2026-10-03', NULL), ('me', 10, 't3b', 300, '2026-10-04', 'ALEX MORGAN'),
        ('me', 20, 't4', 400, '2026-10-01', NULL),
        ('me', 30, 't5', 500, '2026-10-01', NULL), ('me', 30, 't6', 600, '2026-10-02', NULL),
        ('me', 40, 't7', 700, '2026-10-01', 'JO DOE')`),
    ]);
    const r = await getJson("/status");
    const c = byId(r.body.checks);
    expect(c.card_members_1).toEqual({ id: "card_members_1", ok: true, level: "warn",
      message: "American Express: card member on 3 of 4 transactions (2 card members)." });
    expect(c.card_members_3).toEqual({ id: "card_members_3", ok: true, level: "warn",
      message: "American Express: no card members on its 2 transactions yet. Plaid fills this in only for some accounts, such as Amex authorized-user cards." });
    expect(c.card_members_2).toBeUndefined();                     // a bank without card members: no line
    expect(c.card_members_4.message).toBe("Capital One: card member on 1 of 1 transaction (1 card member).");
    expect(JSON.stringify(r.body)).not.toContain("MORGAN");        // counts only, never the names
  });

  it("flags people without Plaid keys, naming the secrets", async () => {
    const c = byId((await getJson("/status", { envOverrides: { MINTY_USERS: "me:Me,alex:Alex" } })).body.checks);
    expect(c.plaid_keys_alex).toMatchObject({ ok: false, fix: expect.stringContaining("PLAID_CLIENT_ID_ALEX_PRIMARY") });
  });

  it("flags Plaid keys set for someone who isn't in MINTY_USERS, never showing values", async () => {
    // the test env has SPOUSE keys; with only one person configured they'd be silently unused
    const r = await getJson("/status", { envOverrides: { MINTY_USERS: "me:Alex" } });
    const c = byId(r.body.checks);
    expect(c.keys_unused).toMatchObject({ ok: false, level: "warn",
      message: "Plaid keys are set for SPOUSE, who isn't in MINTY_USERS, so they aren't used.",
      fix: expect.stringContaining("me:Alex,spouse:Name") });
    expect(JSON.stringify(r.body)).not.toMatch(/secret_|cid_/);
    // everyone with keys is configured: no warning (the default test setup)
    expect(byId((await getJson("/status")).body.checks).keys_unused).toBeUndefined();
    // blank secrets don't count as set
    const blank = await getJson("/status", { envOverrides: { MINTY_USERS: "me:Alex", PLAID_CLIENT_ID_SPOUSE_PRIMARY: "", PLAID_SECRET_SPOUSE_PRIMARY: "" } });
    expect(byId(blank.body.checks).keys_unused).toBeUndefined();
  });

  it("with one person (the default) there are no checks for anyone else", async () => {
    const c = byId((await getJson("/status", { envOverrides: { MINTY_USERS: "" } })).body.checks);
    expect(c.plaid_keys_me).toMatchObject({ ok: true });
    expect(c.plaid_keys_spouse).toBeUndefined();
    const users = (await getJson("/users", { envOverrides: { MINTY_USERS: "" } })).body;
    expect(users.map((u: any) => [u.key, u.label])).toEqual([["me", "Me"]]);
  });

  it("reports production Plaid and rejects a bad PLAID_ENV", async () => {
    expect(byId((await getJson("/status", { envOverrides: { PLAID_ENV: "production" } })).body.checks).plaid_env.ok).toBe(true);
    const bad = byId((await getJson("/status", { envOverrides: { PLAID_ENV: "development" } })).body.checks).plaid_env;
    expect(bad).toMatchObject({ ok: false, level: "error" });
  });

  it("lists each bank needing attention, the same way the dashboard does, and warns when sync is stale", async () => {
    await env.DB.prepare(
      `INSERT INTO items (id, owner, plaid_account, plaid_item_id, access_token_enc, institution_name, txn_cursor, status, updated_at, last_error, last_error_message) VALUES
       (1, 'me', 'me_primary', 'a', 'x', 'Chase', 'c', 'good', '2026-01-01T00:00:00.000Z', NULL, NULL),
       (2, 'me', 'me_primary', 'b', 'x', 'Ally', 'c', 'login_required', '2026-01-01T00:00:00.000Z', 'ITEM_LOGIN_REQUIRED', 'the login details of this item have changed'),
       (3, 'me', 'me_primary', 'c', 'x', 'Citi', 'c', 'error', '2026-01-01T00:00:00.000Z', 'ITEM_NOT_FOUND', NULL)`).run();
    const body = (await getJson("/status")).body;
    const c = byId(body.checks);
    expect(body.items).toEqual({ good: 1, login_required: 1, error: 1 });
    expect(c.bank_reconnect_2).toMatchObject({ ok: false, level: "error", fix: expect.stringContaining("Reconnect"),
      message: "Ally needs you to sign in again. The bank wants you to sign in again, e.g. after a password change or a new security check. (ITEM_LOGIN_REQUIRED: the login details of this item have changed)" });
    expect(c.bank_broken_3).toMatchObject({ ok: false, level: "error", message: expect.stringContaining("Citi stopped syncing and won't retry.") });
    expect(c.bank_stalled_1).toMatchObject({ ok: false, level: "warn", message: expect.stringMatching(/^Chase hasn't synced for \d+ days \(last successful sync Jan 1\)\. No sync attempt has failed/) });
    expect(c.sync).toMatchObject({ ok: false, message: expect.stringMatching(/No bank has synced for \d+ days/) });
  });

  it("shows a recent sync as healthy", async () => {
    await env.DB.prepare(`INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc, txn_cursor) VALUES ('me', 'me_primary', 'a', 'x', 'c')`).run();
    expect(byId((await getJson("/status")).body.checks).sync).toMatchObject({ ok: true, message: "Last sync within the hour." });
  });

  it("reports only actionable statement warnings from the fork's liability state without changing bank health", async () => {
    const states = ["consent_required", "unsupported", "error", "ready", "pending", "disabled"];
    for (const [index, state] of states.entries()) {
      const id = index + 1;
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO items (id, owner, plaid_account, plaid_item_id, access_token_enc,
          institution_name, txn_cursor) VALUES (?, 'me', 'me_primary', ?, 'private-token-fixture', ?, 'cursor')`)
          .bind(id, `statement-${state}`, `Statement bank ${id}`),
        env.DB.prepare(`INSERT INTO liability_sync (item_id, status, enabled_at, last_error)
          VALUES (?, ?, 'enabled', ?)`)
          .bind(id, state, state === "error" ? "INTERNAL_SERVER_ERROR" : null),
      ]);
    }
    const before = (await env.DB.prepare("SELECT * FROM liability_sync ORDER BY item_id").all()).results;
    const response = await getJson("/status");
    expect(response.status).toBe(200);
    const c = byId(response.body.checks);
    expect(Object.keys(c).filter(key => key.startsWith("statements_"))).toEqual(["statements_1", "statements_2", "statements_3"]);
    expect(c.statements_1).toMatchObject({ ok: false, level: "warn", message: expect.stringContaining("Statement bank 1 needs your consent"),
      fix: "Open Bills → Statement connections and choose Review statement access for this bank." });
    expect(c.statements_2).toMatchObject({ ok: false, level: "warn", message: expect.stringContaining("Statement bank 2 doesn't currently share statement details"),
      fix: "Open Bills → Statement connections to review statement access. Saved statements remain available." });
    expect(c.statements_3).toMatchObject({ ok: false, level: "warn", message: expect.stringContaining("INTERNAL_SERVER_ERROR") });
    expect(response.body.items).toEqual({ good: 6 });
    expect(Object.keys(c).filter(key => key.startsWith("bank_"))).toEqual([]);
    expect((await env.DB.prepare("SELECT * FROM liability_sync ORDER BY item_id").all()).results).toEqual(before);
    expect(JSON.stringify(response.body)).not.toContain("private-token-fixture");
  });

  it("flags a bank that stopped syncing while the others carry on, with its last error", async () => {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3.6e6).toISOString();
    await env.DB.prepare(
      `INSERT INTO items (id, owner, plaid_account, plaid_item_id, access_token_enc, institution_name, txn_cursor, sync_start_cursor,
                          status, updated_at, last_error) VALUES
       (1, 'me', 'me_primary', 'stuck', 'x', 'American Express', 'mid', '', 'good', ?1, 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION'),
       (2, 'me', 'me_primary', 'fine', 'x', 'Chase', 'c', NULL, 'good', ?2, NULL),
       (3, 'me', 'me_primary', 'dl', 'x', 'Citibank Online', 'c', '', 'good', ?2, NULL),
       (4, 'me', 'me_primary', 'relogin', 'x', 'Ally', 'c', NULL, 'login_required', ?1, NULL),
       (5, 'me', 'me_primary', 'quiet', 'x', NULL, 'c', NULL, 'good', ?1, NULL)`).bind(hoursAgo(80), hoursAgo(0.2)).run();
    await env.DB.prepare(`INSERT INTO accounts (id, owner, item_id, plaid_account_id) VALUES (30, 'me', 3, 'acct-30')`).run();
    await env.DB.prepare(`INSERT INTO transactions (owner, account_id, plaid_txn_id, date) VALUES ('me', 30, 't1', '2026-09-01'), ('me', 30, 't2', '2026-09-02')`).run();
    const c = byId((await getJson("/status")).body.checks);
    expect(c.bank_stalled_1).toMatchObject({ ok: false, level: "warn",
      message: expect.stringMatching(/^American Express hasn't synced for 3 days \(last successful sync \w+ \d+\)\. Plaid's data changed during the download, so Minty restarts it automatically\. \(TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION\)$/) });
    expect(c.bank_stalled_5.message).toMatch(/^Bank #5 hasn't synced for 3 days/);
    expect(c.bank_downloading_3).toMatchObject({ ok: true,
      message: "Citibank Online: downloading its history (2 transactions so far). Newer transactions appear once it's done." });
    expect(Object.keys(c).filter((k) => k.endsWith("_2"))).toEqual([]);               // healthy: nothing
    expect(c.bank_reconnect_4).toBeDefined();                        // sign in again, not "stalled"
    expect(c.bank_stalled_4).toBeUndefined();
    expect(c.sync.ok).toBe(true);                                    // the overall check alone missed this
  });

  it("flags the local dev Access bypass", async () => {
    const c = byId((await getJson("/status", { token: null, host: "http://localhost:8787",
      envOverrides: { MINTY_DEV_NO_AUTH: "1", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" } })).body.checks);
    expect(c.access).toMatchObject({ ok: false, level: "warn" });
  });
});
