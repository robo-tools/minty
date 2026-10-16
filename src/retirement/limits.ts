/** EGG (docs/cfa.md §3): the IRS contribution limits, per year, as code with their sources (never
 * fetched at runtime). Checked on CHECKED; add the next year's when the IRS publishes them (each
 * autumn), and keep the old ones for the year they apply to. A year missing here shows no limit. */

export const CHECKED = "2026-10-16";

export interface Limits {
  workplace: number;            // 401(k), 403(b), most 457(b), Thrift Savings Plan: employee deferrals
  workplaceCatchUp50: number;   // age 50 and over
  workplaceCatchUp60to63: number; // ages 60 to 63, instead of the 50+ catch-up (if the plan offers it)
  ira: number;                  // traditional and Roth IRAs together
  iraCatchUp50: number;
  simple: number;               // SIMPLE IRA / SIMPLE 401(k)
  simpleCatchUp50: number;
  hsaSelf: number;              // employer contributions count too
  hsaFamily: number;
  hsaCatchUp55: number;
  sources: string[];
}

const $ = (d: number) => d * 100;

export const LIMITS: Record<number, Limits> = {
  2026: {
    workplace: $(24_500), workplaceCatchUp50: $(8_000), workplaceCatchUp60to63: $(11_250),
    ira: $(7_500), iraCatchUp50: $(1_100), simple: $(17_000), simpleCatchUp50: $(4_000),
    hsaSelf: $(4_400), hsaFamily: $(8_750), hsaCatchUp55: $(1_000),
    sources: ["https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500",
              "https://www.irs.gov/pub/irs-drop/n-25-67.pdf", "https://www.irs.gov/pub/irs-drop/rp-25-19.pdf"],
  },
};

/** Which limit an account's contributions count against, from its Plaid subtype. */
export type Kind = "workplace" | "ira" | "simple" | "hsa";
export function kindOf(subtype: string | null): Kind | null {
  const s = (subtype ?? "").toLowerCase();
  if (["401k", "403b", "457b", "roth 401k", "thrift savings plan"].includes(s)) return "workplace";
  if (["ira", "roth"].includes(s)) return "ira";
  if (s === "simple ira") return "simple";
  if (s === "hsa") return "hsa";
  return null;                  // SEP, pension, 401(a) and others: employer-made, or other limits
}
