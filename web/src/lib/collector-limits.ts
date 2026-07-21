export const collectorLimits = {
  // One noisy collector must not consume the shared D1 allowance.
  deviceDaily: positiveEnv("D1_DAILY_INGEST_PER_DEVICE", 2_000),
  userDaily: positiveEnv("D1_DAILY_INGEST_PER_USER", 4_000),
  globalDaily: positiveEnv("D1_DAILY_INGEST_GLOBAL", 50_000),
  deviceStored: positiveEnv("D1_MAX_STORED_MESSAGES_PER_DEVICE", 5_000),
  globalStored: positiveEnv("D1_MAX_STORED_MESSAGES_GLOBAL", 500_000),
  statusWriteIntervalMs: 2 * 60_000,
};

function positiveEnv(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function wouldExceed(used: number, incoming: number, limit: number) {
  return used + incoming > limit;
}
