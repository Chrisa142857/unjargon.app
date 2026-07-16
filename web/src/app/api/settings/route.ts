import {
  getCalibration,
  isCalibrationLevel,
  setCalibration,
} from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ calibration: await getCalibration() });
}

export async function POST(req: Request) {
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
  await setCalibration(body.calibration);
  return Response.json({ calibration: body.calibration });
}
