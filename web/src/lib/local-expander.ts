const MAX_STATUS_AGE_MS = 90_000;

// A collector writes this through /api/status every 30 seconds. Keep the
// decision pure so a stale or disabled machine never creates a fake queue.
export function hasLiveLocalExpander(
  statuses: readonly (string | null)[],
  now = Date.now(),
): boolean {
  return statuses.some((raw) => {
    try {
      const status = JSON.parse(raw ?? "") as {
        budgetLimit?: unknown;
        budgetUsed?: unknown;
        pausedUntil?: unknown;
        updatedAt?: unknown;
      };
      const updatedAt = Date.parse(String(status.updatedAt ?? ""));
      const pausedUntil = Date.parse(String(status.pausedUntil ?? ""));
      const limit = Number(status.budgetLimit);
      const used = Number(status.budgetUsed);
      return Number.isFinite(updatedAt) && now - updatedAt <= MAX_STATUS_AGE_MS &&
        Number.isFinite(limit) && limit > 0 && Number.isFinite(used) && used < limit &&
        (!Number.isFinite(pausedUntil) || pausedUntil <= now);
    } catch {
      return false;
    }
  });
}
