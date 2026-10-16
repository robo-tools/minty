// Keep these labels as plain text. Callers escape them when rendering HTML.
export function cardEnding(card) {
  const override = typeof card.display_mask === 'string' ? card.display_mask.trim() : '';
  return override || (typeof card.mask === 'string' ? card.mask.trim() : '');
}

export function cardBaseName(card) {
  const nickname = typeof card.nickname === 'string' ? card.nickname.trim() : '';
  if (nickname) return nickname;
  if (/\bchase\b/i.test(card.institution_name || '')) return 'Chase';
  const name = (card.name || '')
    .replace(/[®™℠]|ˢᴹ|ˢᵐ/g, '')
    .replace(/\bSM\b/g, '')
    .replace(/\bAmerican\s+Express\s+Gold\b/gi, 'Amex Gold')
    .replace(/\bCharles\s+Schwab\b/gi, 'Schwab')
    .replace(/\bBusiness\b/gi, 'Biz')
    .replace(/\bPlatinum\b/gi, 'Plat')
    .replace(/\bCard\b/gi, '')
    .replace(/\s+/g, ' ').trim();
  return name || card.institution_name || 'Credit account';
}

export function cardDisplayName(card) {
  const name = cardBaseName(card), ending = cardEnding(card);
  if (!ending) return name;
  // A custom name may already contain the ending, including masked forms.
  const trailingDigits = name.match(/(?:^|\D)(\d+)$/)?.[1];
  return trailingDigits === ending ? name : `${name} ${ending}`;
}

export const cardIssuer = card => (card.institution_name || '').replace(/\s+/g,' ').trim() || 'Other issuer';
const cardOrder = new Intl.Collator(undefined, { numeric:true, sensitivity:'base' });
export function sortCardsByIssuer(cards) {
  return [...cards].sort((a,b) => cardOrder.compare(cardIssuer(a),cardIssuer(b))
    || cardOrder.compare(cardDisplayName(a),cardDisplayName(b))
    || cardOrder.compare(a.owner || '',b.owner || '')
    || (a.id ?? a.transaction_account_id ?? 0) - (b.id ?? b.transaction_account_id ?? 0));
}
