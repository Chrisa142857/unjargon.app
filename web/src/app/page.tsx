"use client";

import Link from "next/link";

export default function Home() {
  return (
    <main className="flex h-dvh items-center justify-center bg-neutral-950 text-neutral-400">
      <Link href="/api/auth/google" className="rounded-md bg-white px-4 py-2 font-medium text-neutral-950">Continue with Google</Link>
    </main>
  );
}
