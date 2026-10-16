// Reads a miles or points balance from the text of a statement PDF (BAM, docs/bam.md): the
// program, the balance, the date it was correct and the account's last 4 digits. Runs in the
// browser (bam.js extracts the text with pdf.js; the PDF never leaves the device). Pure, so it's
// tested in vitest. A first guess for the review table; a PDF with no balance it recognises gives
// program null, and isn't offered.
import { isoDate } from "./bill-parse.js";

const DATE = String.raw`((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}/\d{1,2}/\d{2,4})`;
const POINTS = String.raw`([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,9})(?![0-9.,/]|\s*%)`;   // 65,536 or 512; never $ or a date

// Each program: how its balance box reads. The number can come after the date, before it, or even
// before the box's title, because pdf.js gives text in the order it was drawn, which isn't always
// reading order (a right-aligned number is often drawn first).
const PROGRAMS = [
  {
    id: "amex_mr",
    // "Membership Rewards® Points / Available and Pending as of 08/31/26 / 65,536"
    box: String.raw`Membership\s+Rewards[®\s]*Points?`,
    dated: String.raw`(?:available|pending|balance)[a-z\s]{0,30}as\s+of\s*:?\s*` + DATE,
    statementDate: String.raw`Closing\s+Date\s*:?\s*` + DATE,
    account: /Account\s+Ending(?:\s+in)?\s*:?\s*([0-9][0-9 -]{2,14}[0-9])/i,
  },
];

const GAP = String.raw`[^$\d]{0,40}?`;                      // a little text, never a dollar amount or a number

/** The balance in one statement's text: { program, balance, as_of, account_hint }, each null when
 * not found. */
export function parsePoints(text) {
  const t = text.replace(/ /g, " ").replace(/[ \t]+/g, " ");
  for (const p of PROGRAMS) {
    // Every mention of the program: the balance box is the one with "as of <date>" next to a
    // number; a mention without one (a promotion, a summary line) is the last resort.
    let balance = null, asOf = null, found = false, m;
    for (const box of t.matchAll(new RegExp(p.box, "gi"))) {
      found = true;
      const after = t.slice(box.index, box.index + 300);
      if ((m = new RegExp(p.box + GAP + p.dated + String.raw`\s*` + POINTS, "i").exec(after))) { [asOf, balance] = [m[1], m[2]]; break; }
      if ((m = new RegExp(p.box + String.raw`\s*` + POINTS + GAP + p.dated, "i").exec(after))) { [balance, asOf] = [m[1], m[2]]; break; }
      // a right-aligned number can come out before the box's title: "91,337 / Membership Rewards®
      // Points / Available and Pending as of / 10/14/26". Only with the box's date, and only a number
      // that isn't the end of a date or an amount.
      const before = /(?<![\d/.,$-])([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,9})\s*$/.exec(t.slice(Math.max(0, box.index - 20), box.index));
      if (before && (m = new RegExp(p.box + GAP + p.dated, "i").exec(after))) { [balance, asOf] = [before[1], m[1]]; break; }
      if (balance === null && (m = new RegExp(p.box + String.raw`[^$\d]{0,80}?` + POINTS, "i").exec(after))) balance = m[1];   // no date in the box
    }
    if (!found) continue;
    const statement = new RegExp(p.statementDate, "i").exec(t)?.[1] ?? null;
    const digits = p.account.exec(t)?.[1]?.replace(/\D/g, "") ?? "";
    return {
      program: p.id,
      balance: balance === null ? null : Number(balance.replace(/,/g, "")),
      as_of: isoDate(asOf) ?? isoDate(statement),
      account_hint: digits.length >= 4 ? digits.slice(-4) : null,
    };
  }
  return { program: null, balance: null, as_of: null, account_hint: null };
}
