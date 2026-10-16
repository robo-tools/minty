// The live demo's household: made-up people, accounts and transactions, generated in the
// visitor's browser relative to today, so ABC's periods and "Last synced" are always current.
// Nothing here is real: the people are "Alex" and "Sam", the last-4 digits are made up, and the
// employers, landlord and restaurants are invented. Banks, card products and big merchants are
// real names, because ABC recognises cards and credits by them.
// Deterministic for a given day (seeded PRNG), so a visitor sees the same data on reload.
// Plaid sign convention: POSITIVE amount = money out. Amounts are integer cents.

export interface DemoOwners { alex: string; sam: string }
/** Four more people with one transaction each (the household's in-jokes): label, bank, account, transaction. */
const CAMEOS: [string, string, [string, string, string, string, number], string, string, [number, number]][] = [
  ["Kate", "Capital One", ["360 Checking", "6120", "depository", "checking", 1840.25], "WM Money Center", "GENERAL_SERVICES", [8, 60]],
  ["Adam", "Wells Fargo", ["Everyday Checking", "4478", "depository", "checking", 3215.6], "PPK Call", "GENERAL_SERVICES", [15, 90]],
  ["Andy", "Discover", ["Discover it Card", "8034", "credit", "credit card", 312.48], "HBFC Supplements", "GENERAL_MERCHANDISE", [25, 120]],
  ["Maurice", "Bank of America", ["Customized Cash Rewards", "2957", "credit", "credit card", 527.1], "Bluz Cards Emes", "ENTERTAINMENT", [10, 75]],
];
export interface DemoData {
  users: string;                                    // the MINTY_USERS value
  items: Record<string, string | number | null>[];
  accounts: Record<string, string | number | null>[];
  transactions: Record<string, string | number | null>[];
  tags: [number, string, number][];                 // transaction_id, tag, position
  marks: [number, string, string][];                // account_id, benefit_id, period_start
  cardStatements: Record<string, string | number | null>[];   // Bills (docs/bills.md)
  statementSync: Record<string, string | number | null>[];
  bills: Record<string, string | number | null>[];            // the household's own bills (part 2)
  points: Record<string, string | number | null>[];           // BAM (docs/bam.md): miles and points readings
  netWorth: Record<string, string | number | null>[];         // CFA (docs/cfa.md): a made-up history up to yesterday
  investmentSync: Record<string, string | number | null>[];   // EGG (docs/cfa.md §3): retirement accounts
  securities: Record<string, string | number | null>[];
  holdings: Record<string, string | number | null>[];
  investmentTxns: Record<string, string | number | null>[];
  snapshots: Record<string, string | number | null>[];
}

export function generate(now = new Date(), owners: DemoOwners = { alex: "alex", sam: "sam" }): DemoData {
  let s = 20261013;                                  // mulberry32
  const rand = () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const between = (lo: number, hi: number) => lo + (hi - lo) * rand();
  const cents = (dollars: number) => Math.round(dollars * 100);
  const Y = now.getUTCFullYear(), M = now.getUTCMonth(), D = now.getUTCDate();
  const todayIso = iso(Y, M, D);
  const daysAgo = (n: number) => iso(Y, M, D - n);
  const DAYS = 160;                                                 // everyday spending and bills; card credits go back to last January
  const nowIso = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();

  const items: DemoData["items"] = [], accounts: DemoData["accounts"] = [], transactions: DemoData["transactions"] = [];
  const tags: DemoData["tags"] = [], marks: DemoData["marks"] = [];

  // owner, credential set, bank, consent ends in (days), accounts: [name, last-4, type, subtype, balance]
  const who = (k: string) => (k === "alex" || k === "sam" ? owners[k] : k);
  const BANKS: [string, string, number | null, [string, string, string, string, number][]][] = [
    ["alex", "Chase", null, [["Total Checking", "0417", "depository", "checking", 8421.55],
                             ["Sapphire Preferred", "2208", "credit", "credit card", 1932.40]]],
    ["alex", "American Express", null, [["The Platinum Card®", "1009", "credit", "credit card", 2760.12]]],
    ["sam", "American Express", null, [["Business Gold Card", "3006", "credit", "credit card", 1184.03]]],
    ["sam", "Citi", null, [["Citi Strata Premier℠ Card", "5512", "credit", "credit card", 642.77]]],
    ["sam", "Ally Bank", 5, [["Online Savings", "7731", "depository", "savings", 24510.00]]],
    ...CAMEOS.map(([label, bank, a]): [string, string, null, [string, string, string, string, number][]] => [label.toLowerCase(), bank, null, [a]]),
  ];
  const acct: Record<string, number> = {};
  BANKS.forEach(([person, bank, consentDays, accts], i) => {
    const itemId = i + 1;
    items.push({
      id: itemId, owner: who(person), plaid_account: `${who(person)}_primary`, plaid_item_id: `demo-item-${itemId}`,
      access_token_enc: "demo-no-token", institution_name: bank, txn_cursor: "demo-cursor", status: "good",
      updated_at: nowIso(14 + i * 3), attempted_at: nowIso(14 + i * 3), checked_at: nowIso(90),
      consent_expires_at: consentDays == null ? null : new Date(now.getTime() + consentDays * 864e5).toISOString(),
    });
    accts.forEach(([name, mask, type, subtype, bal], j) => {
      const id = itemId * 10 + j;
      acct[`${person}:${name}`] = id;
      accounts.push({ id, owner: who(person), item_id: itemId, plaid_account_id: `demo-acct-${id}`, name, mask, type, subtype,
                      balance_current_cents: cents(bal), balance_available_cents: type === "credit" ? null : cents(bal), currency: "USD" });
    });
  });
  const ownerOf = (accountId: number) => accounts.find((a) => a.id === accountId)!.owner as string;

  let nextId = 1;
  const add = (accountId: number, date: string, dollars: number, name: string, merchant: string | null, category: string,
               o: { tags?: string[]; member?: string | null } = {}) => {
    if (date > todayIso) return;
    const id = nextId++;
    const age = daysBetween(date, todayIso);
    transactions.push({
      id, owner: ownerOf(accountId), account_id: accountId, plaid_txn_id: `demo-txn-${id}`, amount_cents: cents(dollars), currency: "USD",
      date, datetime: `${date}T${String(8 + Math.floor(rand() * 13)).padStart(2, "0")}:${String(Math.floor(rand() * 60)).padStart(2, "0")}:00Z`,
      name, merchant_name: merchant, category, pending: age <= 1 && dollars > 0 && rand() < 0.6 ? 1 : 0, pending_txn_id: null,
      account_owner: o.member ?? null,
    });
    (o.tags ?? []).forEach((t, pos) => tags.push([id, t, pos]));
  };

  const checking = acct["alex:Total Checking"], sapphire = acct["alex:Sapphire Preferred"];
  const platinum = acct["alex:The Platinum Card®"], gold = acct["sam:Business Gold Card"];
  const strata = acct["sam:Citi Strata Premier℠ Card"], savings = acct["sam:Online Savings"];
  const member = () => (rand() < 0.3 ? "SAM MORGAN" : "ALEX MORGAN");     // Sam is an additional card member

  // --- Everyday spending: merchant, category, [min, max], times per 30 days, card, tag
  const SPEND: [string, string, [number, number], number, number, string | null][] = [
    ["Whole Foods Market", "FOOD_AND_DRINK", [38, 165], 4, sapphire, "groceries"],
    ["Trader Joe's", "FOOD_AND_DRINK", [24, 96], 3, strata, "groceries"],
    ["Blue Bottle Coffee", "FOOD_AND_DRINK", [4.5, 13], 7, platinum, null],
    ["DoorDash", "FOOD_AND_DRINK", [22, 68], 2, sapphire, "eating-out"],
    ["Lantern & Rye", "FOOD_AND_DRINK", [48, 140], 2, platinum, "eating-out"],
    ["Shell", "TRANSPORTATION", [38, 72], 2, strata, null],
    ["Uber", "TRANSPORTATION", [11, 42], 3, platinum, null],
    ["Amazon", "GENERAL_MERCHANDISE", [14, 180], 4, sapphire, null],
    ["Target", "GENERAL_MERCHANDISE", [19, 120], 2, strata, "household"],
    ["Costco", "GENERAL_MERCHANDISE", [85, 260], 1, sapphire, "groceries"],
    ["CVS Pharmacy", "MEDICAL", [8, 46], 1, strata, null],
    ["Staples", "GENERAL_MERCHANDISE", [12, 64], 1, gold, "reimbursable"],
  ];
  for (const [merchant, category, [lo, hi], per30, card, tag] of SPEND) {
    const n = Math.round((per30 * DAYS) / 30 * between(0.75, 1.15));
    for (let k = 0; k < n; k++) {
      const name = rand() < 0.35 ? merchant.toUpperCase() : merchant;
      add(card, daysAgo(Math.floor(rand() * DAYS)), between(lo, hi), name, merchant, category,
          { tags: tag && rand() < 0.7 ? [tag] : [], member: card === platinum ? member() : null });
    }
  }
  // monthly bills and pay
  for (let d = 0; d < DAYS; d += 1) {
    const day = daysAgo(d), dom = Number(day.slice(8));
    if (dom === 1) add(checking, day, 3150, "Maple Court Apartments Rent", null, "RENT_AND_UTILITIES", { tags: ["rent"] });
    if (dom === 15 || dom === 28) add(checking, day, -4280.5, "NORTHWIND LABS PAYROLL", null, "INCOME");
    if (dom === 7) add(checking, day, between(95, 190), "PG&E", "PG&E", "RENT_AND_UTILITIES", { tags: ["utilities"] });
    if (dom === 11) add(checking, day, 79.99, "Comcast Xfinity", "Comcast Xfinity", "RENT_AND_UTILITIES", { tags: ["utilities"] });
    if (dom === 18) add(sapphire, day, 15.49, "Netflix", "Netflix", "ENTERTAINMENT", { tags: ["subscriptions"] });
    if (dom === 21) add(strata, day, 11.99, "Spotify", "Spotify", "ENTERTAINMENT", { tags: ["subscriptions"] });
    if (dom === 27) add(savings, day, -between(70, 95), "Interest Payment", null, "INCOME");
  }
  add(checking, daysAgo(33), 1500, "Transfer to Ally Savings", null, "TRANSFER_OUT");
  add(savings, daysAgo(32), -1500, "Transfer from Chase Checking", null, "TRANSFER_IN");
  add(checking, daysAgo(9), -64, "Zelle from Riley", null, "TRANSFER_IN", { tags: ["reimbursable"] });

  // --- Card credits, this year and last, so ABC shows used, partly used, open and tick-box ones.
  const cur = { y: Y, m: M };
  const months = (from: number, to: number) => {                   // [y, m] for months from..to ago
    const out: [number, number][] = [];
    for (let k = to; k >= from; k--) { const d = new Date(Date.UTC(Y, M - k, 1)); out.push([d.getUTCFullYear(), d.getUTCMonth()]); }
    return out;
  };
  const day = (y: number, m: number, d: number) => iso(y, m, d);
  const back = M + 12;                                              // months back to last January

  // Platinum (Alex): annual fee, digital entertainment, Walmart+, Uber One, Resy, lululemon, hotel, airline, CLEAR
  add(platinum, day(Y, 1, 4), 895, "PLATINUM ANNUAL MEMBERSHIP FEE", null, "BANK_FEES");
  add(platinum, day(Y - 1, 1, 4), 695, "PLATINUM ANNUAL MEMBERSHIP FEE", null, "BANK_FEES");
  for (const [y, m] of months(0, back)) {
    const isCur = y === cur.y && m === cur.m;
    add(platinum, day(y, m, 3), 15.99, "DISNEY PLUS", "Disney+", "ENTERTAINMENT", { tags: ["subscriptions"], member: "ALEX MORGAN" });
    add(platinum, day(y, m, 9), 6.25, "NYTIMES DIGITAL", "The New York Times", "ENTERTAINMENT", { tags: ["subscriptions"], member: "ALEX MORGAN" });
    if (!isCur || D >= 12) add(platinum, day(y, m, isCur ? 12 : 11), -(isCur ? 15.99 : 22.24), "Platinum Digital Entertainment Credit", null, "BANK_FEES");
    if (y === Y || m >= 6) {                                        // Walmart+ from last July
      add(platinum, day(y, m, 6), 14.03, "Walmart+ Membership", "Walmart+", "GENERAL_MERCHANDISE", { member: "ALEX MORGAN" });
      if (!(y === Y && m === M - 2)) add(platinum, day(y, m, 7), -14.03, "Walmart", "Walmart", "GENERAL_MERCHANDISE");   // one month missed
    }
    add(platinum, day(y, m, 14), 9.99, "UBER ONE MEMBERSHIP", "Uber One", "TRANSPORTATION", { member: "ALEX MORGAN" });
    add(platinum, day(y, m, 16), -9.99, "Uber One Credit", null, "BANK_FEES");
    if (!isCur && rand() < 0.85) marks.push([platinum, "uber_cash", day(y, m, 1)]);   // ticked: used in the Uber app
  }
  for (const y of [Y - 1, Y]) for (let q = 0; q < 4; q++) {
    const qs = q * 3, curQ = y === Y && Math.floor(M / 3) === q;
    if (y === Y && qs > M) break;
    const resy = curQ ? 54.2 : y === Y && q === Math.floor(M / 3) - 1 ? 0 : between(70, 128);   // last quarter missed
    if (resy) {
      add(platinum, day(y, qs + 1, 2), resy, "RESY* LANTERN AND RYE", "Lantern & Rye", "FOOD_AND_DRINK", { tags: ["eating-out"], member: member() });
      add(platinum, day(y, qs + 1, 5), -Math.min(resy, 100), "Platinum Resy Credit", null, "BANK_FEES");
    }
    if (!curQ && (y === Y - 1 || q % 2 === 1)) {
      add(platinum, day(y, qs, 20), 98, "LULULEMON.COM", "lululemon", "GENERAL_MERCHANDISE", { member: member() });
      add(platinum, day(y, qs, 23), -75, "Platinum Lululemon Credit", null, "BANK_FEES");
    }
  }
  for (const y of [Y - 1, Y]) {
    add(platinum, day(y, 2, 18), 742.6, "AMEX TRAVEL FINE HOTELS", "Amex Travel", "TRAVEL", { tags: ["travel"], member: "ALEX MORGAN" });
    add(platinum, day(y, 2, 21), -300, "Platinum Hotel Credit", null, "BANK_FEES");
    if (y < Y) {
      add(platinum, day(y, 8, 9), 488, "AMEX TRAVEL HOTEL COLLECTION", "Amex Travel", "TRAVEL", { tags: ["travel"], member: "ALEX MORGAN" });
      add(platinum, day(y, 8, 12), -300, "Platinum Hotel Credit", null, "BANK_FEES");
    }
    add(platinum, day(y, 4, 10), 70, "UNITED AIRLINES BAGGAGE", "United Airlines", "TRAVEL", { tags: ["travel"], member: "ALEX MORGAN" });
    add(platinum, day(y, 4, 13), -70, "Airline Fee Credit", null, "BANK_FEES");
    add(platinum, day(y, 7, 22), 45, "UNITED AIRLINES SEAT", "United Airlines", "TRAVEL", { tags: ["travel"], member: "ALEX MORGAN" });
    add(platinum, day(y, 7, 24), -45, "Airline Fee Credit", null, "BANK_FEES");
    add(platinum, day(y, 0, 26), 209, "CLEAR *CLEARME.COM", "CLEAR", "TRAVEL", { member: "ALEX MORGAN" });
    add(platinum, day(y, 0, 28), -209, "CLEAR Plus Credit", null, "BANK_FEES");
  }

  // Business Gold (Sam): flexible business credit (Grubhub, office supplies), ChatGPT Business
  add(gold, day(Y, 3, 2), 375, "BUSINESS GOLD ANNUAL MEMBERSHIP FEE", null, "BANK_FEES");
  for (const [y, m] of months(0, back)) {
    const isCur = y === cur.y && m === cur.m;
    const lunch = isCur ? 12.4 : between(24, 38);
    add(gold, day(y, m, 4), lunch, "GRUBHUB*BLUEBIRD DELI", "Grubhub", "FOOD_AND_DRINK", { tags: ["reimbursable"] });
    if (!isCur || D >= 6) add(gold, day(y, m, 6), -Math.min(lunch, 20), "Flexible Business Credit", null, "BANK_FEES");
    if (y === Y) {
      add(gold, day(y, m, 8), 30, "OPENAI *CHATGPT SUBSCR", "OpenAI", "GENERAL_SERVICES", { tags: ["subscriptions"] });
      if (!isCur) add(gold, day(y, m, 25), -30, "ChatGPT Business Credit", null, "BANK_FEES");
    }
  }

  // The cameos: one transaction each, in the last two weeks.
  for (const [label, , [name], txn, category, [lo, hi]] of CAMEOS) {
    add(acct[`${label.toLowerCase()}:${name}`], daysAgo(2 + Math.floor(rand() * 12)), between(lo, hi), txn, txn, category);
  }

  // Bills: four statements per card, paid from checking about two weeks after each closes, except
  // the latest, planned to show each state: Platinum paid, Business Gold partly paid, Sapphire not
  // paid and due in 3 days (Needs attention), Strata Premier not paid yet, due later.
  const cardStatements: DemoData["cardStatements"] = [], statementSync: DemoData["statementSync"] = [];
  const BILLS: [number, string, number[], number, number][] = [
    [platinum, "AMEX", [1234.56, 980.1, 1410.75, 760.2], 1, 13],
    [gold, "AMEX", [845.2, 512.3, 690, 430.55], 0.35, 9],
    [sapphire, "CHASE", [512.4, 610.95, 455.1, 380], 0, 3],
    [strata, "CITI", [214.8, 198.4, 260.1, 175.25], 0, 18],
  ];
  const seenAt = nowIso(25);
  for (const [card, bankName, balances, latestPaid, dueIn] of BILLS) {
    const latestIssue = dueIn - 25;                                  // closes 25 days before it's due
    let lastPay: [number, string] | null = null;
    balances.map((bal, k) => ({ bal, k, issue: daysAgo(-(latestIssue - 30 * k)), due: daysAgo(-(latestIssue - 30 * k + 25)) }))
      .reverse()                                                    // oldest first, so the last payment is the latest one
      .forEach(({ bal, k, issue, due }) => {
        const share = k === 0 ? latestPaid : 1;
        const payDay = k === 0 ? daysAgo(2) : daysAgo(-(latestIssue - 30 * k + 15));
        if (share > 0) {
          const paid = Math.round(bal * share * 100) / 100;
          add(card, payDay, -paid, "AUTOPAY PAYMENT - THANK YOU", null, "LOAN_PAYMENTS");
          add(checking, payDay, paid, `${bankName} EPAYMENT`, null, "LOAN_PAYMENTS");
          lastPay = [cents(paid), payDay];
        }
        cardStatements.push({ account_id: card, issue_date: issue, balance_cents: cents(bal),
          minimum_payment_cents: cents(Math.max(35, Math.round(bal * 0.02))), due_date: due,
          last_payment_cents: lastPay?.[0] ?? null, last_payment_date: lastPay?.[1] ?? null, is_overdue: 0,
          first_seen_at: seenAt, last_seen_at: seenAt });
      });
    const itemId = accounts.find((a) => a.id === card)!.item_id as number;
    if (!statementSync.some((r) => r.item_id === itemId)) statementSync.push({ item_id: itemId, status: "ready", synced_at: seenAt, enabled_at: seenAt });
  }

  // The household's own bills: last month's PG&E (matched to the payment from checking), this
  // month's (not paid yet), a quarterly water bill read from a PDF, and a quarterly trash bill
  // marked paid by hand.
  const bills: DemoData["bills"] = [];
  const lastPge = transactions.filter((t) => t.name === "PG&E" && String(t.date) <= daysAgo(3)).sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  const bill = (biller: string, match: string, amount: number, due: string, statement: string | null, extra: Record<string, string | null> = {}) =>
    bills.push({ owner: owners.alex, biller, match_name: match, amount_cents: amount, due_date: due, statement_date: statement,
                 account_hint: null, source: "manual", file_sha256: null, paid_at: null, ...extra });
  if (lastPge) bill("PG&E", "PG&E", Number(lastPge.amount_cents), addDays(String(lastPge.date), 2), addDays(String(lastPge.date), -20), { account_hint: "4410" });
  bill("PG&E", "PG&E", 14218, daysAgo(-8), daysAgo(12), { account_hint: "4410" });
  bill("Coastside County Water District", "COASTSIDE", 21240, daysAgo(-20), daysAgo(5),
       { source: "pdf", file_sha256: "0d3f1c5a8e2b7d6c4f9a1e3b5c7d9f0a2b4c6d8e0f1a3b5c7d9e1f3a5b7c9d1e" });
  bill("Recology", "RECOLOGY", 18975, daysAgo(-12), daysAgo(18), { paid_at: nowIso(60 * 26) });

  // BAM: a few currencies across both people, with a little history, and one balance not
  // updated in months (it shows "update?").
  const points: DemoData["points"] = [];
  const reading = (owner: string, program: string, balance: number, ago: number, hint: string | null = null) =>
    points.push({ owner, program, account_hint: hint, balance, as_of: daysAgo(ago), source: "manual", file_sha256: null });
  reading(owners.alex, "amex_mr", 61250, 64); reading(owners.alex, "amex_mr", 72480, 34); reading(owners.alex, "amex_mr", 84210, 4);
  reading(owners.alex, "chase_ur", 118900, 40); reading(owners.alex, "chase_ur", 132450, 9);
  reading(owners.sam, "chase_ur", 23700, 12);
  reading(owners.sam, "united", 41800, 21);
  reading(owners.alex, "hyatt", 27300, 15);
  reading(owners.sam, "marriott", 96000, 131);

  // EGG: an Investments-only login per person (made-up balances), with two years of contributions,
  // what each account holds, and five months of balance history.
  const investmentSync: DemoData["investmentSync"] = [], holdings: DemoData["holdings"] = [];
  const investmentTxns: DemoData["investmentTxns"] = [], snapshots: DemoData["snapshots"] = [];
  const securities: DemoData["securities"] = [
    { security_id: "demo-sec-500", name: "Sample 500 Index Fund", ticker: "SXAIX", type: "mutual fund", is_cash_equivalent: 0, close_price: 214.18 },
    { security_id: "demo-sec-bond", name: "Sample Total Bond Index Fund", ticker: "SXBDX", type: "mutual fund", is_cash_equivalent: 0, close_price: 9.87 },
    { security_id: "demo-sec-2055", name: "Sample Target Date 2055 Fund", ticker: "STDFX", type: "mutual fund", is_cash_equivalent: 0, close_price: 18.42 },
    { security_id: "demo-sec-cash", name: "Cash", ticker: "CUR:USD", type: "cash", is_cash_equivalent: 1, close_price: 1 },
  ];
  const RETIRE: [string, [string, string, string, number, [string, number][], number][]][] = [
    // person, accounts: [name, last-4, subtype, balance, holdings [security, share of balance], contribution a month]
    ["alex", [["Northwind Labs 401(k)", "4401", "401k", 128450, [["demo-sec-500", 0.7], ["demo-sec-bond", 0.2], ["demo-sec-cash", 0.1]], 1625],
              ["Roth IRA", "5512", "roth", 41200, [["demo-sec-2055", 1]], 500]]],
    ["sam", [["Health Savings Account", "6623", "hsa", 9850, [["demo-sec-500", 0.6], ["demo-sec-cash", 0.4]], 300],
             ["Rollover IRA", "7734", "ira", 63000, [["demo-sec-2055", 0.85], ["demo-sec-bond", 0.15]], 0]]],
  ];
  RETIRE.forEach(([person, accts], k) => {
    const itemId = items.length + 1;
    items.push({ id: itemId, owner: who(person), plaid_account: `${who(person)}_primary`, plaid_item_id: `demo-item-${itemId}`,
                 access_token_enc: "demo-no-token", institution_name: "Sample Brokerage", txn_cursor: null, status: "good", products: "investments",
                 updated_at: nowIso(400), attempted_at: null, checked_at: nowIso(90), consent_expires_at: null });
    investmentSync.push({ item_id: itemId, status: "ready", synced_at: nowIso(30 + k * 7), next_attempt_at: nowIso(-600), txn_offset: 0 });
    accts.forEach(([name, mask, subtype, bal, held, monthly], j) => {
      const id = itemId * 10 + j;
      accounts.push({ id, owner: who(person), item_id: itemId, plaid_account_id: `demo-acct-${id}`, name, mask, type: "investment", subtype,
                      balance_current_cents: cents(bal), balance_available_cents: null, currency: "USD" });
      for (const [sec, share] of held) {
        const price = Number(securities.find((x) => x.security_id === sec)!.close_price);
        holdings.push({ account_id: id, security_id: sec, quantity: Math.round((bal * share / price) * 1000) / 1000, value_cents: cents(bal * share), cost_basis_cents: cents(bal * share * 0.82), price });
      }
      for (let m = 0; m < 24 && monthly; m++) {
        investmentTxns.push({ account_id: id, plaid_inv_txn_id: `demo-inv-${id}-${m}`, date: iso(Y, M - m, 15), name: "Contribution", type: "cash", subtype: "contribution",
                              amount_cents: -cents(monthly), quantity: 0, fees_cents: 0, security_id: null });
      }
      if (j === 0) investmentTxns.push({ account_id: id, plaid_inv_txn_id: `demo-inv-${id}-fee`, date: iso(Y, 2, 31), name: "Account fee", type: "fee", subtype: "account fee",
                                         amount_cents: 2500, quantity: 0, fees_cents: 2500, security_id: null });
      // a balance history that ends at today's balance: contributions, and markets going up and down
      for (let d = 150; d >= 1; d--) {
        const market = 1 - d * 0.00045 + Math.sin(d / 11) * 0.018;
        snapshots.push({ account_id: id, date: daysAgo(d), current_cents: cents(bal * market - monthly * d / 30) });
      }
    });
  });

  // CFA: net worth by day for each person, drifting towards today's balances (today's row comes
  // from the demo's own snapshot of the accounts).
  const netWorth: DemoData["netWorth"] = [];
  for (const owner of [owners.alex, owners.sam]) {
    const mine = accounts.filter((a) => a.owner === owner);
    const held = mine.filter((a) => a.type === "depository" || a.type === "investment").reduce((s, a) => s + Number(a.balance_current_cents ?? 0), 0);
    const owed = mine.filter((a) => a.type === "credit" || a.type === "loan").reduce((s, a) => s + Number(a.balance_current_cents ?? 0), 0);
    for (let d = 150; d >= 1; d--) {
      const drift = 1 - d * 0.0011 + Math.sin(d / 9) * 0.012;
      netWorth.push({ date: daysAgo(d), owner, assets_cents: Math.round(held * drift), debts_cents: Math.round(owed * (0.85 + 0.3 * Math.abs(Math.sin(d / 13)))) });
    }
  }

  const users = [`${owners.alex}:Alex`, `${owners.sam}:Sam`, ...CAMEOS.map(([label]) => `${label.toLowerCase()}:${label}`)].join(",");
  return { users, items, accounts, transactions, tags, marks, cardStatements, statementSync, bills, points, netWorth,
           investmentSync, securities, holdings, investmentTxns, snapshots };
}

/** The Worker settings the demo runs with: its people, and placeholder Plaid keys for each, so no
 * bank shows as "has no Plaid keys". The keys are never used: the demo never calls Plaid. */
export function demoEnv(d: DemoData): Record<string, string> {
  const env: Record<string, string> = { MINTY_USERS: d.users };
  for (const u of d.users.split(",")) {
    const k = u.split(":")[0].toUpperCase();
    env[`PLAID_CLIENT_ID_${k}_PRIMARY`] = env[`PLAID_SECRET_${k}_PRIMARY`] = "demo-not-a-key";
  }
  return env;
}

/** INSERT statements (SQL with ? placeholders, values) for the data, parents first. */
export function statements(d: DemoData): [string, (string | number | null)[]][] {
  const ins = (table: string, rows: Record<string, string | number | null>[]) => rows.map((r): [string, (string | number | null)[]] => {
    const cols = Object.keys(r);
    return [`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, cols.map((c) => r[c])];
  });
  return [
    ...ins("items", d.items), ...ins("accounts", d.accounts), ...ins("transactions", d.transactions),
    ...d.tags.map((t): [string, (string | number | null)[]] => ["INSERT INTO transaction_tags (transaction_id, tag, position) VALUES (?, ?, ?)", t]),
    ...d.marks.map((m): [string, (string | number | null)[]] => ["INSERT INTO benefit_marks (account_id, benefit_id, period_start, marked_by) VALUES (?, ?, ?, 'demo')", m]),
    ...ins("point_balances", d.points), ...ins("net_worth", d.netWorth),
    ...ins("investment_sync", d.investmentSync), ...ins("securities", d.securities), ...ins("holdings", d.holdings),
    ...ins("investment_txns", d.investmentTxns), ...ins("balance_snapshots", d.snapshots),
  ];
}

function iso(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
}
function addDays(d: string, n: number): string {
  return new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
}
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
}
