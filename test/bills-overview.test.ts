import { describe, expect, it } from "vitest";
// @ts-expect-error Browser helpers are plain JavaScript; test the UI's actual calculations.
import { attentionItems, paymentOverview, hasEstimate } from "../public/bills-format.js";

const now = new Date("2026-10-15T12:00:00Z");
const banks = [{id:1,status:"ready",health:{state:"ok"}}];
const card = (extra = {}) => ({id:1,item_id:1,name:"Card",available:1,observed_at:now.toISOString(),currency:"USD",
  statement_balance_cents:10000,minimum_payment_cents:1000,payment_due_date:"2026-10-22",statement_stale:false,
  payment_summary:{remaining_cents:6000,coverage:{complete:true,reasons:[]},likely_count:0,discrepancy:false},...extra});
const bill = (extra = {}) => ({name:"Utility",currency:"USD",amount_cents:2500,due_date:"2026-10-15",paid_at:null,archived_at:null,...extra});

describe("Bills outlook", () => {
  it("includes today and each horizon boundary, with earlier dates kept separate", () => {
    const cards=[card({name:"Yesterday",payment_due_date:"2026-10-14"}),card({name:"Today",payment_due_date:"2026-10-15"}),
      card({name:"7 days",payment_due_date:"2026-10-22"}),card({name:"8 days",payment_due_date:"2026-10-23"}),
      card({name:"14 days",payment_due_date:"2026-10-29"}),card({name:"30 days",payment_due_date:"2026-11-14"}),
      card({name:"31 days",payment_due_date:"2026-11-15"})];
    const seven=paymentOverview(cards,[],banks,7,now);
    expect(seven.upcoming.map((event: {name:string})=>event.name)).toEqual(["Today","7 days"]);
    expect(seven.past.map((event: {name:string})=>event.name)).toEqual(["Yesterday"]);
    expect(paymentOverview(cards,[],banks,14,now).upcoming).toHaveLength(4);
    expect(paymentOverview(cards,[],banks,30,now).upcoming).toHaveLength(5);
  });

  it("keeps currencies and minimums separate and excludes paid/archived manual bills", () => {
    const result=paymentOverview([card(),card({currency:"CAD"})],[bill(),bill({currency:"CAD",amount_cents:200}),
      bill({paid_at:now.toISOString()}),bill({archived_at:now.toISOString()})],banks,30,now);
    expect(result.totals).toEqual([
      {currency:"CAD",amount_cents:6200,minimum_cents:1000,included:2,minimum_count:1,excluded:0},
      {currency:"USD",amount_cents:8500,minimum_cents:1000,included:2,minimum_count:1,excluded:0},
    ]);
    expect(result.excluded).toBe(0);
  });

  it("withholds stale or incomplete estimates, retaining fresh reported minimums separately", () => {
    const incomplete=card({payment_summary:{remaining_cents:null,coverage:{complete:false,reasons:["Downloading"]}}});
    const stale=card({statement_stale:true});
    const result=paymentOverview([incomplete,stale,card({currency:null})],[bill()],banks,30,now);
    expect(result.excluded).toBe(3);
    expect(result.totals).toEqual([{currency:"USD",amount_cents:2500,minimum_cents:1000,included:1,minimum_count:1,excluded:2}]);
    expect(result.upcoming.filter((event: {kind:string})=>event.kind==="card").every((event: {amount:number|null})=>event.amount===null)).toBe(true);
    expect(hasEstimate(incomplete,banks[0],now)).toBe(false);
  });

  it("includes zero and likely estimates without adding a forecast amount", () => {
    const covered=card({payment_summary:{remaining_cents:0,coverage:{complete:true},likely_count:1}});
    const forecastOnly=card({payment_due_date:null,statement_forecast_date:"2026-10-20"});
    const result=paymentOverview([covered,forecastOnly],[],banks,30,now);
    expect(result.upcoming).toHaveLength(1);
    expect(result.totals[0]).toMatchObject({amount_cents:0,included:1,excluded:0});
    expect(hasEstimate(covered,banks[0],now)).toBe(true);
  });

  it("uses the statement's currency when the current balance currency differs", () => {
    const result=paymentOverview([card({currency:"USD",statement_currency:"CAD"})],[],banks,30,now);
    expect(result.totals).toEqual([{currency:"CAD",amount_cents:6000,minimum_cents:1000,included:1,minimum_count:1,excluded:0}]);
    expect(paymentOverview([card({statement_currency:null})],[],banks,30,now).excluded).toBe(1);
  });
});

describe("Bills attention", () => {
  it("uses reported overdue and connection health without inferring missed payments from dates", () => {
    expect(attentionItems([card({payment_due_date:"2026-10-10"})],[],banks,now)).toEqual([]);
    const result=attentionItems([card({payment_due_date:"2026-10-10",is_overdue:1})],[],
      [{...banks[0],institution_name:"Maple",health:{state:"downloading",message:"Downloading history"}}],now);
    expect(result).toHaveLength(2);
    expect(result[0].detail).toBe("Downloading history");
    expect(result[1].detail).toContain("Bank reports overdue");
  });

  it("highlights missing dates, incomplete/likely matches and discrepancies", () => {
    const result=attentionItems([card({payment_due_date:null,payment_summary:{remaining_cents:null,coverage:{complete:false},likely_count:2,
      discrepancy:true,discrepancy_reason:"Last payment differs"}})],[],banks,now);
    expect(result[0].detail).toContain("Payment date not reported");
    expect(result[0].detail).toContain("Payment history is incomplete");
    expect(result[0].detail).toContain("2 likely payment matches");
    expect(result[0].detail).toContain("Last payment differs");
  });

  it("shows due dates for manual bills and cards, but does not call estimated-covered cards unpaid", () => {
    const covered=card({payment_summary:{remaining_cents:0,coverage:{complete:true},likely_count:0}});
    const result=attentionItems([card(),covered],[bill(),bill({due_date:"2026-10-14"}),bill({paid_at:now.toISOString()})],banks,now);
    expect(result).toHaveLength(2);
    expect(result[0].detail).toContain("Payment date in 7 days");
    expect(result[1].detail).toContain("due today");
  });

  it("explains missing Liabilities access for linked cards", () => {
    const result=attentionItems([card({id:null,account_id:10,payment_due_date:null})],[],banks,now);
    expect(result[0].detail).toBe("Statement details require Liabilities access");
  });
});
