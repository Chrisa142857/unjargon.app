export const dynamic = "force-dynamic";

export async function POST() {
  const res = Response.json({ ok: true });
  res.headers.append("Set-Cookie", "unjargon_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  return res;
}
