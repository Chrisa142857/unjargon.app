import { randomBytes } from "node:crypto";

export const dynamic = "force-dynamic";

export async function GET() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const appUrl = process.env.APP_URL;
  if (!clientId || !appUrl) return Response.json({ error: "Google sign-in is not configured" }, { status: 503 });
  const state = randomBytes(24).toString("base64url");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: `${appUrl}/api/auth/google/callback`, response_type: "code", scope: "openid email profile", state, prompt: "select_account" }).toString();
  const res = new Response(null, { status: 302, headers: { Location: url.toString() } });
  res.headers.append("Set-Cookie", `unjargon_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  return res;
}
