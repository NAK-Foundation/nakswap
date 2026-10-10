import { AlertTriangle, ArrowRight, CheckCircle2, Info } from "lucide-react";

import type { Config, Quote } from "@/backend";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ROUTER_ICP_FEES, ROUTER_NAK_FEES } from "@/lib/constants";
import { formatBps, formatIcp, formatNak } from "@/lib/format";
import { cn } from "@/lib/utils";

interface QuotePreviewProps {
  quote: Quote | null;
  config: Config | null;
  isLoading: boolean;
  isError: boolean;
  /** True when the amount field is empty or not yet a valid number. */
  isIdle: boolean;
}

/** A single labelled metric row inside the quote panel. */
function Metric({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <span className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "num text-right text-sm",
          emphasis
            ? "text-base font-semibold text-foreground"
            : "text-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Live two-leg quote preview for a prospective order.
 * Leg 1 (Houdini) reads cool cyan; Leg 2 (NAKSwap router) reads amber-gold.
 */
export function QuotePreview({
  quote,
  config,
  isLoading,
  isError,
  isIdle,
}: QuotePreviewProps) {
  return (
    <section
      data-ocid="swap.quote_panel"
      aria-label="Quote preview"
      className="flex flex-col rounded-lg border border-border bg-card"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="font-display text-sm font-semibold tracking-tight text-foreground">
            Quote preview
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Indicative — final terms settle at execution.
          </p>
        </div>
        {quote ? (
          <Badge
            variant="outline"
            className="font-mono text-[10px] uppercase tracking-[0.14em]"
          >
            {quote.houdini.routeType}
          </Badge>
        ) : null}
      </header>

      <div className="flex-1 px-5 py-4">
        {isIdle ? (
          <div
            data-ocid="swap.quote_empty_state"
            className="flex h-full min-h-[13rem] flex-col items-center justify-center gap-2 text-center"
          >
            <Info className="size-5 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">
              Enter a token amount to see the estimated NAK out and price
              impact.
            </p>
          </div>
        ) : isLoading ? (
          <div
            data-ocid="swap.quote_loading_state"
            className="space-y-3 py-1"
            aria-busy="true"
          >
            {Array.from({ length: 4 }, (_, i) => `quote-skeleton-${i}`).map(
              (id) => (
                <div
                  key={id}
                  className="flex items-center justify-between gap-4"
                >
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-4 w-28" />
                </div>
              ),
            )}
          </div>
        ) : isError || !quote ? (
          <div
            data-ocid="swap.quote_error_state"
            className="flex h-full min-h-[13rem] flex-col items-center justify-center gap-2 text-center"
          >
            <AlertTriangle
              className="size-5 text-destructive"
              aria-hidden="true"
            />
            <p className="text-sm text-muted-foreground">
              Could not load a quote. Check the amount and try again.
            </p>
          </div>
        ) : (
          <div data-ocid="swap.quote_result" className="space-y-4">
            <div className="pl-4 leg-houdini">
              <p className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[oklch(var(--leg-houdini))]">
                Leg 1 · Houdini
              </p>
              <div className="divide-y divide-border">
                <Metric
                  label="You send"
                  value={`${formatNak(quote.houdini.tokenAmount)} ${quote.houdini.tokenSymbol}`}
                />
                <Metric
                  label="ICP out"
                  value={`${formatIcp(quote.houdini.icpOut)} ICP`}
                />
                <Metric
                  label="Houdini fee"
                  value={formatBps(quote.houdini.feeBps)}
                />
                <Metric
                  label="ETA"
                  value={`${quote.houdini.etaSeconds.toString()}s`}
                />
              </div>
            </div>

            <div className="pl-4 leg-nakswap">
              <p className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">
                Leg 2 · NAKSwap router
              </p>
              <div className="divide-y divide-border">
                <Metric
                  label="ICP in"
                  value={`${formatIcp(quote.router.icpIn)} ICP`}
                />
                <Metric
                  label="3 ICP fees in"
                  value={`${formatIcp(ROUTER_ICP_FEES)} ICP`}
                />
                <Metric
                  label="ICP after fees"
                  value={`${formatIcp(quote.router.icpAfterFees)} ICP`}
                />
                <Metric
                  label="Estimated NAK out"
                  value={`${formatNak(quote.router.nakOut)} NAK`}
                  emphasis
                />
                <Metric
                  label="2 NAK fees out"
                  value={`${formatNak(ROUTER_NAK_FEES)} NAK`}
                />
                <Metric
                  label="Min received (1%)"
                  value={`${formatNak(quote.router.minNakOut)} NAK`}
                />
                <Metric
                  label="Price impact"
                  value={formatBps(quote.router.priceImpactBps)}
                />
              </div>
            </div>

            <div
              data-ocid="swap.quote_verdict"
              className={cn(
                "flex items-start gap-2.5 rounded-md border px-3.5 py-3 text-sm",
                quote.router.wouldRefund
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : "border-[oklch(var(--success)/0.4)] bg-[oklch(var(--success)/0.1)] text-[oklch(var(--success))]",
              )}
            >
              {quote.router.wouldRefund ? (
                <AlertTriangle
                  className="mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
              ) : (
                <CheckCircle2
                  className="mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
              )}
              <div className="min-w-0">
                <p className="font-medium">
                  {quote.router.wouldRefund
                    ? "This order would be refunded"
                    : "This order would proceed"}
                </p>
                <p className="mt-0.5 text-xs opacity-90">
                  {quote.router.verdict}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {config ? (
        <footer
          data-ocid="swap.quote_config"
          className="border-t border-border px-5 py-3.5"
        >
          <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            Active limits
          </p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">Slippage</dt>
              <dd className="num text-foreground">
                {formatBps(config.slippageBps)}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">Impact cap</dt>
              <dd className="num text-foreground">
                {formatBps(config.maxImpactBps)}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">Min order</dt>
              <dd className="num text-foreground">
                {formatIcp(config.minOrderIcp)} ICP
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">Max order</dt>
              <dd className="num text-foreground">
                {formatIcp(config.maxOrderIcp)} ICP
              </dd>
            </div>
          </dl>
          <p className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <ArrowRight className="size-3" aria-hidden="true" />
            Orders outside these limits are refunded automatically.
          </p>
        </footer>
      ) : null}
    </section>
  );
}
