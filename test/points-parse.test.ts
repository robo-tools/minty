import { describe, expect, it } from "vitest";
import { parsePoints } from "../public/points-parse.js";

// BAM, part 2 (docs/bam.md): reading a points balance from a statement's text. Made-up text in
// the layout of an Amex statement's header and Membership Rewards box; never a real statement.
const header = "Prepared for\nALEX SAMPLE\nClosing Date 09/27/26\nAccount Ending 7-12004\n";
const box = "Membership Rewards® Points\nAvailable and Pending as of 08/31/26\n84,210\nFor more details about Rewards, please\nvisit americanexpress.com/rewardsinfo\n";
const summary = "New Balance $1,234.56\nMinimum Payment Due $35.00\nPayment Due Date 10/22/26\nPrevious Balance $980.10\n";

describe("parsePoints: Amex Membership Rewards", () => {
  it("reads the box: program, balance, its own date, and the card's last 4", () => {
    expect(parsePoints(header + summary + box)).toEqual({ program: "amex_mr", balance: 84210, as_of: "2026-08-31", account_hint: "2004" });
  });

  it("the same when pdf.js gives the number before the date, or everything on one line", () => {
    const swapped = "Membership Rewards® Points\n84,210\nAvailable and Pending as of 08/31/26\n";
    expect(parsePoints(header + swapped)).toMatchObject({ balance: 84210, as_of: "2026-08-31" });
    expect(parsePoints((header + box + summary).replace(/\n/g, " "))).toMatchObject({ balance: 84210, as_of: "2026-08-31", account_hint: "2004" });
  });

  it("a right-aligned number that pdf.js gives before the box's title", () => {
    const drawnFirst = "Payment Due Date 11/08/26\n84,210\nMembership Rewards® Points\nAvailable and Pending as of\n08/31/26\nFor more details\n";
    expect(parsePoints(header + drawnFirst)).toMatchObject({ balance: 84210, as_of: "2026-08-31" });
    // but never the end of a date or an amount just before the title
    for (const end of ["11/08/26", "$35.00", "1-800-000-0000"]) {
      expect(parsePoints(`${end}\nMembership Rewards® Points\nAvailable and Pending as of 08/31/26\nFor more details\n`).balance, end).toBeNull();
    }
  });

  it("never takes a dollar amount, a date or a percentage for the balance (blank instead)", () => {
    for (const after of ["$35.00", "1.5%", "10/22/26", ""]) {
      expect(parsePoints(`Membership Rewards Points\nAvailable and Pending as of 08/31/26\n${after}\n`).balance, after).toBeNull();
    }
  });

  it("small and very large balances; no box date falls back to the closing date", () => {
    expect(parsePoints("Membership Rewards Points\nAvailable and Pending as of 08/31/26\n0\n").balance).toBe(0);
    expect(parsePoints("Membership Rewards Points\nAvailable and Pending as of 08/31/26\n1,204,375\n").balance).toBe(1204375);
    expect(parsePoints(header + "Membership Rewards® Points\n84,210\n")).toMatchObject({ balance: 84210, as_of: "2026-09-27" });
  });

  it("the dated box wins over an earlier mention (a promotion or a summary line)", () => {
    const promo = "Earn 3X Membership Rewards points on flights booked directly with airlines, up to 500,000 a year.\n";
    expect(parsePoints(header + promo + summary + box)).toMatchObject({ balance: 84210, as_of: "2026-08-31" });
    const earned = "Membership Rewards Points earned this period 2,350\n";
    expect(parsePoints(header + earned + box).balance).toBe(84210);
  });

  it("a statement with no points box (a utility bill) has no program", () => {
    expect(parsePoints("PG&E\nTotal Amount Due by 10/19/2026 $120.33\nAccount Ending 4410\n")).toEqual({ program: null, balance: null, as_of: null, account_hint: null });
  });
});
