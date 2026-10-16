import { describe, expect, it } from "vitest";
import { attentionItems, paymentOverview, paymentDueSummaries, hasEstimate, usdScope, upcomingCalendar, filterUpcoming } from "../public/bills-format.js";

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

describe("Fixed payment due summaries", () => {
  const incomplete = {remaining_cents:null,coverage:{complete:false,reasons:["Available transaction history does not cover this statement's full payment window."]}};

  it("includes today through each rolling boundary while excluding past and later dates", () => {
    const cards=["2026-10-14","2026-10-15","2026-10-22","2026-10-23","2026-11-14","2026-11-15"]
      .map(payment_due_date=>card({payment_due_date}));
    const [week,month]=paymentDueSummaries(cards,[],banks,now);
    expect(week).toMatchObject({days:7,amount_cents:12000,included:2,excluded:0,card_count:2,bill_count:0,minimum_cents:2000});
    expect(month).toMatchObject({days:30,amount_cents:24000,included:4,excluded:0,card_count:4,bill_count:0,minimum_cents:4000});
  });

  it("uses only USD statements and bills, regardless of a card's current-balance currency", () => {
    const cards=[card(),card({currency:"CAD",statement_currency:"USD"}),card({currency:"USD",statement_currency:"CAD"}),
      card({currency:"CAD"}),card({statement_currency:null}),card({id:null,transaction_account_id:2})];
    for(const total of paymentDueSummaries(cards,[bill(),bill({currency:"CAD",amount_cents:9900})],banks,now)) {
      expect(total).toMatchObject({amount_cents:14500,included:3,excluded:0,card_count:2,bill_count:1,minimum_cents:2000,minimum_count:2});
    }
  });

  it("retains unpaid manual bills in partial totals without adding minimums or paid bills", () => {
    const cards=[card(),card({payment_summary:incomplete}),card({statement_stale:true})];
    const bills=[bill(),bill({paid_at:now.toISOString()}),bill({archived_at:now.toISOString()})];
    for(const total of paymentDueSummaries(cards,bills,banks,now)) {
      expect(total).toMatchObject({amount_cents:8500,included:2,excluded:2,card_count:3,bill_count:1,minimum_cents:2000,minimum_count:2});
    }
    expect(paymentDueSummaries([card({payment_summary:incomplete})],[bill()],banks,now)[0])
      .toMatchObject({amount_cents:2500,included:1,excluded:1,bill_count:1});
  });

  it.each([
    {remaining:null,complete:false,amount:null,included:0},
    {remaining:null,complete:true,amount:null,included:0},
    {remaining:0,complete:false,amount:null,included:0},
    {remaining:0,complete:true,amount:0,included:1},
  ])("keeps remaining $remaining with coverage $complete distinct from a known zero", ({remaining,complete,amount,included}) => {
    const cards=[card({minimum_payment_cents:0,payment_summary:{remaining_cents:remaining,coverage:{complete,reasons:[]}}})];
    const total=paymentDueSummaries(cards,[],banks,now)[0];
    expect(total).toMatchObject({amount_cents:amount,included,excluded:1-included,card_count:1,minimum_cents:0,minimum_count:1});
  });

  it("counts missing and stale minimums separately from genuine reported zero minimums", () => {
    const cards=[card({minimum_payment_cents:1000,payment_summary:incomplete}),
      card({minimum_payment_cents:null,payment_summary:incomplete}),card({minimum_payment_cents:0,payment_summary:incomplete}),
      card({minimum_payment_cents:2000,statement_stale:true})];
    const total=paymentDueSummaries(cards,[],banks,now)[0];
    expect(total).toMatchObject({amount_cents:null,minimum_cents:1000,minimum_count:2,card_count:4,excluded:4});
    expect(paymentDueSummaries([cards[1],cards[3]],[],banks,now)[0])
      .toMatchObject({amount_cents:null,minimum_cents:null,minimum_count:0,card_count:2});
  });

  it("distinguishes an estimated-covered zero from a period with no reported payment dates", () => {
    const covered=card({payment_summary:{remaining_cents:0,coverage:{complete:true,reasons:[]}}});
    expect(paymentDueSummaries([covered],[],banks,now)[0])
      .toMatchObject({amount_cents:0,included:1,card_count:1,bill_count:0,minimum_count:1});
    const undated=card({payment_due_date:null,estimated_next_statement_date:"2026-10-20"});
    for(const total of paymentDueSummaries([undated],[],banks,now)) {
      expect(total).toMatchObject({amount_cents:0,included:0,excluded:0,card_count:0,bill_count:0,minimum_cents:null,minimum_count:0,reasons:[]});
    }
  });

  it("aggregates the actual coverage reasons per affected card without double-counting duplicate reasons", () => {
    const history="Available transaction history does not cover this statement's full payment window.";
    const stale="Statement details need an update.";
    const cards=[card({payment_summary:{remaining_cents:null,coverage:{complete:false,reasons:[history,history]}}}),
      card({statement_stale:true,payment_summary:{remaining_cents:null,coverage:{complete:false,reasons:[history,stale]}}}),
      card({payment_summary:null}),card({payment_due_date:"2026-10-14",payment_summary:incomplete})];
    const total=paymentDueSummaries(cards,[],banks,now)[0];
    expect(total).toMatchObject({amount_cents:null,excluded:3,card_count:3});
    expect(total.reasons).toEqual([
      {reason:history,count:2},{reason:stale,count:1},
      {reason:"Complete statement and payment details are not available.",count:1},
    ]);
  });

  it("shows distinct saved verification blockers while keeping usable amounts in the summary", () => {
    const bankFailure="The last history check found that Plaid's bank update failed. A successful update and another history check are needed.";
    const accountMismatch="Saved accounts and Plaid's reported accounts did not match during the last history check. Resolve the account mismatch, then verify payment history again.";
    const cards=[card({payment_summary:{remaining_cents:null,coverage:{complete:false,reasons:[bankFailure]}}}),
      card({payment_summary:{remaining_cents:null,coverage:{complete:false,reasons:[bankFailure]}}}),
      card({payment_summary:{remaining_cents:null,coverage:{complete:false,reasons:[accountMismatch]}}}),card()];
    for(const total of paymentDueSummaries(cards,[bill()],banks,now)) {
      expect(total).toMatchObject({amount_cents:8500,included:2,excluded:3,card_count:4,bill_count:1,
        minimum_count:4,minimum_cents:4000});
      expect(total.reasons).toEqual([{reason:bankFailure,count:2},{reason:accountMismatch,count:1}]);
    }
  });
});

describe("Coming up visibility", () => {
  const currentCard = (extra = {}) => card({current_balance_cents:5000,balance_updated_at:now.toISOString(),...extra});
  const overview = (cards: ReturnType<typeof currentCard>[], bills: ReturnType<typeof bill>[] = []) => paymentOverview(cards,bills,banks,30,now);

  it("starts with all cards and bills visible and does not alter inputs or totals", () => {
    const result=overview([currentCard({current_balance_cents:0}),currentCard({current_balance_cents:-500})],[bill({amount_cents:0})]);
    const before=structuredClone(result);
    expect(filterUpcoming(result.upcoming,banks,{},now)).toEqual({visible:result.upcoming,hiddenCount:0});
    const filtered=filterUpcoming(result.upcoming,banks,{hideNonPositiveCards:true},now);
    expect(filtered.visible).toHaveLength(1);
    expect(filtered.hiddenCount).toBe(2);
    expect(filtered.visible[0]).toBe(result.upcoming[0]);
    expect(result).toEqual(before);
  });

  it("uses current card balances rather than statement balances, minimums or remaining estimates", () => {
    const result=overview([
      currentCard({name:"Zero current",current_balance_cents:0,statement_balance_cents:20000,minimum_payment_cents:5000}),
      currentCard({name:"Credit current",current_balance_cents:-2500}),
      currentCard({name:"Positive current",current_balance_cents:1,statement_balance_cents:0,minimum_payment_cents:0,
        payment_summary:{remaining_cents:0,coverage:{complete:true}}}),
    ]);
    const filtered=filterUpcoming(result.upcoming,banks,{hideNonPositiveCards:true},now);
    expect(filtered.visible.map((event: {name:string})=>event.name)).toEqual(["Positive current"]);
    expect(filtered.hiddenCount).toBe(2);
  });

  it("hides amounts strictly below the configured cutoff, including manual bills", () => {
    const result=overview([
      currentCard({name:"Below",current_balance_cents:9999,statement_balance_cents:30000}),
      currentCard({name:"Exactly",current_balance_cents:10000,statement_balance_cents:1}),
      currentCard({name:"Above",current_balance_cents:10001}),
    ],[bill({name:"Small bill",amount_cents:9999}),bill({name:"Exact bill",amount_cents:10000}),bill({name:"Large bill",amount_cents:10001})]);
    const filtered=filterUpcoming(result.upcoming,banks,{minimumCents:10000},now);
    expect(filtered.visible.map((event: {name:string})=>event.name)).toEqual(["Exact bill","Large bill","Above","Exactly"]);
    expect(filtered.hiddenCount).toBe(2);
  });

  it("combines filters independently and treats a zero cutoff as inclusive", () => {
    const result=overview([currentCard({name:"Credit",current_balance_cents:-100}),currentCard({name:"Zero",current_balance_cents:0}),
      currentCard({name:"Positive",current_balance_cents:1})],[bill({name:"Zero bill",amount_cents:0})]);
    expect(filterUpcoming(result.upcoming,banks,{minimumCents:0},now).visible.map((event: {name:string})=>event.name))
      .toEqual(["Zero bill","Positive","Zero"]);
    expect(filterUpcoming(result.upcoming,banks,{minimumCents:0,hideNonPositiveCards:true},now).visible.map((event: {name:string})=>event.name))
      .toEqual(["Zero bill","Positive"]);
    expect(filterUpcoming(result.upcoming,banks,{minimumCents:10000,hideNonPositiveCards:true},now))
      .toEqual({visible:[],hiddenCount:4});
  });

  it.each([null,undefined,NaN,Infinity,-Infinity,"0"])("keeps missing or invalid current balances visible (%s)", value => {
    const result=overview([currentCard({current_balance_cents:value})]);
    expect(filterUpcoming(result.upcoming,banks,{hideNonPositiveCards:true,minimumCents:10000},now).hiddenCount).toBe(0);
  });

  it.each([null,undefined,"CAD"])("does not compare a non-USD or unknown current balance to a dollar cutoff (%s)", currency => {
    const result=overview([currentCard({currency,statement_currency:"USD",current_balance_cents:0,show_usd_balance:false})]);
    expect(filterUpcoming(result.upcoming,banks,{hideNonPositiveCards:true,minimumCents:10000},now).hiddenCount).toBe(0);
  });

  it("does not relabel a foreign or unknown balance using a contradictory display flag", () => {
    const result=overview([currentCard({currency:"CAD",statement_currency:"USD",show_usd_balance:true,current_balance_cents:0}),
      currentCard({currency:undefined,statement_currency:"USD",show_usd_balance:true,current_balance_cents:0})]);
    expect(filterUpcoming(result.upcoming,banks,{hideNonPositiveCards:true},now).hiddenCount).toBe(0);
  });

  it.each([null,undefined,"invalid","2026-10-14T05:59:59Z","2026-10-15T12:00:01Z"])("retains cards with unverified or stale balance timestamps (%s)", balance_updated_at => {
    const result=overview([currentCard({current_balance_cents:0,balance_updated_at})]);
    expect(filterUpcoming(result.upcoming,banks,{hideNonPositiveCards:true,minimumCents:10000},now).hiddenCount).toBe(0);
  });

  it("uses the existing inclusive 30-hour freshness window for daily-reported balances", () => {
    const result=overview([currentCard({current_balance_cents:0,balance_updated_at:"2026-10-14T06:00:00Z"})]);
    expect(filterUpcoming(result.upcoming,banks,{hideNonPositiveCards:true},now).hiddenCount).toBe(1);
  });

  it.each(["downloading","stalled","reconnect","broken","stranded",undefined])("keeps cards visible when connection health is %s", state => {
    const result=overview([currentCard({current_balance_cents:0})]);
    expect(filterUpcoming(result.upcoming,[{...banks[0],health:{state}}],{hideNonPositiveCards:true,minimumCents:10000},now).hiddenCount).toBe(0);
  });

  it("accepts healthy or expiring connections while ignoring unrelated statement-coverage limitations", () => {
    const result=overview([currentCard({current_balance_cents:0,statement_stale:true,
      payment_summary:{remaining_cents:null,coverage:{complete:false}}})]);
    expect(filterUpcoming(result.upcoming,banks,{hideNonPositiveCards:true},now).hiddenCount).toBe(1);
    expect(filterUpcoming(result.upcoming,[{...banks[0],status:"disabled",health:{state:"expiring"}}],{hideNonPositiveCards:true},now).hiddenCount).toBe(1);
    expect(filterUpcoming(result.upcoming,[],{hideNonPositiveCards:true},now).hiddenCount).toBe(0);
  });

  it("keeps manual bills with missing, invalid or foreign amounts visible", () => {
    const result=overview([],[bill({amount_cents:null}),bill({amount_cents:NaN}),bill({amount_cents:Infinity}),bill({currency:"CAD",amount_cents:1}),bill({currency:null,amount_cents:1})]);
    expect(filterUpcoming(result.upcoming,banks,{hideNonPositiveCards:true,minimumCents:10000},now).hiddenCount).toBe(0);
    expect(filterUpcoming([{kind:"bill",bill:bill({amount_cents:1})}],banks,{minimumCents:10000},now).hiddenCount).toBe(1);
  });

  it.each([-1,1.5,NaN,Infinity,"10000",Number.MAX_SAFE_INTEGER+1])("ignores invalid minimum thresholds (%s)", minimumCents => {
    const result=overview([currentCard({current_balance_cents:1})],[bill({amount_cents:1})]);
    expect(filterUpcoming(result.upcoming,banks,{minimumCents},now).hiddenCount).toBe(0);
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

describe("USD page scope", () => {
  it("includes USD current balances and USD statements independently without changing their currency", () => {
    const cards=[card({id:1,item_id:1,currency:"USD",statement_currency:"CAD"}),
      card({id:2,item_id:2,currency:"CAD",current_balance_cents:20000,statement_currency:"USD"}),
      card({id:3,item_id:3,currency:"CAD",statement_currency:"CAD"}),
      card({id:4,item_id:4,currency:"USD",statement_currency:null}),
      card({id:null,item_id:5,currency:"USD",statement_currency:null}),
      card({id:6,item_id:6,currency:null,statement_currency:null})];
    const allBanks=cards.map(c=>({...banks[0],id:c.item_id}));
    const result=usdScope(cards,[bill(),bill({currency:"CAD"}),bill({currency:null})],allBanks);
    expect(result.cards.map((c: {item_id:number})=>c.item_id)).toEqual([1,2,4,5]);
    expect(result.cards[0]).toMatchObject({currency:"USD",statement_currency:"CAD",show_usd_balance:true,show_usd_statement:false,statement_balance_cents:10000});
    expect(result.cards[1]).toMatchObject({currency:"CAD",statement_currency:"USD",show_usd_balance:false,show_usd_statement:true,current_balance_cents:20000});
    expect(result.statementCards.map((c: {id:number})=>c.id)).toEqual([2]);
    expect(result.banks.map((b: {id:number})=>b.id)).toEqual([1,2,4,5]);
    expect(result.bills).toHaveLength(1);
    expect(cards[0]).not.toHaveProperty("show_usd_statement");
    const overview=paymentOverview(result.statementCards,result.bills,result.banks,30,now);
    expect(overview.totals).toEqual([{currency:"USD",amount_cents:8500,minimum_cents:1000,included:2,minimum_count:1,excluded:0}]);
  });

  it("supports older USD cards that omit a separate statement currency, without treating null as USD", () => {
    const result=usdScope([card(),card({id:2,statement_currency:null})],[],banks);
    expect(result.cards).toHaveLength(2);
    expect(result.statementCards.map((c: {id:number})=>c.id)).toEqual([1]);
  });
});

describe("Upcoming statement calendar", () => {
  it("shows every date through the inclusive 14/30-day boundary and leaves past dates out", () => {
    const cards=[card({name:"Past",payment_due_date:"2026-10-14"}),card({name:"Today",payment_due_date:"2026-10-15"}),
      card({name:"14 days",payment_due_date:"2026-10-29"}),card({name:"15 days",payment_due_date:"2026-10-30"}),
      card({name:"30 days",payment_due_date:"2026-11-14"}),card({name:"31 days",payment_due_date:"2026-11-15"})];
    const fourteen=upcomingCalendar(cards,[],banks,14,now);
    expect(fourteen).toMatchObject({start:"2026-10-15",end:"2026-10-29"});
    expect(fourteen.days).toHaveLength(15);
    expect(fourteen.days.flatMap((d: {events:{name:string}[]})=>d.events.map(e=>e.name))).toEqual(["Today","14 days"]);
    const thirty=upcomingCalendar(cards,[],banks,30,now);
    expect(thirty).toMatchObject({start:"2026-10-15",end:"2026-11-14"});
    expect(thirty.days).toHaveLength(31);
    expect(thirty.days.flatMap((d: {events:{name:string}[]})=>d.events.map(e=>e.name))).toEqual(["Today","14 days","15 days","30 days"]);
    expect(thirty.days[1].events).toEqual([]);
  });

  it.each([
    [2027,1,25,"2027-02-25","2027-03-11",false],
    [2028,1,25,"2028-02-25","2028-03-10",true],
    [2026,11,28,"2026-12-28","2027-01-11",false],
    [2026,2,7,"2026-03-07","2026-03-21",false],
    [2026,9,31,"2026-10-31","2026-11-14",false],
  ])("keeps consecutive date-only cells across month/year and DST boundaries (%s-%s-%s)", (year,month,day,start,end,leap) => {
    const result=upcomingCalendar([],[],[],14,new Date(year,month,day,12));
    const dates=result.days.map((d: {date:string})=>d.date);
    expect(result).toMatchObject({start,end});
    expect(new Set(dates).size).toBe(15);
    expect(dates.includes("2028-02-29")).toBe(leap);
    for(let i=1;i<dates.length;i++) expect(Date.parse(dates[i])-Date.parse(dates[i-1])).toBe(86400000);
  });

  it("distinguishes payments, manual bills, reported statements and estimates on the same day", () => {
    const cards=[card({name:"Everyday A",payment_due_date:"2026-10-15",statement_issue_date:"2026-10-15",estimated_next_statement_date:"2026-11-15"}),
      card({name:"Everyday B",payment_due_date:null,statement_issue_date:"2026-09-15",estimated_next_statement_date:"2026-10-15"})];
    const manual=[bill(),bill({name:"Paid bill",paid_at:now.toISOString()}),bill({name:"Archived bill",archived_at:now.toISOString()})];
    const result=upcomingCalendar(cards,manual,banks,14,now);
    expect(result.days[0].events.map((e: {kind:string,name:string,estimated:boolean})=>[e.kind,e.name,e.estimated])).toEqual([
      ["card","Everyday A",false],["bill","Utility",false],["statement","Everyday A",false],["statement","Everyday B",true],
    ]);
    const statements=result.days[0].events.filter((e: {kind:string})=>e.kind==="statement");
    expect(statements.every((e: {amount:null,currency:null,minimum:null})=>e.amount===null && e.currency===null && e.minimum===null)).toBe(true);
    expect(paymentOverview(cards,manual,banks,14,now).totals[0].amount_cents).toBe(8500);
  });

  it("replaces estimates with actual statements and suppresses superseded predictions", () => {
    const forecast=card({payment_due_date:null,statement_issue_date:"2026-09-20",estimated_next_statement_date:"2026-10-20"});
    expect(upcomingCalendar([forecast],[],banks,14,now).days[5].events[0]).toMatchObject({kind:"statement",estimated:true});
    const actual=card({...forecast,statement_issue_date:"2026-10-20",estimated_next_statement_date:"2026-11-20"});
    expect(upcomingCalendar([actual],[],banks,14,now).days[5].events).toMatchObject([{kind:"statement",estimated:false}]);
    const overlapping=card({...forecast,next_issue_date:"2026-10-20"});
    expect(upcomingCalendar([overlapping],[],banks,14,now).days[5].events).toMatchObject([{kind:"statement",estimated:false}]);
    const superseded=card({...forecast,statement_issue_date:"2026-10-21"});
    const result=upcomingCalendar([superseded],[],banks,14,now);
    expect(result.days[5].events).toEqual([]);
    expect(result.days[6].events).toMatchObject([{kind:"statement",estimated:false}]);
  });

  it("only includes USD statements/bills even when called with mixed-currency raw data", () => {
    const result=upcomingCalendar([
      card({name:"CAD statement",currency:"USD",statement_currency:"CAD",statement_issue_date:"2026-10-15",estimated_next_statement_date:"2026-10-20"}),
      card({name:"USD statement",currency:"CAD",statement_currency:"USD",statement_issue_date:"2026-10-15"}),
      card({name:"Unknown statement",statement_currency:null,statement_issue_date:"2026-10-15"}),
    ],[bill(),bill({name:"CAD bill",currency:"CAD"})],banks,14,now);
    const names=result.days.flatMap((d: {events:{name:string}[]})=>d.events.map(e=>e.name));
    expect(names).toEqual(["Utility","USD statement","USD statement"]);
  });

  it("ignores invalid statement dates instead of rolling them into a different day", () => {
    const result=upcomingCalendar([card({payment_due_date:null,statement_issue_date:"2026-02-30",estimated_next_statement_date:"2026-02-31"})],[],banks,14,new Date(2026,1,25,12));
    expect(result.days.every((d: {events:unknown[]})=>d.events.length===0)).toBe(true);
  });
});
