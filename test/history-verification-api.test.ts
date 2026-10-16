import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { Env } from "../src/env";
import { call, getJson, HOST, loadFixture } from "./helpers";

const E=env as unknown as Env, PATH="/liabilities/verify-history";
const post=(body:unknown,query="",init:Parameters<typeof call>[1]={})=>getJson(PATH+query,{method:"POST",body:JSON.stringify(body),...init});
beforeEach(async()=>{await loadFixture();await E.DB.prepare("DELETE FROM app_state WHERE key LIKE 'rows_read:%'").run();});
afterEach(()=>vi.restoreAllMocks());

describe("history verification boundary",()=>{
  it("requires authentication and same-origin requests",async()=>{
    expect((await post({item_id:1},"",{token:null})).status).toBe(403);
    expect((await post({item_id:1},"",{headers:{origin:"https://elsewhere.example"}})).status).toBe(403);
    expect((await post({item_id:1},"",{headers:{origin:HOST,"sec-fetch-site":"cross-site"}})).status).toBe(403);
  });
  it("validates a bounded object and local positive bank id",async()=>{
    for(const body of [null,[],"bank",{}, {item_id:"1"},{item_id:0},{item_id:1.5},{item_id:-1}]) {
      expect((await post(body)).status).toBe(422);
    }
    expect((await call(PATH,{method:"POST",body:"{"})).status).toBe(422);
    expect((await post({item_id:1,padding:"x".repeat(20000)})).status).toBe(413);
  });
  it("filters the selected owner and refuses unknown or unconfigured banks before Plaid",async()=>{
    const fetchSpy=vi.spyOn(globalThis,"fetch");
    expect((await post({item_id:1},"?owner=missing")).status).toBe(422);
    expect((await post({item_id:1},"?owner=spouse")).status).toBe(404);
    expect((await post({item_id:99999})).status).toBe(404);
    await E.DB.prepare("UPDATE items SET plaid_account='missing' WHERE id=1").run();
    expect((await post({item_id:1})).status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("applies both per-login limits before database or Plaid access",async()=>{
    const db=new Proxy({},{get(){throw Error("Unexpected database access");}}) as D1Database;
    for(const name of ["RL_GENERAL","RL_LINK"] as const){
      const limiter={limit:vi.fn(async()=>({success:false}))};
      const result=await post({item_id:1},"",{envOverrides:{DB:db,[name]:limiter}});
      expect(result.status).toBe(429);expect(limiter.limit).toHaveBeenCalled();
    }
  });
  it("honors the daily read budget and keeps responses uncached",async()=>{
    await E.DB.prepare("INSERT OR REPLACE INTO app_state(key,value) VALUES('rows_read:'||date('now'),'100')").run();
    const result=await call(PATH,{method:"POST",body:JSON.stringify({item_id:1}),envOverrides:{READ_BUDGET_PER_DAY:"1"}});
    expect(result.status).toBe(429);expect(result.headers.get("cache-control")).toContain("no-store");
    expect((await call(PATH)).status).toBe(405);
  });
});
