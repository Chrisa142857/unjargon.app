"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function AccountMenu() {
  const [user, setUser] = useState<{ email: string; name: string | null } | null>(null);
  useEffect(() => { fetch(api("/api/auth/me")).then((r) => r.ok ? r.json() : null).then((d) => setUser(d?.user ?? null)).catch(() => {}); }, []);
  if (!user) return <a href={api("/api/auth/google")} className="ml-auto text-neutral-300 hover:text-white">Sign in</a>;
  async function logout() {
    await fetch(api("/api/auth/logout"), { method: "POST" });
    window.location.assign(api("/"));
  }
  return <div className="ml-auto flex items-center gap-3"><span className="hidden text-xs text-neutral-400 sm:inline">{user.name ?? user.email}</span><button onClick={logout} className="text-xs text-neutral-400 hover:text-white">Sign out</button></div>;
}
