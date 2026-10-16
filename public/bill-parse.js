// Reads a bill's fields from the text of its PDF (Bills, docs/bills.md): the biller, amount due,
// due date, statement date and the account's last 4 digits. Runs in the browser (bills.js extracts
// the text with pdf.js; the PDF never leaves the device). Pure, so it's tested in vitest. It's a
// first guess for the review table: whatever it can't find is left blank for the person to fill in.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

// Billers whose names are recognised anywhere in the text (more can be added; the review shows what
// was found either way).
const KNOWN = [
  [/\bPG\s*&\s*E\b|Pacific Gas (and|&) Electric/i, "PG&E"],
  [/San Francisco Public Utilities|\bSFPUC\b/i, "SFPUC"],
  [/\bRecology\b/i, "Recology"],
  [/Southern California Edison|\bSCE\b/i, "SCE"],
  [/San Diego Gas (and|&) Electric|\bSDG\s*&\s*E\b/i, "SDG&E"],
  [/\bSoCalGas\b|Southern California Gas/i, "SoCalGas"],
  [/\bComcast\b|\bXfinity\b/i, "Xfinity"],
  [/\bAT\s*&\s*T\b/i, "AT&T"],
  [/\bVerizon\b/i, "Verizon"],
  [/\bT-?Mobile\b/i, "T-Mobile"],
  [/Waste Management|\bWM\b(?= )/i, "Waste Management"],
  [/Republic Services/i, "Republic Services"],
  [/East Bay Municipal Utility|\bEBMUD\b/i, "EBMUD"],
  [/Water District|Water Department|Water Company|Water Service/i, null],   // a water bill: name from its first line
];

const MONEY = String.raw`\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})`;
const DATE = String.raw`((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}/\d{1,2}/\d{2,4}|\d{4}-\d{2}-\d{2})`;

/** "Oct 28, 2026", "10/28/2026", "10/28/26", "2026-10-28" -> "2026-10-28"; null if not a real date. */
export function isoDate(s) {
  if (!s) return null;
  let y, m, d;
  let r = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (r) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) [m, d, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/))) [m, d, y] = [MONTHS[r[1].slice(0, 4).toLowerCase()] ?? MONTHS[r[1].slice(0, 3).toLowerCase()], Number(r[2]), Number(r[3])];
  else return null;
  if (y < 100) y += 2000;
  if (!m || m > 12 || !d || d > 31) return null;
  const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return new Date(iso + "T00:00:00Z").toISOString().slice(0, 10) === iso ? iso : null;
}

const cents = (s) => (s ? Math.round(Number(s.replace(/[$,\s]/g, "")) * 100) : null);
const first = (text, patterns) => {
  for (const re of patterns) { const m = text.match(re); if (m) return m[1]; }
  return null;
};

/** The fields of one bill, from its text (pages joined) and, as a last resort, its file name. */
export function parseBill(text, fileName = "") {
  const t = text.replace(/ /g, " ").replace(/[ \t]+/g, " ");
  // The amount due now, never the previous statement's: "Total Amount Due by 10/19/2026 $120.33"
  // (PG&E puts the date between the words and the amount), and "Amount Due on Previous Statement"
  // is skipped. Most specific first.
  const DUE_BY = String.raw`(?:\s+(?:by|on)\s+` + DATE.replace(/^\(/, "(?:") + String.raw`)?\s*:?\s*`;   // the date isn't captured
  const NOT_PREVIOUS = String.raw`(?!\s+(?:on|from)\s+(?:your\s+)?(?:previous|last|prior)\b)`;
  const amount = cents(first(t, [
    new RegExp(String.raw`total\s+amount\s+due` + DUE_BY + MONEY, "i"),
    new RegExp(String.raw`amount\s+due` + NOT_PREVIOUS + DUE_BY + MONEY, "i"),
    new RegExp(String.raw`(?:total|balance|new\s+charges)\s+due` + NOT_PREVIOUS + DUE_BY + MONEY, "i"),
    new RegExp(String.raw`please\s+pay` + DUE_BY + MONEY, "i"),
    new RegExp(String.raw`total\s+(?:current\s+)?charges[^$\d\n]{0,40}` + MONEY, "i"),
  ]));
  const due = isoDate(first(t, [
    new RegExp(String.raw`(?:payment\s+)?due\s+(?:date|on|by)\s*:?\s*` + DATE, "i"),
    new RegExp(String.raw`due\s*:?\s*` + DATE, "i"),
    new RegExp(String.raw`pay\s+by\s*:?\s*` + DATE, "i"),
  ]));
  const issued = isoDate(first(t, [
    new RegExp(String.raw`(?:statement|bill(?:ing)?|issue|invoice)\s+date\s*:?\s*` + DATE, "i"),
    new RegExp(String.raw`date\s+(?:of\s+)?(?:bill|statement|issue)\s*:?\s*` + DATE, "i"),
  ]));
  const account = first(t, [/account\s*(?:number|no\.?|#)?\s*:?\s*[0-9Xx*•\-\s]{0,20}?(\d{4})\b/i]);
  let biller = null;
  for (const [re, name] of KNOWN) {
    if (re.test(t)) { biller = name ?? firstLine(t); break; }
  }
  if (!biller) biller = firstLine(t) || nameFromFile(fileName);
  return { biller: biller ? biller.slice(0, 80) : null, amount_cents: amount, due_date: due, statement_date: issued, account_hint: account };
}

// A bill's first line of plain words is usually its company name.
function firstLine(t) {
  const line = t.split(/\n/).map((s) => s.trim()).find((s) => /^[A-Za-z][A-Za-z&'.,\- ]{2,60}$/.test(s) && !/^(page|account|statement|bill|invoice)\b/i.test(s));
  return line ?? null;
}
const nameFromFile = (f) => (f.replace(/\.pdf$/i, "").replace(/[_\-]+/g, " ").replace(/\d{4,}/g, "").trim() || null);
