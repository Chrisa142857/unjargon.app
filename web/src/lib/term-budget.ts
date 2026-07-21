export const MAX_JARGON_ITEMS = 100;
export const HISTORY_JARGON_ITEMS = 75;
export const LIVE_JARGON_ITEMS = MAX_JARGON_ITEMS - HISTORY_JARGON_ITEMS;

export type TermBudget = { history: Set<string>; live: Set<string> };

export function retainTerm(budget: TermBudget, key: string, historical: boolean) {
  if (budget.history.has(key) || budget.live.has(key)) return true;
  const bucket = historical ? budget.history : budget.live;
  if (bucket.size >= (historical ? HISTORY_JARGON_ITEMS : LIVE_JARGON_ITEMS)) return false;
  bucket.add(key);
  return true;
}
