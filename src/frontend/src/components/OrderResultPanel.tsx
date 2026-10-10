import type { Order, RefundReason } from "@/backend";
import { NAK_SYMBOL } from "@/lib/constants";
import { formatIcp, formatNak, formatRaw } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Human-readable label for a refund reason union value. */
export function refundReasonLabel(reason: RefundReason): string {
  switch (reason.__kind__) {
    case "tooSmall":
      return "Deposit below minimum order size";
    case "tooLarge":
      return "Deposit above maximum order size";
    case "priceImpact":
      return `Price impact exceeded limit (${formatBpsLabel(reason.priceImpact.bps)})`;
    case "swapFailed":
      return `Swap failed: ${reason.swapFailed}`;
    case "admin":
      return "Refunded by operator";
    default:
      return "Refunded";
  }
}

function formatBpsLabel(bps: bigint): string {
  const whole = bps / 100n;
  const frac = (bps % 100n).toString().padStart(2, "0");
  return `${whole}.${frac}%`;
}

function ResultRow({
  label,
  value,
  mono = true,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-2 last:border-0">
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "min-w-0 truncate text-right text-sm text-foreground",
          mono && "num",
        )}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Settled-outcome panel for an order.
 * Shows NAK sent (amount + block) for completed orders, or ICP refunded
 * (amount + reason + block) for refunded orders. Renders nothing while the
 * order is still in flight.
 */
export function OrderResultPanel({ order }: { order: Order }) {
  const status = order.routerStatus;

  if (status.__kind__ === "completed") {
    return (
      <section
        data-ocid="order_result.panel"
        data-outcome="completed"
        className="rounded-lg border border-success/30 bg-success/5 p-4 shadow-inset-soft"
      >
        <header className="mb-2 flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-1.5 rounded-full bg-success"
          />
          <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-success">
            {NAK_SYMBOL} sent
          </h2>
        </header>
        <ResultRow
          label={`${NAK_SYMBOL} delivered`}
          value={
            order.nakOut !== undefined
              ? `${formatNak(order.nakOut)} ${NAK_SYMBOL}`
              : "—"
          }
        />
        <ResultRow
          label="ICP received"
          value={
            order.icpIn !== undefined ? `${formatIcp(order.icpIn)} ICP` : "—"
          }
        />
        <ResultRow label="Block" value={formatRaw(order.block)} />
      </section>
    );
  }

  if (status.__kind__ === "refunded") {
    return (
      <section
        data-ocid="order_result.panel"
        data-outcome="refunded"
        className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 shadow-inset-soft"
      >
        <header className="mb-2 flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-1.5 rounded-full bg-destructive"
          />
          <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-destructive">
            ICP refunded
          </h2>
        </header>
        <ResultRow
          label="ICP returned"
          value={
            order.icpIn !== undefined ? `${formatIcp(order.icpIn)} ICP` : "—"
          }
        />
        <ResultRow
          label="Reason"
          value={
            order.refundReason !== undefined
              ? refundReasonLabel(order.refundReason)
              : "Refunded"
          }
          mono={false}
        />
        <ResultRow label="Block" value={formatRaw(order.block)} />
      </section>
    );
  }

  return null;
}
