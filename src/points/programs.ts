/** BAM's programs (docs/bam.md): the miles and points currencies Minty knows by name. Code, never
 * fetched at runtime. A program not listed here can still be typed in by its name. Names as each
 * program writes them on its own site, on CHECKED. The patterns that read a balance from a
 * statement are in public/points-parse.js.
 *
 *  - `expiry`: when unused points expire, from the program's own terms (`site`), on CHECKED. Only
 *    rules without fine print that changes the answer for most members; a program without one
 *    shows nothing rather than a guess.
 *  - `earnedBy`: which linked cards likely earn it: the bank (LIKE on institution_name) and the
 *    card's Plaid name (LIKE, any of `names`, none of `except`). A best guess from the name, and
 *    the page says "likely". */

export const CHECKED = "2026-10-16";

export type Kind = "bank" | "airline" | "hotel";

export type Expiry =
  | { kind: "never" }                            // doesn't expire
  | { kind: "while_open" }                       // doesn't expire while a card that earns it is open
  | { kind: "inactivity"; months: number };      // expires after this long without earning or redeeming

export interface EarnRule { bank: string; names?: string[]; except?: string[] }

export interface Program {
  id: string;
  name: string;
  kind: Kind;
  unit: string;                                  // what a balance counts: points, miles, Avios
  site: string;                                  // where the program names itself, and its terms
  expiry?: Expiry;
  earnedBy?: EarnRule[];
}

const NEVER: Expiry = { kind: "never" }, WHILE_OPEN: Expiry = { kind: "while_open" };
const inactive = (months: number): Expiry => ({ kind: "inactivity", months });
const AMEX = "American Express%", CHASE = "%Chase%", CITI = "Citi%", BARCLAYS = "Barclays%";

export const PROGRAMS: readonly Program[] = [
  { id: "amex_mr", name: "Amex Membership Rewards", kind: "bank", unit: "points", site: "americanexpress.com", expiry: WHILE_OPEN,
    earnedBy: [{ bank: AMEX, except: ["%Delta%", "%Hilton%", "%Marriott%", "%Bonvoy%", "%Blue Cash%", "%Cash Magnet%"] }] },
  { id: "chase_ur", name: "Chase Ultimate Rewards", kind: "bank", unit: "points", site: "chase.com", expiry: WHILE_OPEN,
    earnedBy: [{ bank: CHASE, names: ["%Sapphire%", "%Freedom%", "%Ink %", "%Ink"] }] },
  { id: "citi_typ", name: "Citi ThankYou Points", kind: "bank", unit: "points", site: "citi.com",
    earnedBy: [{ bank: CITI, names: ["%Strata%", "%Premier%", "%Rewards+%", "%Double Cash%", "%Custom Cash%"] }] },
  { id: "capital_one", name: "Capital One Miles", kind: "bank", unit: "miles", site: "capitalone.com", expiry: WHILE_OPEN,
    earnedBy: [{ bank: "Capital One%", names: ["%Venture%", "%Spark Miles%"] }] },
  { id: "bilt", name: "Bilt Rewards", kind: "bank", unit: "points", site: "biltrewards.com",
    earnedBy: [{ bank: "%", names: ["%Bilt%"] }] },
  { id: "united", name: "United MileagePlus", kind: "airline", unit: "miles", site: "united.com", expiry: NEVER,
    earnedBy: [{ bank: CHASE, names: ["%United%"] }] },
  { id: "delta", name: "Delta SkyMiles", kind: "airline", unit: "miles", site: "delta.com", expiry: NEVER,
    earnedBy: [{ bank: AMEX, names: ["%Delta%"] }] },
  { id: "american", name: "American AAdvantage", kind: "airline", unit: "miles", site: "aa.com", expiry: inactive(24),
    earnedBy: [{ bank: CITI, names: ["%AAdvantage%"] }, { bank: BARCLAYS, names: ["%AAdvantage%"] }] },
  { id: "southwest", name: "Southwest Rapid Rewards", kind: "airline", unit: "points", site: "southwest.com", expiry: NEVER,
    earnedBy: [{ bank: CHASE, names: ["%Southwest%"] }] },
  { id: "jetblue", name: "JetBlue TrueBlue", kind: "airline", unit: "points", site: "jetblue.com", expiry: NEVER,
    earnedBy: [{ bank: BARCLAYS, names: ["%JetBlue%"] }] },
  { id: "aeroplan", name: "Air Canada Aeroplan", kind: "airline", unit: "points", site: "aircanada.com",
    earnedBy: [{ bank: CHASE, names: ["%Aeroplan%"] }] },
  { id: "ba_avios", name: "British Airways Avios", kind: "airline", unit: "Avios", site: "britishairways.com", expiry: inactive(36),
    earnedBy: [{ bank: CHASE, names: ["%British Airways%"] }] },
  { id: "marriott", name: "Marriott Bonvoy", kind: "hotel", unit: "points", site: "marriott.com", expiry: inactive(24),
    earnedBy: [{ bank: AMEX, names: ["%Marriott%", "%Bonvoy%"] }, { bank: CHASE, names: ["%Marriott%", "%Bonvoy%"] }] },
  { id: "hilton", name: "Hilton Honors", kind: "hotel", unit: "points", site: "hilton.com", expiry: inactive(24),
    earnedBy: [{ bank: AMEX, names: ["%Hilton%"] }] },
  { id: "hyatt", name: "World of Hyatt", kind: "hotel", unit: "points", site: "hyatt.com", expiry: inactive(24),
    earnedBy: [{ bank: CHASE, names: ["%Hyatt%"] }] },
  { id: "ihg", name: "IHG One Rewards", kind: "hotel", unit: "points", site: "ihg.com",
    earnedBy: [{ bank: CHASE, names: ["%IHG%"] }] },
];

export const PROGRAM_BY_ID: ReadonlyMap<string, Program> = new Map(PROGRAMS.map((p) => [p.id, p]));
