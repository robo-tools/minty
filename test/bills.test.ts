import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { call, getJson } from "./helpers";
import { nextMonth } from "../src/routes/bills";
import { money, daysUntil, cardState } from "../public/bills-format.js";
const post=(path:string,body:unknown={})=>getJson(path,{method:"POST",body:JSON.stringify(body)});
const bill=(extra={})=>({owner:"me",name:"Electric",amount_cents:4500,currency:"USD",due_date:"2026-01-31",recurrence:"monthly",...extra});
beforeEach(async()=>{await env.DB.prepare("DELETE FROM manual_bills").run();});

describe("manual bills",()=>{
  it("creates, filters, archives and restores without deleting paid history",async()=>{
    const created=await post("/manual-bills",bill()); expect(created.status).toBe(201);
    const id=created.body.id;
    expect((await getJson("/manual-bills?owner=spouse")).body).toEqual([]);
    await post(`/manual-bills/${id}/archive`);
    expect((await getJson("/manual-bills")).body[0].archived_at).not.toBeNull();
    await post(`/manual-bills/${id}/restore`);
    expect((await getJson("/manual-bills")).body[0].archived_at).toBeNull();
  });
  it("records a payment once and advances monthly bills using the original day",async()=>{
    const id=(await post("/manual-bills",bill())).body.id;
    const responses=await Promise.all([post(`/manual-bills/${id}/paid`,{due_date:"2026-01-31"}),post(`/manual-bills/${id}/paid`,{due_date:"2026-01-31"})]);
    expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
    expect((await getJson("/manual-bills")).body[0]).toMatchObject({due_date:"2026-02-28",anchor_day:31,paid_at:null});
    await post(`/manual-bills/${id}/paid`,{due_date:"2026-02-28"});
    expect((await getJson("/manual-bills")).body[0].due_date).toBe("2026-03-31");
    expect(await env.DB.prepare("SELECT count(*) AS n FROM manual_bill_payments").first()).toEqual({n:2});
  });
  it("marks one-time bills paid without inventing another due date",async()=>{
    const id=(await post("/manual-bills",bill({recurrence:"once"}))).body.id;
    expect((await post(`/manual-bills/${id}/paid`,{due_date:"2026-01-31"})).body.next_due_date).toBeNull();
    expect((await getJson("/manual-bills")).body[0].paid_at).not.toBeNull();
    expect((await post(`/manual-bills/${id}/paid`,{due_date:"2026-01-31"})).status).toBe(409);
  });
  it("applies the active-bill cap to restoration as well as creation",async()=>{
    const id=(await post("/manual-bills",bill())).body.id;
    await post(`/manual-bills/${id}/archive`);
    await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<500)
      INSERT INTO manual_bills(owner,name,amount_cents,currency,due_date,recurrence,anchor_day)
      SELECT 'me','Bill '||x,100,'USD','2026-10-15','once',15 FROM n`).run();
    expect((await post("/manual-bills",bill())).status).toBe(409);
    expect((await post(`/manual-bills/${id}/restore`)).status).toBe(409);
    await post(`/manual-bills/${id+1}/archive`);
    expect((await post(`/manual-bills/${id}/restore`)).status).toBe(200);
  });
  it.each([{due_date:"2026-02-30"},{amount_cents:1.5},{amount_cents:-1},{owner:"nobody"},{name:" "},{recurrence:"weekly"}])("rejects invalid input %j",async(extra)=>{
    expect((await post("/manual-bills",bill(extra))).status).toBe(422);
  });
  it("requires Access and same-origin writes",async()=>{
    expect((await call("/manual-bills",{token:null})).status).toBe(403);
    expect((await call("/manual-bills",{method:"POST",body:JSON.stringify(bill()),headers:{origin:"https://attacker.test"}})).status).toBe(403);
  });
});

describe("date and balance presentation",()=>{
  it("distinguishes observed payments from a verified remaining balance on a reported due date",()=>{
    const now=new Date("2026-10-15T12:00:00Z"), bank={status:"ready"};
    const card={available:1,observed_at:now.toISOString(),currency:"USD",payment_due_date:"2026-10-15",minimum_payment_cents:0,
      statement_balance_cents:1250,last_payment_cents:1250,last_payment_date:"2026-10-08",
      payment_summary:{detected_payment_cents:1250,strong_count:1,likely_count:0,remaining_cents:null,coverage:{complete:false}}};
    expect(cardState(card,bank,now)).toEqual({label:"Payment observed",stale:false});
    expect(cardState({...card,payment_summary:{...card.payment_summary,strong_count:0,likely_count:1}},bank,now).label).toBe("Likely payment observed");
    // A zero minimum or separate last-payment field alone is not evidence of full coverage.
    expect(cardState({...card,payment_summary:{...card.payment_summary,detected_payment_cents:0,strong_count:0}},bank,now).label).toBe("Reported date · today");
    const covered={...card,payment_summary:{...card.payment_summary,remaining_cents:0,coverage:{complete:true}}};
    expect(cardState(covered,bank,now).label).toBe("Estimated covered");
    expect(cardState({...covered,payment_due_date:"2026-10-10"},bank,now).label).toBe("Estimated covered");
    expect(cardState({...card,statement_stale:true},bank,now)).toEqual({label:"Needs update",stale:true});
    expect(cardState({...covered,is_overdue:1,statement_stale:true},bank,now)).toEqual({label:"Bank reports overdue",stale:true});
  });
  it("handles leap years and year boundaries",()=>{
    expect(nextMonth("2028-01-31",31)).toBe("2028-02-29");
    expect(nextMonth("2026-12-31",31)).toBe("2027-01-31");
  });
  it("distinguishes zero, unknown and credit balances",()=>{
    expect(money(0,"USD")).toBe("$0.00");
    expect(money(null,"USD")).toBe("Not reported");
    expect(money(100,null)).toBe("Not reported");
    expect(money(-100,"USD")).toBe("-$1.00");
  });
  it("does not declare a card overdue just because its reported date is past",()=>{
    const now=new Date("2026-10-15T12:00:00Z");
    const card={available:1,observed_at:now.toISOString(),payment_due_date:"2026-10-10",is_overdue:0};
    expect(cardState(card,{status:"ready"},now)).toEqual({label:"Past reported date",stale:false});
    expect(cardState({...card,is_overdue:1},{status:"ready"},now).label).toBe("Bank reports overdue");
    expect(cardState(card,{status:"error"},now).stale).toBe(true);
    expect(cardState({...card,observed_at:"2026-10-01"},{status:"ready"},now).stale).toBe(true);
    expect(daysUntil(null,now)).toBeNull();
  });
});
