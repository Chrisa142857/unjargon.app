import { db, tables } from "@/db";
import { sessionCookie } from "@/lib/auth";

export const dynamic = "force-dynamic";
const readCookie = (req: Request, name: string) => (req.headers.get("cookie") ?? "").split("; ").find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);

export async function GET(req: Request) {
  const url = new URL(req.url), code = url.searchParams.get("code"), state = url.searchParams.get("state");
  const appUrl = process.env.APP_URL, clientId = process.env.GOOGLE_CLIENT_ID, clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!code || !state || state !== readCookie(req, "unjargon_oauth_state") || !appUrl || !clientId || !clientSecret) return Response.redirect(new URL("/live", url));
  const tokens = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: `${appUrl}/api/auth/google/callback`, grant_type: "authorization_code" }) }).then(async (r) => r.ok ? r.json() : null) as { access_token?: string } | null;
  if (!tokens?.access_token) return Response.redirect(new URL("/live", url));
  const profile = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${tokens.access_token}` } }).then(async (r) => r.ok ? r.json() : null) as { sub?: string; email?: string; name?: string } | null;
  if (!profile?.sub || !profile.email) return Response.redirect(new URL("/live", url));
  const [user] = await db.insert(tables.users).values({ googleSub: profile.sub, email: profile.email, name: profile.name ?? null }).onConflictDoUpdate({ target: tables.users.googleSub, set: { email: profile.email, name: profile.name ?? null } }).returning();
  const res = new Response(null, { status: 302, headers: { Location: new URL("/live", url).toString() } });
  res.headers.append("Set-Cookie", sessionCookie(user.id));
  res.headers.append("Set-Cookie", "unjargon_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  return res;
}
