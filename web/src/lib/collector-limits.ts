export const collectorLimits = {
  // One noisy collector must not consume the shared D1 allowance.
  deviceDaily: positiveEnv("D1_DAILY_INGEST_PER_DEVICE", 2_000),
  userDaily: positiveEnv("D1_DAILY_INGEST_PER_USER", 4_000),
  // `messages` carries four indexes, and D1 bills an index entry as a row
  // written, so each stored message costs five of the free plan's 100,000
  // daily writes. The old 50,000 default authorised 250,000 — two and a half
  // times what the plan allows — before detection had written anything.
  globalDaily: positiveEnv("D1_DAILY_INGEST_GLOBAL", 15_000),
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
