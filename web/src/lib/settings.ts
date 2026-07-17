import { eq } from "drizzle-orm";
import { db, tables } from "@/db";
import type { CalibrationLevel } from "@/lib/prompts";

// Calibration is read on every translation/expansion call, so cache briefly.
const TTL_MS = 5000;

const globalForSettings = globalThis as unknown as {
  __unjargonCalibration?: { value: CalibrationLevel; at: number };
};

export const CALIBRATION_LEVELS: CalibrationLevel[] = ["new", "amateur", "expert"];

export function isCalibrationLevel(v: unknown): v is CalibrationLevel {
  return typeof v === "string" && (CALIBRATION_LEVELS as string[]).includes(v);
}

export async function getCalibration(): Promise<CalibrationLevel> {
  const cached = globalForSettings.__unjargonCalibration;
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  const [row] = await db
    .select()
    .from(tables.settings)
    .where(eq(tables.settings.key, "calibration"));
  const value = isCalibrationLevel(row?.value) ? row.value : "new";
  globalForSettings.__unjargonCalibration = { value, at: Date.now() };
  return value;
}

export async function getUserCalibration(userId: number): Promise<CalibrationLevel> {
  const [user] = await db.select({ calibration: tables.users.calibration }).from(tables.users).where(eq(tables.users.id, userId));
  return isCalibrationLevel(user?.calibration) ? user.calibration : "new";
}

export async function setUserCalibration(userId: number, value: CalibrationLevel): Promise<void> {
  await db.update(tables.users).set({ calibration: value }).where(eq(tables.users.id, userId));
}

export async function setCalibration(value: CalibrationLevel): Promise<void> {
  await db
    .insert(tables.settings)
    .values({ key: "calibration", value })
    .onConflictDoUpdate({ target: tables.settings.key, set: { value } });
  globalForSettings.__unjargonCalibration = { value, at: Date.now() };
}
