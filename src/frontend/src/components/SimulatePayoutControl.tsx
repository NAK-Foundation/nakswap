import { Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatAccountId } from "@/lib/format";

interface SimulatePayoutControlProps {
  depositAccountId: string;
  onSimulate: () => void;
  isPending: boolean;
  disabled: boolean;
  errorMessage: string | null;
}

/**
 * Sandbox control that walks the Houdini leg forward as if the user had sent
 * the source token. Also shows the router-derived ICP deposit account.
 */
export function SimulatePayoutControl({
  depositAccountId,
  onSimulate,
  isPending,
  disabled,
  errorMessage,
}: SimulatePayoutControlProps) {
  return (
    <section
      data-ocid="simulate_payout.panel"
      className="rounded-lg border border-border bg-card p-4 shadow-inset-soft"
    >
      <header className="mb-2 flex items-center gap-2">
        <Send className="size-3.5 text-primary" aria-hidden="true" />
        <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
          Simulate deposit
        </h2>
      </header>
      <p className="mb-3 text-xs text-muted-foreground">
        Click once you have "sent" the source token. The Houdini leg walks
        WAITING → CONFIRMING → EXCHANGING → COMPLETED, then credits ICP to the
        router deposit account.
      </p>

      <Button
        type="button"
        data-ocid="simulate_payout.submit_button"
        onClick={onSimulate}
        disabled={isPending || disabled}
        className="w-full"
      >
        {isPending ? "Simulating…" : "I've sent it (simulate deposit)"}
      </Button>

      {errorMessage ? (
        <p
          data-ocid="simulate_payout.error_state"
          className="mt-2 text-xs text-destructive"
        >
          {errorMessage}
        </p>
      ) : null}

      <div className="mt-3 rounded-md border border-border bg-background/60 px-3 py-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          Router deposit account
        </p>
        <p
          data-ocid="simulate_payout.deposit_account_id"
          className="addr mt-1 break-all text-sm text-foreground"
        >
          {formatAccountId(depositAccountId, 32, 32)}
        </p>
      </div>
    </section>
  );
}
