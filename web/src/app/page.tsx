"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Client-side redirect so it also works in the static GitHub Pages export.
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/live");
  }, [router]);
  return (
    <main className="flex h-dvh items-center justify-center bg-neutral-950 text-neutral-400">
      <Link href="/live">→ /live</Link>
    </main>
  );
}
