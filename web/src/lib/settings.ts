import { eq } from "drizzle-orm";
import { db, tables } from "@/db";
import type { CalibrationLevel } from "@/lib/prompts";

export const CALIBRATION_LEVELS: CalibrationLevel[] = ["new", "amateur", "expert"];

export function isCalibrationLevel(v: unknown): v is CalibrationLevel {
  return typeof v === "string" && (CALIBRATION_LEVELS as string[]).includes(v);
}

export async function getUserCalibration(userId: number): Promise<CalibrationLevel> {
  const [user] = await db.select({ calibration: tables.users.calibration }).from(tables.users).where(eq(tables.users.id, userId));
  return isCalibrationLevel(user?.calibration) ? user.calibration : "new";
}

export async function setUserCalibration(userId: number, value: CalibrationLevel): Promise<void> {
  await db.update(tables.users).set({ calibration: value }).where(eq(tables.users.id, userId));
}
