"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function Home() {
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => { fetch(api("/api/auth/me")).then((r) => setSignedIn(r.ok)).catch(() => {}); }, []);
  return (
    <main className="flex min-h-dvh items-center justify-center bg-neutral-950 px-6 text-center text-neutral-300">
      <div>
        <p className="text-3xl font-semibold tracking-tight text-white">unjargon</p>
        <p className="mt-3 max-w-md text-sm text-neutral-400">Plain-language subtitles for the AI agents working on your machine.</p>
        <Link href={signedIn ? "/live" : "/api/auth/google"} className="mt-7 inline-block rounded-md bg-white px-4 py-2 font-medium text-neutral-950">{signedIn ? "Open your stream" : "Continue with Google"}</Link>
      </div>
    </main>
  );
}
