import { describe, expect, it } from "vitest";
import { isoDate, parseBill } from "../public/bill-parse.js";

// Reading a bill's fields from its PDF text (public/bill-parse.js). Texts are made up, shaped like
// the utility bills the feature is for.

describe("dates", () => {
  it("reads the formats bills use, and refuses impossible ones", () => {
    expect(isoDate("Oct 28, 2026")).toBe("2026-10-28");
    expect(isoDate("October 28 2026")).toBe("2026-10-28");
    expect(isoDate("Sept. 3, 2026")).toBe("2026-09-03");
    expect(isoDate("10/28/2026")).toBe("2026-10-28");
    expect(isoDate("10/28/26")).toBe("2026-10-28");
    expect(isoDate("2026-10-28")).toBe("2026-10-28");
    expect(isoDate("02/30/2026")).toBeNull();
    expect(isoDate("13/01/2026")).toBeNull();
    expect(isoDate("")).toBeNull();
  });
});

describe("parseBill", () => {
  it("an electricity bill: biller, amount due, due date, statement date, account last 4", () => {
    const text = `ENERGY STATEMENT\nwww.pge.com/MyEnergy\nAccount No: 1234567890-1\nStatement Date: 10/02/2026\nDue Date: 10/23/2026\n` +
      `Your Account Summary\nAmount Due on Previous Statement $98.10\nPayment(s) Received Since Last Statement -98.10\n` +
      `Current PG&E Electric Delivery Charges $61.22\nTotal Amount Due $143.27\n`;
    expect(parseBill(text, "pge-2026-10.pdf")).toEqual({
      biller: "PG&E", amount_cents: 14327, due_date: "2026-10-23", statement_date: "2026-10-02", account_hint: "7890",
    });
  });

  it("a quarterly water bill named by its first line, with written-out dates", () => {
    const text = `Coastside County Water District\nService Address 12 Example Way\nBill Date: July 1, 2026\n` +
      `Please Pay By: Jul 25, 2026\nAmount Due $212.40\n`;
    expect(parseBill(text)).toMatchObject({ biller: "Coastside County Water District", amount_cents: 21240, due_date: "2026-07-25", statement_date: "2026-07-01" });
  });

  it("a trash bill whose total is a 'Balance Due', and money with thousands separators", () => {
    expect(parseBill("Recology Sunset Scavenger\nInvoice Date 2026-09-30\nBalance Due: $1,034.50\nDue by 2026-10-30")).toMatchObject({
      biller: "Recology", amount_cents: 103450, due_date: "2026-10-30", statement_date: "2026-09-30",
    });
  });

  it("PG&E's summary: the total due now, not the previous statement's amount, with a date before the amount", () => {
    const summary = `Due Date: 10/19/2026\nYour Account Summary\nAmount Due on Previous Statement $267.08\n` +
      `Payment(s) Received Since Last Statement -267.08\nPrevious Unpaid Balance $0.00\nCurrent PG&E Electric Delivery Charges $95.97\n` +
      `Electric Adjustments -36.18\nAva Community Energy Electric Generation Charges 22.95\nCurrent Gas Charges 37.59\n` +
      `Total Amount Due by 10/19/2026 $120.33\nCurrent charges include a discount of $36.18 for CA Climate Credit.\n`;
    expect(parseBill(summary)).toMatchObject({ biller: "PG&E", amount_cents: 12033, due_date: "2026-10-19" });
    // the same, when the PDF's text puts each amount on its own line after its label
    expect(parseBill(summary.replace(/ (\$?-?[0-9]+\.[0-9]{2})\n/g, "\n$1\n")).amount_cents).toBe(12033);
    // a bill whose only total line is "Amount Due on Previous Statement" has no amount due found, not that one
    expect(parseBill("Amount Due on Previous Statement $267.08\n").amount_cents).toBeNull();
  });

  it("leaves what it can't find blank, and falls back to the file name for the biller", () => {
    expect(parseBill("1 2 3 4\n", "City_Water_Bill_202610.pdf")).toEqual({
      biller: "City Water Bill", amount_cents: null, due_date: null, statement_date: null, account_hint: null,
    });
  });
});
