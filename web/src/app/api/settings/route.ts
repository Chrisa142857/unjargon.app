import {
  getUserCalibration,
  isCalibrationLevel,
  setUserCalibration,
} from "@/lib/settings";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  return Response.json({ calibration: await getUserCalibration(user.id) });
}

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  let body: { calibration?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!isCalibrationLevel(body.calibration)) {
    return Response.json(
      { error: "calibration must be new | amateur | expert" },
      { status: 400 },
    );
  }
  await setUserCalibration(user.id, body.calibration);
  return Response.json({ calibration: body.calibration });
}
