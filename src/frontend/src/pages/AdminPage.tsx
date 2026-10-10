import { ConfigForm } from "@/components/ConfigForm";
import { SandboxBalancesPanel } from "@/components/SandboxBalancesPanel";
import { TestTogglesPanel } from "@/components/TestTogglesPanel";
import { TokenPricePanel } from "@/components/TokenPricePanel";

/**
 * Open Test Controls console.
 * No sign-in, no roles: every visitor can tune prices, thresholds, fault
 * toggles, and inspect the simulated ledger.
 */
export function AdminPage() {
  return (
    <section data-ocid="admin.page" className="animate-fade-up space-y-6">
      <header className="space-y-2">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-primary">
          Open to everyone
        </p>
        <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">
          Test Controls
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Tune token prices and swap thresholds, inject sandbox faults, and
          inspect the simulated ledger. Nothing here touches real funds.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <ConfigForm />
        <TestTogglesPanel />
      </div>

      <TokenPricePanel />

      <SandboxBalancesPanel />
    </section>
  );
}
