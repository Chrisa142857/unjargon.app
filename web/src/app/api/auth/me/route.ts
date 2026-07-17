import { currentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await currentUser(req);
  if (!user) return Response.json({ user: null }, { status: 401 });
  return Response.json({ user: { email: user.email, name: user.name } });
}
