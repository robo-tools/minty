/** CFA, phase C3 (docs/cfa.md §2.3): the audit's recommendations, as rules in code. Each turns the
 * totals the cron prepared into one finding: what was found, why it matters, one action, the
 * dollars a year at stake when there's an honest number for it, and the numbers it used. Pure, so
 * every rule is tested; nothing is fetched. The thresholds are planners' common rules of thumb,
 * named in each `basis`, checked on CHECKED. Educational, not financial advice. */

import { kindOf, type Limits } from "../retirement/limits";
import type { YearLimits } from "../retirement/irs";

type LimitField = Exclude<keyof Limits, "sources">;

export const CHECKED = "2026-10-16";

export interface Month { month: string; income: number; spend: number; saving: number; debt: number; cats: Record<string, number>; n: number }

export interface Recurring {
  name: string | null; merchant: string; cadence: "weekly" | "monthly" | "quarterly" | "yearly"; category: string | null;
  avg_cents: number; last_cents: number; prev_cents: number | null; distinct_amounts: number; last_date: string; corrected: string | null;
}

export interface Holding { name: string | null; type: string | null; cents: number }

export interface AdviceInput {
  today: string;
  months: Month[];                                // oldest first; the current month last (partial)
  recurring: Recurring[];
  checkingCents: number;                          // bank accounts that hold cash (not retirement ones)
  savingsCents: number;
  retirement: {
    accounts: { owner: string; subtype: string | null; in_retirement: boolean; balance: number | null }[];
    contributions: { owner: string; subtype: string | null; year: string; cents: number }[];
    profiles: Record<string, { birth_year?: number; match_pct?: number; hsa_coverage?: string; beneficiaries_checked_on?: string }>;
    mix: { class: string; cents: number }[];
    limits: (Partial<Limits> & Partial<Pick<YearLimits, "year" | "provisional">>) | null;
  };
  holdings: Holding[];                            // every investment account's, for concentration
  hasBrokerage: boolean;
  people: string[];                               // the people this view covers
  labels: Record<string, string>;
  checklist: Record<string, string>;              // item id -> date last checked
}

export type Area = "spending" | "saving" | "debt" | "retirement" | "investing";
export interface Finding {
  id: string; area: Area; level: "act" | "consider" | "good";
  title: string; why: string; action: string;
  yearly_cents: number | null;                    // dollars a year at stake, when there's an honest number
  numbers: [string, string][];                    // what it used, to check it
  basis: string;
}

const money = (c: number) => (c < 0 ? "−" : "") + "$" + Math.round(Math.abs(c) / 100).toLocaleString("en-US");
const pct = (x: number) => `${Math.round(x * 100)}%`;
const EVERY = { weekly: 52, monthly: 12, quarterly: 4, yearly: 1 } as const;
const DAYS = { weekly: 7, monthly: 30.4, quarterly: 91, yearly: 365 } as const;
const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 864e5;

/** The whole months to judge by: from the first with at least 40% of the busiest month's
 * transactions (and 5), to last month. The busiest month, not the median: a long quiet tail (a
 * card's credits a year before the bank's history starts) would drag a median down. The same start
 * as the audit's charts (public/cfa.js). */
export function fullMonths(months: Month[], today: string): Month[] {
  const most = Math.max(0, ...months.map((m) => m.n));
  const start = months.findIndex((m) => most && m.n >= Math.max(5, most * 0.4));
  return start < 0 ? [] : months.slice(start).filter((m) => m.month !== today.slice(0, 7));
}

export function recommend(x: AdviceInput): Finding[] {
  const out: Finding[] = [];
  const full = fullMonths(x.months, x.today);
  const n = full.length;
  const sum = (k: "income" | "spend" | "saving" | "debt") => full.reduce((s, m) => s + m[k], 0);
  const cat = (c: string, ms = full) => ms.reduce((s, m) => s + (m.cats[c] ?? 0), 0);
  const inc = sum("income"), spend = sum("spend"), debt = sum("debt");
  const monthlySpend = n ? spend / n : 0;
  const perYear = (cents: number) => (n ? (cents / n) * 12 : 0);

  // Saving
  if (n >= 3 && inc > 0) {
    const kept = inc - spend - debt, rate = kept / inc;
    if (rate < 0.15) {
      out.push({ id: "savings_rate", area: "saving", level: rate < 0.05 ? "act" : "consider",
        title: `You keep ${pct(rate)} of what comes in`, why: "Planners usually suggest keeping 15–20% (for retirement and goals).",
        action: `Keeping 15% would mean about ${money(Math.max(0, 0.15 * inc - kept) / n)} a month more: start with the categories and subscriptions below.`,
        yearly_cents: Math.round(perYear(Math.max(0, 0.15 * inc - kept))),
        numbers: [["Money in", money(inc)], ["Spending", money(spend)], ["Loan payments", money(debt)], ["Months", String(n)]],
        basis: "Savings rate of 15–20% of income: a common planners' guideline (retirement saving of about 15%)." });
    } else if (rate >= 0.2) {
      out.push({ id: "savings_rate", area: "saving", level: "good", title: `You keep ${pct(rate)} of what comes in`,
        why: "That's at or above the 15–20% planners usually suggest.", action: "Keep it up; make sure what you keep is working (see retirement and cash below).",
        yearly_cents: null, numbers: [["Money in", money(inc)], ["Kept", money(kept)], ["Months", String(n)]], basis: "Savings rate of 15–20% of income." });
    }
  }
  const cash = x.checkingCents + x.savingsCents;
  if (n >= 3 && monthlySpend > 0) {
    const months = cash / monthlySpend;
    if (months < 3) {
      out.push({ id: "emergency_fund", area: "saving", level: "act", title: `Cash covers ${months.toFixed(1)} months of spending`,
        why: "A cushion of 3–6 months of spending keeps a job loss or a big bill off the credit cards.",
        action: `Build it to 3 months: about ${money(3 * monthlySpend - cash)} more, in a savings account.`, yearly_cents: null,
        numbers: [["Cash in checking and savings", money(cash)], ["Spending a month", money(monthlySpend)]],
        basis: "Emergency fund of 3–6 months of expenses (spending is used here, which overstates the essentials)." });
    }
    const excess = x.checkingCents - 2 * monthlySpend;
    if (months >= 3 && excess > 200000) {
      out.push({ id: "idle_cash", area: "saving", level: "consider", title: `${money(excess)} more in checking than 2 months of spending`,
        why: "Checking accounts pay little or nothing; a high-yield savings account or a money market fund pays interest on the same money.",
        action: `Move what's above about 2 months of spending (${money(2 * monthlySpend)}) to savings.`,
        yearly_cents: Math.round(excess * 0.03),
        numbers: [["In checking", money(x.checkingCents)], ["2 months of spending", money(2 * monthlySpend)], ["Assumed rate", "3% a year (check current rates)"]],
        basis: "Keep about 1–2 months of spending in checking; the dollars a year assume 3% interest." });
    }
  }

  // Debt and fees
  const interest = cat("INTEREST"), fees = cat("BANK_FEES");
  if (interest > 0) {
    out.push({ id: "card_interest", area: "debt", level: "act", title: `${money(perYear(interest))} a year in interest`,
      why: "Card interest rates are usually far above what savings or investments earn, so paying it off is the surest return there is.",
      action: "Pay each card's statement balance in full; until then, put every extra dollar on the highest-rate balance first.",
      yearly_cents: Math.round(perYear(interest)), numbers: [["Interest charged", money(interest)], ["Months", String(n)]],
      basis: "Paying off high-interest debt first (the avalanche method)." });
  }
  if (fees > 0) {
    out.push({ id: "fees", area: "spending", level: "consider", title: `${money(perYear(fees))} a year in fees`,
      why: "Annual fees can be worth it for a card whose credits you use (see ABC); late, overdraft, ATM and foreign transaction fees usually aren't.",
      action: "Look at what each fee was for, and turn on autopay or alerts for the avoidable ones.",
      yearly_cents: Math.round(perYear(fees)), numbers: [["Fees", money(fees)], ["Months", String(n)]], basis: "Fees you can avoid are a sure saving." });
  }

  // Spending: rising categories, price rises, subscriptions
  if (n >= 6) {
    const last3 = full.slice(-3);
    for (const c of new Set(full.flatMap((m) => Object.keys(m.cats)))) {
      if (["BANK_FEES", "INTEREST", "CREDITS"].includes(c)) continue;
      const a = cat(c) / n, l = cat(c, last3) / last3.length;
      if (a > 0 && l >= a * 1.2 && l - a >= 5000) {
        out.push({ id: `rising_${c}`, area: "spending", level: "consider", title: `${catName(c)} is up ${pct(l / a - 1)} lately`,
          why: `${money(l)} a month over the last 3 months, against ${money(a)} on average.`,
          action: `Look at its biggest merchants on the dashboard: is it a one-off, or the new normal?`, yearly_cents: Math.round((l - a) * 12),
          numbers: [["Last 3 months, a month", money(l)], [`Average over ${n} months`, money(a)]], basis: "A category 20% and $50 a month above its own average." });
      }
    }
  }
  const live = x.recurring.filter((r) => (r.corrected ?? "spend") === "spend" && days(r.last_date, x.today) <= DAYS[r.cadence] * 1.6);
  for (const r of live) {
    if (r.distinct_amounts <= 3 && r.prev_cents && r.last_cents > r.prev_cents * 1.03) {
      out.push({ id: `price_${r.merchant}`, area: "spending", level: "consider", title: `${r.name || r.merchant} went up ${pct(r.last_cents / r.prev_cents - 1)}`,
        why: `From ${money(r.prev_cents)} to ${money(r.last_cents)} ${r.cadence === "monthly" ? "a month" : r.cadence === "yearly" ? "a year" : `(${r.cadence})`}.`,
        action: "Worth a call or a look at a cheaper plan; many services keep a lower price for those who ask.", yearly_cents: (r.last_cents - r.prev_cents) * EVERY[r.cadence],
        numbers: [["Before", money(r.prev_cents)], ["Now", money(r.last_cents)], ["How often", r.cadence]], basis: "A fixed price that rose by 3% or more." });
    }
  }
  const subs = live.filter((r) => r.category !== "RENT_AND_UTILITIES" && r.category !== "LOAN_PAYMENTS");
  const subsYear = subs.reduce((s, r) => s + (r.distinct_amounts <= 2 ? r.last_cents : r.avg_cents) * EVERY[r.cadence], 0);
  if (subs.length >= 3 && subsYear >= 30000) {
    out.push({ id: "subscriptions", area: "spending", level: "consider", title: `${subs.length} subscriptions and memberships, ${money(subsYear)} a year`,
      why: "They add up quietly, and the ones not used any more are pure saving.", action: "Go through the list in Recurring charges once a year and cancel what you don't use.",
      yearly_cents: null, numbers: subs.slice(0, 8).map((r) => [r.name || r.merchant, money(r.last_cents)]), basis: "A yearly review of recurring charges." });
  }

  // Retirement
  const year = Number(x.today.slice(0, 4)), L = x.retirement.limits;
  const ret = x.retirement.accounts.filter((a) => a.in_retirement);
  for (const p of x.people) {
    const prof = x.retirement.profiles[p] ?? {}, who = x.people.length > 1 ? `${x.labels[p] ?? p}: ` : "";
    const age = prof.birth_year ? year - prof.birth_year : null;
    const mine = ret.filter((a) => a.owner === p);
    if (!mine.length) continue;                    // said once for everyone, below
    if (prof.match_pct && mine.some((a) => kindOf(a.subtype) === "workplace")) {
      out.push({ id: `match_${p}`, area: "retirement", level: "act", title: `${who}collect the whole employer match`,
        why: `Your employer matches up to ${prof.match_pct}% of pay: money not collected is pay left on the table.`,
        action: `Check your contribution is at least ${prof.match_pct}% of pay, and that it stays there all year.`, yearly_cents: null,
        numbers: [["Match", `up to ${prof.match_pct}% of pay`]], basis: "Capture the full employer match before other saving." });
    }
    if (L && (L.year === undefined || L.year === year)) {
      const dayOfYear = days(`${year}-01-01`, x.today) + 1, monthsLeft = Math.max(1, 12 - Number(x.today.slice(5, 7)) + 1);
      for (const kind of ["workplace", "ira", "hsa"] as const) {
        if (!mine.some((a) => kindOf(a.subtype) === kind)) continue;
        const ytd = x.retirement.contributions.filter((c) => c.owner === p && kindOf(c.subtype) === kind && c.year === String(year)).reduce((s, c) => s + c.cents, 0);
        const baseField: LimitField = kind === "workplace" ? "workplace" : kind === "ira" ? "ira" : prof.hsa_coverage === "family" ? "hsaFamily" : "hsaSelf";
        const catchUpField: LimitField | null = age === null ? null : kind === "workplace"
          ? (age >= 60 && age <= 63 ? "workplaceCatchUp60to63" : age >= 50 ? "workplaceCatchUp50" : null)
          : kind === "ira" ? (age >= 50 ? "iraCatchUp50" : null) : age >= 55 ? "hsaCatchUp55" : null;
        const baseLimit = L[baseField], catchUp = catchUpField ? L[catchUpField] : 0;
        // Previous-year fallbacks are useful context in EGG, but cannot be a confirmed target
        // here. Only fields this person's calculation uses need to have been published.
        if (L.provisional?.includes(baseField) || (catchUpField && L.provisional?.includes(catchUpField))
          || typeof baseLimit !== "number" || !Number.isFinite(baseLimit) || baseLimit <= 0
          || typeof catchUp !== "number" || !Number.isFinite(catchUp) || catchUp < 0) continue;
        const limit = baseLimit + catchUp;
        const pace = (limit * dayOfYear) / 365;
        if (ytd < pace * 0.9 && limit - ytd > 0) {
          const name = { workplace: "401(k)", ira: "IRA", hsa: "HSA" }[kind];
          out.push({ id: `pace_${kind}_${p}`, area: "retirement", level: "consider", title: `${who}${name}: ${money(ytd)} of the ${money(limit)} limit this year`,
            why: `Tax-advantaged room unused by the deadline is gone for good${kind === "hsa" ? ", and an HSA is the only account that's tax-free going in and coming out (for medical costs)" : ""}.`,
            action: `About ${money((limit - ytd) / monthsLeft)} a month would reach the ${year} limit${kind === "workplace" ? " by December 31" : " by the April deadline"}, if your budget allows.`,
            yearly_cents: null, numbers: [["So far", money(ytd)], ["Limit", money(limit)], ["Even pace today", money(pace)]],
            basis: `IRS limits for ${year} (src/retirement/limits.ts).` });
        }
      }
    }
  }
  const without = x.people.filter((p) => !ret.some((a) => a.owner === p));
  if (without.length) {
    out.push({ id: "no_retirement", area: "retirement", level: "consider",
      title: x.people.length > 1 ? `No retirement accounts linked for ${without.map((p) => x.labels[p] ?? p).join(", ")}` : "No retirement accounts linked",
      why: "The audit can't see retirement saving it isn't shown, so the savings rate may look lower than it is.",
      action: "Link a 401(k), IRA or HSA from + Add account (Link a retirement account), or add the investment accounts of a bank already linked.",
      yearly_cents: null, numbers: [], basis: "" });
  }
  const mixTotal = x.retirement.mix.reduce((s, m) => s + m.cents, 0);
  const cashShare = mixTotal ? (x.retirement.mix.find((m) => m.class === "cash")?.cents ?? 0) / mixTotal : 0;
  const oldest = Math.max(0, ...x.people.map((p) => (x.retirement.profiles[p]?.birth_year ? year - x.retirement.profiles[p].birth_year! : 0)));
  if (cashShare > 0.1 && oldest < 55) {
    out.push({ id: "cash_drag", area: "retirement", level: "consider", title: `${pct(cashShare)} of the retirement accounts is cash`,
      why: "Over decades, cash grows far more slowly than invested money: a long horizon is what investing is for.",
      action: "Check it's invested the way you intend, for example after a rollover or a contribution that didn't buy anything.",
      yearly_cents: null, numbers: [["Cash", money(cashShare * mixTotal)], ["Retirement accounts", money(mixTotal)]], basis: "Uninvested cash over 10% with a long horizon." });
  }
  const invested = x.holdings.reduce((s, h) => s + h.cents, 0);
  for (const h of x.holdings) {
    const isFund = /FUND|INDEX|ETF|TRUST|PORTFOLIO|TARGET|TOTAL|CASH|MONEY MARKET/i.test(h.name ?? "") || ["mutual fund", "etf", "cash", "fixed income"].includes(h.type ?? "");
    if (!isFund && invested > 0 && h.cents / invested > 0.1) {
      out.push({ id: `concentration_${h.name}`, area: "investing", level: "consider", title: `${h.name ?? "One holding"} is ${pct(h.cents / invested)} of your investments`,
        why: "A single company can fall a long way on its own; spread across many, one bad year matters less.",
        action: "Consider how much you'd want to hold if you were buying it today, and spread the rest (minding taxes outside retirement accounts).",
        yearly_cents: null, numbers: [["Value", money(h.cents)], ["All investments", money(invested)]], basis: "No single stock over 10% of what you invest." });
    }
  }

  const order = { act: 0, consider: 1, good: 2 } as const;
  return out.sort((a, b) => order[a.level] - order[b.level] || (b.yearly_cents ?? -1) - (a.yearly_cents ?? -1));
}

const CAT: Record<string, string> = { FOOD_AND_DRINK: "Food & drink", GENERAL_MERCHANDISE: "Shopping", RENT_AND_UTILITIES: "Rent & utilities", TRANSPORTATION: "Transportation",
  TRAVEL: "Travel", ENTERTAINMENT: "Entertainment", MEDICAL: "Medical", PERSONAL_CARE: "Personal care", GENERAL_SERVICES: "Services", HOME_IMPROVEMENT: "Home" };
const catName = (c: string) => CAT[c] ?? c.toLowerCase().replace(/_and_/g, " & ").replace(/_/g, " ").replace(/^./, (x) => x.toUpperCase());

/** The planner's checklist: what the data can't see. Each item is asked again a year after it was
 * last ticked. `when` keeps an item to the households it fits. */
export interface ChecklistItem { id: string; title: string; why: string; link?: string; when?: (x: AdviceInput) => boolean }
export const CHECKLIST: readonly ChecklistItem[] = [
  { id: "beneficiaries", title: "A beneficiary named on every retirement account and life insurance policy", why: "It decides who inherits them, whatever a will says." },
  { id: "will", title: "A will (and guardians named, with children)", why: "Without one, state law decides who gets what and who raises the children." },
  { id: "life_insurance", title: "Term life insurance if anyone depends on your income", why: "Enough to replace your income for the years they'd need it; term cover is the inexpensive kind." },
  { id: "disability", title: "Disability insurance", why: "Your ability to earn is usually your biggest asset: check what your employer's plan covers." },
  { id: "umbrella", title: "Umbrella liability cover", why: "Inexpensive protection above home and car insurance, once there are savings to protect." },
  { id: "credit_freeze", title: "Credit frozen at Equifax, Experian and TransUnion", why: "Free, and it stops new accounts opened in your name; lift it for a moment when you apply for credit.", link: "https://consumer.ftc.gov/articles/what-know-about-credit-freezes-fraud-alerts" },
  { id: "ssa", title: "Your Social Security earnings record and estimate checked", why: "A missing year of earnings lowers the benefit; it's easier to fix while the records are fresh.", link: "https://www.ssa.gov/myaccount/" },
  { id: "deductibles", title: "Insurance deductibles your emergency fund can cover", why: "A higher deductible lowers premiums, but only if the cash to pay it is there." },
  { id: "tax_loss", title: "Tax-loss harvesting in taxable accounts, before year end", why: "Selling at a loss can offset gains and some income; mind the wash-sale rule.", when: (x) => x.hasBrokerage },
  { id: "roth_mix", title: "Traditional or Roth: the mix talked over with a tax professional", why: "Which is better depends on your tax rate now and later." },
  { id: "rmd", title: "Required minimum distributions planned (from age 73)", why: "Missing one costs a penalty.", when: (x) => x.people.some((p) => (x.retirement.profiles[p]?.birth_year ?? 9999) <= Number(x.today.slice(0, 4)) - 70) },
];

export function checklist(x: AdviceInput) {
  const anyBeneficiaries = Object.values(x.retirement.profiles).map((p) => p.beneficiaries_checked_on).filter(Boolean).sort().at(-1) ?? null;
  return CHECKLIST.filter((i) => !i.when || i.when(x)).map((i) => {
    const checked = [x.checklist[i.id], i.id === "beneficiaries" ? anyBeneficiaries : null].filter(Boolean).sort().at(-1) ?? null;
    return { id: i.id, title: i.title, why: i.why, link: i.link ?? null, checked_on: checked, due: !checked || days(checked, x.today) > 365 };
  });
}
