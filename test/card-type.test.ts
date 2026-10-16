import { describe, expect, it } from "vitest";
import { isChargeCard } from "../src/card-type";

describe("Amex charge-card display classification", () => {
  it.each([
    "American Express Gold Card", "Business Gold Card", "Business Platinum Card®",
    "Charles Schwab Platinum Card®", "The Platinum Card® from American Express",
    "American Express® Green Card", "Business Green Rewards Card", "Centurion Card",
    "Platinum Card® for Morgan Stanley", "Morgan Stanley Platinum Card",
    "The American Express Platinum Card for Charles Schwab", "Amex Business Platinum",
    "  BUSINESS  GOLD CARD  ",
  ])("recognizes the reported charge product %s", name => {
    expect(isChargeCard({ institution_name: "American Express", name })).toBe(true);
  });

  it.each([
    "Delta Gold Business Card", "Delta Platinum Business Card", "Delta SkyMiles® Gold American Express Card",
    "Delta SkyMiles Platinum Card", "Hilton Honors Card", "Hilton Honors American Express Aspire Card",
    "Marriott Bonvoy Brilliant Card", "Blue Business Plus Card", "Blue Cash Preferred Card", "Optima Platinum Card",
    "American Express", "CREDIT CARD", "Business Card", "Gold Rewards Credit Card", "Platinum Cashback Card",
    "Gold Corporate Card", "Gold Card Extra", "Business Platinum Plus", "", null,
  ])("does not infer charge status for %s", name => {
    expect(isChargeCard({ institution_name: "American Express", name })).toBe(false);
  });

  it.each(["Chase", "Citibank Online", "American Express Canada", "Not American Express", "", null])(
    "does not classify Gold Card at institution %s", institution_name => {
      expect(isChargeCard({ institution_name, name: "Gold Card" })).toBe(false);
    },
  );

  it("uses neither nicknames nor reported limits to infer charge status", () => {
    for (const credit_limit_cents of [null, 0, 200000]) {
      const reportedCharge = { institution_name: "American Express", name: "Business Gold Card",
        nickname: "Delta Gold Business Card", credit_limit_cents };
      const reportedRevolving = { institution_name: "American Express", name: "Delta Gold Business Card",
        nickname: "Business Gold Card", credit_limit_cents };
      expect(isChargeCard(reportedCharge)).toBe(true);
      expect(isChargeCard(reportedRevolving)).toBe(false);
    }
  });
});
