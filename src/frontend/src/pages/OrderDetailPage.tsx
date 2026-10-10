import type { Order } from "@/backend";
import { HoudiniStatus } from "@/backend";
import { DepositAccountCard } from "@/components/DepositAccountCard";
import { OrderResultPanel } from "@/components/OrderResultPanel";
import { SimulatePayoutControl } from "@/components/SimulatePayoutControl";
import { StatusTimeline } from "@/components/StatusTimeline";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useOrder,
  useProcessOrder,
  useSimulateDeposit,
} from "@/hooks/useBackend";
import {
  formatIcp,
  formatNak,
  formatPrincipal,
  formatTimestamp,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Check, Copy, Loader2, Play } from "lucide-react";
import { useEffect, useState } from "react";

function DetailRow({
  label,
  value,
  mono = true,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-2.5 last:border-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </dt>
      <dd
        className={cn(
          "min-w-0 truncate text-right text-sm text-foreground",
          mono && "num",
        )}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-ocid="order_detail.copy_account_button"
      onClick={() => void handleCopy()}
      aria-label={copied ? "Account id copied" : `Copy ${label}`}
    >
      {copied ? (
        <Check className="size-3.5 text-success" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function DetailSkeleton() {
  return (
    <div data-ocid="order_detail.loading_state" className="space-y-4">
      <Skeleton className="h-8 w-48 rounded-md" />
      <Skeleton className="h-40 w-full rounded-lg" />
      <Skeleton className="h-56 w-full rounded-lg" />
    </div>
  );
}

/** Full order view: lifecycle timeline, deposit account, result, and controls. */
export function OrderDetailPage({ id }: { id: string }) {
  const [actionError, setActionError] = useState<string | null>(null);

  const orderId = (() => {
    try {
      return BigInt(id);
    } catch {
      return null;
    }
  })();

  const orderQuery = useOrder(orderId);
  const processMutation = useProcessOrder();
  const simulateMutation = useSimulateDeposit();

  const order: Order | null = orderQuery.data ?? null;

  const { refetch } = orderQuery;
  const processMutate = processMutation.mutate;

  // Poll while the order is in flight so backend timer steps surface promptly.
  useEffect(() => {
    if (!order) return;
    const settled =
      order.houdiniStatus === HoudiniStatus.expired ||
      order.houdiniStatus === HoudiniStatus.failed ||
      order.houdiniStatus === HoudiniStatus.refunded ||
      order.routerStatus.__kind__ === "completed" ||
      order.routerStatus.__kind__ === "refunded" ||
      order.routerStatus.__kind__ === "needsReview";
    if (settled) return;
    const handle = window.setInterval(() => {
      void refetch();
    }, 2500);
    return () => window.clearInterval(handle);
  }, [order, refetch]);

  const routerInFlight =
    order?.routerStatus.__kind__ === "awaitingDeposit" ||
    order?.routerStatus.__kind__ === "swapping" ||
    order?.routerStatus.__kind__ === "payoutPending";

  // Drive the router leg automatically once the Houdini leg has delivered.
  useEffect(() => {
    if (!routerInFlight || orderId === null) return;
    const handle = window.setInterval(() => {
      processMutate(orderId);
    }, 3000);
    return () => window.clearInterval(handle);
  }, [routerInFlight, orderId, processMutate]);

  const depositWindowOpen =
    order !== null &&
    order.houdiniStatus !== HoudiniStatus.completed &&
    order.houdiniStatus !== HoudiniStatus.refunded &&
    order.houdiniStatus !== HoudiniStatus.failed;

  const handleProcess = () => {
    if (orderId === null) return;
    setActionError(null);
    processMutation.mutate(orderId, {
      onError: (error: Error) =>
        setActionError(error.message || "Could not process order."),
    });
  };

  const handleSimulate = () => {
    if (orderId === null) return;
    setActionError(null);
    simulateMutation.mutate(orderId, {
      onError: (error: Error) =>
        setActionError(error.message || "Could not simulate the deposit."),
    });
  };

  return (
    <section
      data-ocid="order_detail.page"
      className="animate-fade-up space-y-6"
    >
      <div>
        <Link
          to="/orders"
          data-ocid="order_detail.back_link"
          className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground transition-smooth hover:text-primary"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          Orders
        </Link>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">
            Order <span className="num text-primary">#{id}</span>
          </h1>
        </div>
      </div>

      {orderQuery.isLoading ? (
        <DetailSkeleton />
      ) : orderQuery.isError ? (
        <div
          data-ocid="order_detail.error_state"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center"
        >
          <p className="text-sm text-destructive">
            Could not load this order. It may not exist, or the backend is
            unreachable.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            data-ocid="order_detail.retry_button"
            onClick={() => void orderQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : !order ? (
        <div
          data-ocid="order_detail.empty_state"
          className="rounded-lg border border-border bg-card p-10 text-center shadow-inset-soft"
        >
          <h2 className="font-display text-lg font-semibold text-foreground">
            Order not found
          </h2>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            No order exists with id{" "}
            <span className="num text-foreground">#{id}</span>.
          </p>
          <Button asChild variant="outline" size="sm" className="mt-4">
            <Link to="/orders" data-ocid="order_detail.back_to_orders_button">
              Back to orders
            </Link>
          </Button>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          {/* Left column: deposit, timeline, result */}
          <div className="space-y-6">
            {depositWindowOpen ? (
              <DepositAccountCard
                depositAddress={order.depositAddress}
                depositAccountId={order.depositAccountId}
                tokenSymbol={order.tokenSymbol}
                tokenChain={order.tokenChain}
                tokenAmount={order.tokenAmount}
                orderId={order.id}
                createdAt={order.createdAt}
              />
            ) : null}

            <div className="rounded-lg border border-border bg-card p-5 shadow-inset-soft">
              <h2 className="mb-4 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Lifecycle
              </h2>
              <StatusTimeline
                houdiniStatus={order.houdiniStatus}
                routerStatus={order.routerStatus}
                recipient={order.recipient.toText()}
                nakOut={order.nakOut}
                block={order.block}
              />
            </div>

            <OrderResultPanel order={order} />

            <div className="rounded-lg border border-border bg-card p-5 shadow-inset-soft">
              <h2 className="mb-3 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Deposit account
              </h2>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p
                  data-ocid="order_detail.deposit_account_id"
                  className="num min-w-0 break-all text-sm text-foreground"
                >
                  {order.depositAccountId}
                </p>
                <CopyButton
                  value={order.depositAccountId}
                  label="deposit account id"
                />
              </div>
            </div>
          </div>

          {/* Right column: facts + controls */}
          <div className="space-y-6">
            <div className="rounded-lg border border-border bg-card p-5 shadow-inset-soft">
              <h2 className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Order facts
              </h2>
              <dl>
                <DetailRow
                  label="Recipient"
                  value={formatPrincipal(order.recipient.toText())}
                />
                <DetailRow
                  label="Token"
                  value={`${order.tokenSymbol} · ${order.tokenChain}`}
                />
                <DetailRow
                  label="Token amount"
                  value={order.tokenAmount.toString()}
                />
                <DetailRow label="Route" value={order.routeType} />
                <DetailRow
                  label="Refund address"
                  value={order.refundAddress ?? "—"}
                />
                <DetailRow
                  label="ICP received"
                  value={
                    order.icpIn !== undefined
                      ? `${formatIcp(order.icpIn)} ICP`
                      : "—"
                  }
                />
                <DetailRow
                  label="NAK out"
                  value={
                    order.nakOut !== undefined
                      ? `${formatNak(order.nakOut)} NAK`
                      : "—"
                  }
                />
                <DetailRow
                  label="Block"
                  value={
                    order.block !== undefined ? order.block.toString() : "—"
                  }
                />
                <DetailRow
                  label="Created"
                  value={formatTimestamp(order.createdAt)}
                />
                <DetailRow
                  label="Updated"
                  value={formatTimestamp(order.updatedAt)}
                />
              </dl>
            </div>

            <div className="rounded-lg border border-border bg-card p-5 shadow-inset-soft">
              <h2 className="mb-3 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Actions
              </h2>
              <Button
                type="button"
                data-ocid="order_detail.process_button"
                onClick={handleProcess}
                disabled={processMutation.isPending}
                className="w-full"
              >
                {processMutation.isPending ? (
                  <Loader2
                    className="size-3.5 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Play className="size-3.5" aria-hidden="true" />
                )}
                {processMutation.isPending ? "Processing…" : "Process now"}
              </Button>

              {actionError ? (
                <p
                  data-ocid="order_detail.action_error_state"
                  className="mt-2 text-xs text-destructive"
                >
                  {actionError}
                </p>
              ) : null}
            </div>

            <SimulatePayoutControl
              depositAccountId={order.depositAccountId}
              onSimulate={handleSimulate}
              isPending={simulateMutation.isPending}
              disabled={order.houdiniStatus !== HoudiniStatus.waiting}
              errorMessage={null}
            />
          </div>
        </div>
      )}
    </section>
  );
}
