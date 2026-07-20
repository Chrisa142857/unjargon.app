"use client";

import { useEffect, useRef, useState } from "react";

export function AiCallConfirmButton({
  action,
  term,
  onConfirm,
  className,
}: {
  action: "concept" | "grounding";
  term: string;
  onConfirm: () => Promise<void>;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const inContext = action === "grounding";

  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !confirming) setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirming, open]);

  async function confirm() {
    setConfirming(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setConfirming(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={className}
        title="opens a confirmation before any AI call"
      >
        {inContext ? "explain in my sessions" : "explain what this means"} · 1 AI call
      </button>
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label="Confirm AI call"
            className="w-full max-w-md rounded-xl border border-amber-200/25 bg-neutral-900 p-5 shadow-2xl"
          >
            <p className="text-base font-medium text-amber-100">Use 1 AI call for {term}?</p>
            <p className="mt-3 text-sm leading-6 text-neutral-300">
              This is never automatic. If this deployment uses your paired collector,
              it can count against the Claude Code or Codex account signed in there.
            </p>
            <p className="mt-2 text-sm leading-6 text-neutral-400">
              {inContext
                ? "A short excerpt from your selected agent message is included for an in-context explanation."
                : "Only the detected term and its detector note are used for this generic explanation."}
            </p>
            <p className="mt-2 text-xs leading-5 text-neutral-500">
              Local explanations are capped at 30 requests (at most 15 minutes) per rolling 5 hours.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={confirming}
                className="rounded-md border border-neutral-700 px-3 py-2 text-sm text-neutral-300 hover:text-white disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                ref={confirmRef}
                type="button"
                onClick={confirm}
                disabled={confirming}
                className="rounded-md bg-amber-200 px-3 py-2 text-sm font-medium text-neutral-950 hover:bg-amber-100 disabled:opacity-50"
              >
                {confirming ? "Starting…" : "Confirm & use 1 AI call"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
