import type { ReactNode } from "react";

import { Header } from "@/components/Header";
import { LegalDisclaimer } from "@/components/LegalDisclaimer";
import { ModeBanner } from "@/components/ModeBanner";

/** Shared app shell: sandbox rail, header, content area, attribution footer. */
export function Layout({ children }: { children: ReactNode }) {
  const year = new Date().getFullYear();
  const hostname =
    typeof window !== "undefined" ? window.location.hostname : "";

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <ModeBanner />
      <Header />
      <main className="flex-1 bg-background">
        <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
          {children}
        </div>
      </main>
      <footer className="border-t border-border bg-card">
        <LegalDisclaimer />
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-4 py-5 text-xs text-muted-foreground sm:flex-row sm:px-6">
          <span className="font-mono uppercase tracking-[0.14em]">
            NAKSwap Test Lab — no real funds
          </span>
          <a
            href={`https://caffeine.ai?utm_source=caffeine-footer&utm_medium=referral&utm_content=${encodeURIComponent(hostname)}`}
            target="_blank"
            rel="noreferrer"
            data-ocid="footer.attribution_link"
            className="transition-smooth hover:text-foreground"
          >
            © {year}. Built with love using caffeine.ai
          </a>
        </div>
      </footer>
    </div>
  );
}
