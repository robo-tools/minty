import { vi } from "vitest";

/** In-process stand-in for the Plaid API: intercepts fetch() to *.plaid.com, records every call
 * (path, credentials, body) and replies from queues. Nothing leaves the test. */

export interface PlaidCall { path: string; clientId: string | null; secret: string | null; body: any }

type Reply = { status?: number; body: unknown };

export class FakePlaid {
  calls: PlaidCall[] = [];
  syncPages: Reply[] = [];                         // consumed in order by /transactions/sync
  replies: Record<string, Reply> = {
    "/link/token/create": { body: { link_token: "link-sandbox-abc", expiration: "2026-09-25T00:00:00Z" } },
    "/item/public_token/exchange": { body: { access_token: "access-sandbox-secret", item_id: "plaid-item-1" } },
    "/item/get": { body: { item: { item_id: "plaid-item-1", error: null, consent_expiration_time: null }, request_id: "req-get" } },
  };

  install(): this {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (!url.hostname.endsWith(".plaid.com")) throw new Error(`unexpected fetch to ${url.hostname}`);
      const body = JSON.parse(await req.text());
      this.calls.push({ path: url.pathname, clientId: req.headers.get("PLAID-CLIENT-ID"), secret: req.headers.get("PLAID-SECRET"), body });
      const reply = url.pathname === "/transactions/sync" ? this.syncPages.shift() : this.replies[url.pathname];
      if (!reply) throw new Error(`no fake reply queued for ${url.pathname}`);
      return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
    });
    return this;
  }

  paths(): string[] { return this.calls.map((c) => c.path); }
}

export const plaidError = (code: string, status = 400, type = "ITEM_ERROR"): Reply =>
  ({ status, body: { error_type: type, error_code: code, error_message: "fake", request_id: "req-1" } });

export const account = (id: string, extra: Record<string, unknown> = {}) => ({
  account_id: id, name: `Account ${id}`, mask: "0000", type: "depository", subtype: "checking",
  balances: { current: 100.1, available: 90.25, iso_currency_code: "USD" }, ...extra,
});

export const txn = (id: string, accountId: string, extra: Record<string, unknown> = {}) => ({
  transaction_id: id, account_id: accountId, amount: 12.34, iso_currency_code: "USD", date: "2026-09-20",
  datetime: null, name: `Txn ${id}`, merchant_name: `Merchant ${id}`,
  personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_GROCERIES" },
  pending: false, pending_transaction_id: null, ...extra,
});

export const page = (
  next_cursor: string, has_more: boolean,
  p: { accounts?: unknown[]; added?: unknown[]; modified?: unknown[]; removed?: string[]; update_status?: string | null } = {},
): Reply => ({
  body: {
    accounts: p.accounts ?? [], added: p.added ?? [], modified: p.modified ?? [],
    removed: (p.removed ?? []).map((transaction_id) => ({ transaction_id })),
    next_cursor, has_more, transactions_update_status: p.update_status === undefined ? "HISTORICAL_UPDATE_COMPLETE" : p.update_status, request_id: "req-sync",
  },
});
