import { describe, expect, it } from "vitest";
// @ts-expect-error Browser helpers are plain JavaScript; test the labels actually rendered.
import { cardBaseName, cardEnding, cardDisplayName } from "../public/card-names.js";
// @ts-expect-error HTML escaping belongs at the rendering boundary, not in the name helper.
import { esc, paymentOverview, upcomingCalendar, attentionItems } from "../public/bills-format.js";

describe("card display names", () => {
  it("shortens default product names and removes trademark/service marks", () => {
    expect(cardDisplayName({name:"Business Platinum Card®",mask:"35678"})).toBe("Biz Plat 35678");
    expect(cardDisplayName({name:"Citi Strata Elite℠ Card",mask:"1234"})).toBe("Citi Strata Elite 1234");
    expect(cardBaseName({name:"Citi Strata Eliteˢᴹ Card™"})).toBe("Citi Strata Elite");
    expect(cardBaseName({name:"Citi Strata Elite SM Card"})).toBe("Citi Strata Elite");
    expect(cardDisplayName({name:"Charles Schwab Platinum Card",mask:"01234"})).toBe("Schwab Plat 01234");
    expect(cardBaseName({name:"  BUSINESS   PLATINUM CARD  "})).toBe("Biz Plat");
    expect(cardBaseName({name:"Mastercard Business"})).toBe("Mastercard Biz");
  });

  it("uses Chase with its full ending even when the bank reports an unhelpful name", () => {
    expect(cardDisplayName({name:"CREDIT CARD",institution_name:"Chase",mask:"1122"})).toBe("Chase 1122");
    expect(cardDisplayName({name:"Freedom Card",institution_name:"JPMorgan Chase",mask:"00123"})).toBe("Chase 00123");
    expect(cardDisplayName({name:"CREDIT CARD",institution_name:"Chase",mask:"1122",nickname:"Travel"})).toBe("Travel 1122");
  });

  it("keeps the complete reported or corrected ending and never invents a fifth digit", () => {
    expect(cardDisplayName({name:"Platinum Card",mask:"5678"})).toBe("Plat 5678");
    expect(cardDisplayName({name:"Platinum Card",mask:"5678",display_mask:"35678"})).toBe("Plat 35678");
    expect(cardEnding({mask:"5678",display_mask:"00008"})).toBe("00008");
    expect(cardEnding({mask:"5678",display_mask:""})).toBe("5678");
    expect(cardEnding({mask:"5678",display_mask:null})).toBe("5678");
    expect(cardDisplayName({name:"Platinum Card",mask:null})).toBe("Plat");
    expect(cardEnding({})).toBe("");
  });

  it("provides a fallback when the bank reports no usable name", () => {
    expect(cardDisplayName({name:null,institution_name:"Test bank",mask:"4321"})).toBe("Test bank 4321");
    expect(cardDisplayName({name:"Card℠",mask:"4321"})).toBe("Credit account 4321");
    expect(cardDisplayName({})).toBe("Credit account");
  });

  it("preserves a custom name literally apart from outer whitespace", () => {
    const custom="  Business Platinum Card® — José’s café  ";
    expect(cardBaseName({name:"Bank name",nickname:custom})).toBe("Business Platinum Card® — José’s café");
    expect(cardDisplayName({nickname:"旅行 💳",mask:"01234"})).toBe("旅行 💳 01234");
    expect(cardDisplayName({name:"Business Card",nickname:"   ",mask:"0123"})).toBe("Biz 0123");
    expect(cardBaseName({nickname:"My\nCard"})).toBe("My\nCard");
  });

  it("does not repeat an ending already at the end of a name", () => {
    expect(cardDisplayName({nickname:"Biz Plat 35678",mask:"35678"})).toBe("Biz Plat 35678");
    expect(cardDisplayName({nickname:"Travel ••1122",mask:"1122"})).toBe("Travel ••1122");
    expect(cardDisplayName({nickname:"1122",mask:"1122"})).toBe("1122");
    expect(cardDisplayName({nickname:"Travel 11122",mask:"1122"})).toBe("Travel 11122 1122");
    expect(cardDisplayName({nickname:"Travel 1122",mask:"1122",display_mask:"11122"})).toBe("Travel 1122 11122");
  });

  it("returns plain text so rendering escapes custom markup exactly once", () => {
    const name=cardDisplayName({nickname:'<img src=x onerror="alert(1)"> & Bills',mask:"1234"});
    expect(name).toBe('<img src=x onerror="alert(1)"> & Bills 1234');
    expect(esc(name)).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; Bills 1234');
    expect(cardDisplayName({nickname:"A &amp; B",mask:"1234"})).toBe("A &amp; B 1234");
  });

  it("uses the same saved label in payment dates, statement forecasts, and attention", () => {
    const now = new Date("2026-10-15T12:00:00Z");
    const banks = [{ id:1, status:"ready", health:{state:"ok"} }];
    const card = {
      id:1, item_id:1, institution_name:"Chase", name:"CREDIT CARD", mask:"1122",
      nickname:"Travel", display_mask:"31122", available:1, currency:"USD", statement_stale:false,
      statement_issue_date:"2026-09-18", estimated_next_statement_date:"2026-10-18",
      payment_due_date:"2026-10-20", statement_balance_cents:10000, minimum_payment_cents:1000,
      payment_summary:{remaining_cents:10000,coverage:{complete:true},likely_count:0},
    };
    expect(paymentOverview([card],[],banks,30,now).upcoming.map((event: any)=>event.name)).toEqual(["Travel 31122"]);
    expect(upcomingCalendar([card],[],banks,30,now).days.flatMap((day: any)=>day.events).map((event: any)=>event.name)).toEqual(["Travel 31122","Travel 31122"]);
    expect(attentionItems([card],[],banks,now).map((item: any)=>item.name)).toEqual(["Travel 31122"]);
    expect(card.name).toBe("CREDIT CARD");
    expect(card.mask).toBe("1122");
  });
});
