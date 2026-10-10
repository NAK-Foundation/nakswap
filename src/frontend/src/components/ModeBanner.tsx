import { FlaskConical } from "lucide-react";

/**
 * Persistent, full-width sandbox rail.
 * The app is sandbox-only: no live mode, no mode switch. This rail is the
 * single, always-visible signal that no real funds ever move.
 */
export function ModeBanner() {
  return (
    <div
      data-ocid="mode_banner"
      data-mode="sandbox"
      className="relative w-full border-b border-primary/25 bg-primary/8 text-primary"
    >
      <div className="mx-auto flex h-9 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full bg-primary"
          />
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em]">
            SANDBOX
          </span>
          <span className="hidden truncate text-[11px] uppercase tracking-[0.14em] opacity-70 sm:inline">
            — No real funds
          </span>
        </div>
        <span className="hidden shrink-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] opacity-60 md:inline-flex">
          <FlaskConical className="size-3" aria-hidden="true" />
          Simulated ledger
        </span>
      </div>
    </div>
  );
}
