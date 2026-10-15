import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController } from "cloudflare:test";
import type { Env } from "../src/env";
import worker from "../src/index";
import { fernetEncrypt } from "../src/fernet";
import { loadConfig } from "../src/config";
import { cardRecords, LIABILITIES_CRON, runLiabilitiesSync, saveLiabilities, syncLiabilities } from "../src/liabilities";
import type { ItemRow } from "../src/sync";
import { accessToken, call, getJson, loadFixture } from "./helpers";
import { account, FakePlaid, plaidError } from "./fake-plaid";

const E = env as unknown as Env;
let plaid: FakePlaid;
const post = (path: string, body: unknown, init: Parameters<typeof call>[1] = {}) => getJson(path, { method:"POST", body:JSON.stringify(body), ...init });
const item = () => E.DB.prepare("SELECT * FROM items WHERE id=1").first<ItemRow>();
const state = () => E.DB.prepare("SELECT * FROM liability_sync WHERE item_id=1").first<any>();
const payload = (extra: Record<string,unknown> = {}) => ({
  accounts:[account("acct-10", {name:"Sapphire", mask:"9912", type:"credit", subtype:"credit card"})],
  liabilities:{credit:[{account_id:"acct-10",last_statement_balance:1234.56,last_statement_issue_date:"2026-09-20",
    minimum_payment_amount:25,next_payment_due_date:"2026-10-17",last_payment_amount:800,last_payment_date:"2026-09-15",
    is_overdue:false,aprs:[{apr_type:"purchase_apr",apr_percentage:19.99}],...extra}],student:null,mortgage:null},
});
const enable = () => E.DB.prepare("INSERT INTO liability_sync(item_id,enabled_at,next_attempt_at) VALUES (1,'2026-01-01','2026-01-01')").run();
const token = () => post("/link/token/liabilities",{item_id:1});

beforeEach(async () => {
  await loadFixture();
  await E.DB.prepare("DELETE FROM link_sessions").run();
  await E.DB.prepare("UPDATE items SET access_token_enc=? WHERE id=1").bind(await fernetEncrypt("access-test",E.TOKEN_ENC_KEY!)).run();
  plaid=new FakePlaid().install();
  plaid.replies["/liabilities/get"]={body:payload()};
});
afterEach(() => vi.restoreAllMocks());

describe("statement consent",() => {
  it("updates the existing Item with additional consent, with no exchange or trial reservation",async () => {
    const response=await token();
    expect(response.status).toBe(200);
    expect(plaid.calls[0]).toMatchObject({clientId:"cid_me_primary",body:{access_token:"access-test",additional_consented_products:["liabilities"]}});
    expect(plaid.calls[0].body.products).toBeUndefined();
    expect(await state()).toBeNull();
    expect(await E.DB.prepare("SELECT operation,purpose FROM link_sessions").first()).toEqual({operation:"update",purpose:"liabilities"});
    const capacity=(await getJson("/capacity")).body.me[0];
    expect(capacity.reserved).toBe(0);
  });
  it("requires live, purpose-bound, same-login sessions and server-confirmed consent",async () => {
    const id=(await token()).body.session_id;
    expect((await post("/link/liabilities/complete",{session_id:id})).status).toBe(409);
    expect(await state()).toBeNull();
    plaid.replies["/item/get"]={body:{item:{consented_products:["transactions","liabilities"]}}};
    expect((await post("/link/liabilities/complete",{session_id:id},{token:await accessToken({email:"other@example.com"})})).status).toBe(409);
    expect((await post("/link/liabilities/complete",{session_id:id})).body).toEqual({item_id:1,status:"pending"});
    expect(await state()).toMatchObject({status:"pending",synced_at:null});
    expect((await post("/link/liabilities/complete",{session_id:id})).status).toBe(409);
    expect(plaid.paths()).not.toContain("/item/public_token/exchange");
    expect(plaid.paths()).not.toContain("/liabilities/get");
  });
  it("rejects reconnect sessions, cancelled sessions and expired sessions before requesting Plaid",async () => {
    plaid.replies["/item/get"]={body:{item:{consented_products:["liabilities"]}}};
    const normal=(await post("/link/token/update",{item_id:1})).body.session_id;
    expect((await post("/link/liabilities/complete",{session_id:normal})).status).toBe(409);
    await post("/link/cancel",{session_id:normal});
    const cancelled=(await token()).body.session_id;
    await post("/link/cancel",{session_id:cancelled});
    expect((await post("/link/liabilities/complete",{session_id:cancelled})).status).toBe(409);
    const expired=(await token()).body.session_id;
    await E.DB.prepare("UPDATE link_sessions SET expires_at='2000-01-01' WHERE id=?").bind(expired).run();
    expect((await post("/link/liabilities/complete",{session_id:expired})).status).toBe(409);
    expect(plaid.paths()).not.toContain("/item/get");
  });
  it("gates data and writes behind Access and refuses cross-site requests",async () => {
    for(const path of ["/liabilities","/liabilities/history?account_id=1","/link/token/liabilities","/link/liabilities/complete"])
      expect((await call(path,{token:null})).status).toBe(403);
    expect((await post("/link/token/liabilities",{item_id:1},{headers:{origin:"https://elsewhere.test"}})).status).toBe(403);
    expect(plaid.calls).toHaveLength(0);
  });
});

describe("liabilities snapshots",() => {
  it("preserves cents and zero values, and validates unknown amounts and impossible dates",() => {
    const record=cardRecords(payload({minimum_payment_amount:0,last_payment_amount:null,last_statement_issue_date:"2026-02-30"}))[0];
    expect(record).toMatchObject({minimum_payment_cents:0,last_payment_cents:null,statement_issue_date:null,statement_balance_cents:123456,is_overdue:0,purchase_apr:19.99});
    expect(() => cardRecords({})).toThrow();
    expect(() => cardRecords({...payload(),accounts:[]})).toThrow();
  });
  it("upserts corrections, keeps older statements, and does not invent statements without dates",async () => {
    await enable();
    await saveLiabilities(E,1,payload());
    await saveLiabilities(E,1,payload({last_statement_balance:1200}));
    await saveLiabilities(E,1,payload({last_statement_balance:null}));
    const current=await E.DB.prepare("SELECT * FROM card_liabilities").first<any>();
    expect(current.statement_balance_cents).toBeNull();
    let history=(await getJson(`/liabilities/history?account_id=${current.id}`)).body;
    expect(history.statements).toHaveLength(1);
    expect(history.statements[0].balance_cents).toBe(120000);
    await saveLiabilities(E,1,payload({last_statement_issue_date:"2026-10-20",last_statement_balance:0,minimum_payment_amount:0}));
    await saveLiabilities(E,1,payload({last_statement_issue_date:null}));
    history=(await getJson(`/liabilities/history?account_id=${current.id}`)).body;
    expect(history.statements.map((s:any)=>s.issue_date)).toEqual(["2026-10-20","2026-09-20"]);
    expect(history.statements[0].balance_cents).toBe(0);
    const before=(await getJson(`/liabilities/history?account_id=${current.id}&before=2026-10-20`)).body;
    expect(before.statements).toHaveLength(1);
  });
  it("marks absent cards unavailable while preserving history, without changing transaction accounts",async () => {
    await enable(); await saveLiabilities(E,1,payload());
    await saveLiabilities(E,1,{accounts:[],liabilities:{credit:null}});
    expect(await E.DB.prepare("SELECT available FROM card_liabilities").first()).toEqual({available:0});
    expect(await E.DB.prepare("SELECT count(*) AS n FROM card_statements").first()).toEqual({n:1});
    expect(await E.DB.prepare("SELECT name,balance_current_cents FROM accounts WHERE id=10").first()).toEqual({name:"Sapphire",balance_current_cents:128455});
  });
  it("rejects invalid responses without clearing the last good snapshot",async () => {
    await enable(); await saveLiabilities(E,1,payload());
    await expect(saveLiabilities(E,1,{accounts:[]})).rejects.toThrow();
    expect(await E.DB.prepare("SELECT available,statement_balance_cents FROM card_liabilities").first()).toEqual({available:1,statement_balance_cents:123456});
  });
  it("keeps credentials and Plaid account identifiers out of read APIs; supports owner filtering",async () => {
    await enable(); await saveLiabilities(E,1,payload());
    const response=await call("/liabilities");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text=await response.text();
    for(const secret of ["access-test","access_token","plaid_account","acct-10","secret_me_primary"]) expect(text).not.toContain(secret);
    expect((await getJson("/liabilities?owner=spouse")).body.cards).toEqual([]);
    expect((await getJson("/liabilities?owner=unknown")).status).toBe(422);
    expect((await getJson("/liabilities/history?account_id=-1")).status).toBe(422);
    expect((await getJson("/liabilities/history?account_id=999")).status).toBe(404);
  });
});

describe("isolated daily polling",() => {
  it("does nothing for unenabled banks, and the separate cron never runs transaction sync",async () => {
    await runLiabilitiesSync(E); expect(plaid.calls).toHaveLength(0);
    await enable();
    await worker.scheduled(createScheduledController({cron:LIABILITIES_CRON}),E,createExecutionContext());
    expect(plaid.paths()).toEqual(["/liabilities/get"]);
    expect(await state()).toMatchObject({status:"ready",last_error:null});
    await runLiabilitiesSync(E); expect(plaid.calls).toHaveLength(1);
  });
  it.each([["PRODUCTS_NOT_SUPPORTED","unsupported"],["ADDITIONAL_CONSENT_REQUIRED","consent_required"],["INTERNAL_SERVER_ERROR","error"]])("isolates %s and retains saved data",async (code,status) => {
    await enable(); await saveLiabilities(E,1,payload());
    plaid.replies["/liabilities/get"]=plaidError(code);
    expect(await syncLiabilities(E,loadConfig(E),(await item())!)).toBe(status);
    expect((await state()).last_error).toBe(code);
    expect((await state()).next_attempt_at === null).toBe(status !== "error");
    expect((await item())!.status).toBe("good");
    expect(await E.DB.prepare("SELECT count(*) AS n FROM card_statements").first()).toEqual({n:1});
  });
  it("leases a due bank once under overlapping cron calls",async () => {
    await enable(); await Promise.all([runLiabilitiesSync(E),runLiabilitiesSync(E)]);
    expect(plaid.paths()).toEqual(["/liabilities/get"]);
  });
});
