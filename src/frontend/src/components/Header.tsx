import { Link } from "@tanstack/react-router";

import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { to: "/", label: "Swap" },
  { to: "/orders", label: "Orders" },
  { to: "/admin", label: "Test Controls" },
] as const;

/** App header: brand and primary nav. No sign-in, no wallet, no roles. */
export function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link
          to="/"
          data-ocid="nav.brand_link"
          className="group flex items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span className="grid size-7 place-items-center rounded-md border border-primary/30 bg-primary/10 font-mono text-[11px] font-bold text-primary">
            NAK
          </span>
          <span className="font-display text-sm font-semibold tracking-tight text-foreground">
            NAKSwap <span className="text-muted-foreground">Test Lab</span>
          </span>
        </Link>

        <nav aria-label="Primary" className="flex items-center gap-1">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              data-ocid={`nav.${item.label.toLowerCase().replace(/\s+/g, "_")}_link`}
              activeOptions={{ exact: item.to === "/" }}
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-smooth hover:bg-accent/10 hover:text-foreground"
              activeProps={{
                className: cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium text-primary",
                  "bg-primary/10",
                ),
              }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
