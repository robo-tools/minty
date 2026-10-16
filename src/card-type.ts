/** Plaid's `credit card` subtype also covers charge cards. These known Amex
 * product names provide a conservative display hint, not a reported account type.
 * Never infer a charge card from a missing/zero limit or a user's nickname. */
const AMEX_INSTITUTIONS = new Set([
  "american express", "amex", "american express us", "american express bank", "american express national bank",
]);
const AMEX_CHARGE_PRODUCTS = new Set([
  "gold", "gold card", "platinum", "platinum card", "green", "green card", "centurion", "centurion card",
  "business gold", "business gold card", "business platinum", "business platinum card",
  "business green", "business green card", "business green rewards", "business green rewards card",
  "business centurion", "business centurion card",
  "charles schwab platinum", "charles schwab platinum card", "platinum for charles schwab", "platinum card for charles schwab",
  "morgan stanley platinum", "morgan stanley platinum card", "platinum for morgan stanley", "platinum card for morgan stanley",
]);

function normalized(value: string | null | undefined): string {
  return (value || "").replace(/[®™℠]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function isChargeCard(card: { institution_name?: string | null; name?: string | null }): boolean {
  if (!AMEX_INSTITUTIONS.has(normalized(card.institution_name))) return false;
  const product = normalized(card.name)
    .replace(/^the /, "")
    .replace(/^(?:american express|amex) /, "")
    .replace(/^the /, "")
    .replace(/ from (?:american express|amex)$/, "");
  return AMEX_CHARGE_PRODUCTS.has(product);
}
