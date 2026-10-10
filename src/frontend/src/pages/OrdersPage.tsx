import type { HoudiniStatus, OrderSummary, RouterStatus } from "@/backend";
import { HoudiniStatus as HoudiniStatusEnum } from "@/backend";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useOrders } from "@/hooks/useBackend";
import { formatPrincipal, formatTimestamp } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Inbox, RefreshCw } from "lucide-react";
import { useState } from "react";

type FilterValue = "all" | RouterStatus["__kind__"];

const FILTERS: { value: FilterValue; label: string }[] = [
  { value: "all", label: "All" },
  { value: "awaitingDeposit", label: "Awaiting deposit" },
  { value: "swapping", label: "Swapping" },
  { value: "payoutPending", label: "Payout pending" },
  { value: "completed", label: "Completed" },
  { value: "refunded", label: "Refunded" },
  { value: "needsReview", label: "Needs review" },
];

/** Build the backend status filter union for a given kind. */
function statusFilter(kind: RouterStatus["__kind__"]): RouterStatus {
  switch (kind) {
    case "awaitingDeposit":
      return { __kind__: "awaitingDeposit", awaitingDeposit: null };
    case "swapping":
      return { __kind__: "swapping", swapping: null };
    case "payoutPending":
      return { __kind__: "payoutPending", payoutPending: null };
    case "completed":
      return { __kind__: "completed", completed: null };
    case "refunded":
      return { __kind__: "refunded", refunded: null };
    case "needsReview":
      return { __kind__: "needsReview", needsReview: "" };
  }
}

const HOUDINI_LABELS: Record<HoudiniStatus, string> = {
  [HoudiniStatusEnum.waiting]: "Waiting",
  [HoudiniStatusEnum.confirming]: "Confirming",
  [HoudiniStatusEnum.exchanging]: "Exchanging",
  [HoudiniStatusEnum.anonymizing]: "Anonymizing",
  [HoudiniStatusEnum.completed]: "ICP delivered",
  [HoudiniStatusEnum.expired]: "Expired",
  [HoudiniStatusEnum.failed]: "Failed",
  [HoudiniStatusEnum.refunded]: "Refunded",
};

const ROUTER_LABELS: Record<RouterStatus["__kind__"], string> = {
  awaitingDeposit: "Awaiting ICP",
  swapping: "Swapping",
  payoutPending: "Payout pending",
  completed: "Completed",
  refunded: "ICP refunded",
  needsReview: "Needs review",
};

function StatusBadge({ status }: { status: RouterStatus }) {
  const kind = status.__kind__;
  const tone =
    kind === "completed"
      ? "border-success/40 bg-success/10 text-success"
      : kind === "refunded" || kind === "needsReview"
        ? "border-destructive/40 bg-destructive/10 text-destructive"
        : "border-primary/40 bg-primary/10 text-primary";
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 rounded-full px-2.5 font-mono text-[10px] uppercase tracking-[0.12em]",
        tone,
      )}
    >
      {ROUTER_LABELS[kind]}
    </Badge>
  );
}

function OrdersSkeleton() {
  const ids = Array.from({ length: 5 }, (_, i) => `orders-skeleton-${i}`);
  return (
    <div data-ocid="orders.loading_state" className="space-y-2">
      {ids.map((id) => (
        <Skeleton key={id} className="h-14 w-full rounded-md" />
      ))}
    </div>
  );
}

/** Orders ledger: filterable list of every order with live status polling. */
export function OrdersPage() {
  const [filter, setFilter] = useState<FilterValue>("all");
  const ordersQuery = useOrders(filter === "all" ? null : statusFilter(filter));

  const orders = ordersQuery.data ?? [];

  return (
    <section data-ocid="orders.page" className="animate-fade-up space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-primary">
            Ledger
          </p>
          <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-foreground">
            Orders
          </h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Every swap order, newest first. Statuses refresh automatically every
            20 seconds.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-ocid="orders.refresh_button"
          onClick={() => void ordersQuery.refetch()}
          disabled={ordersQuery.isFetching}
        >
          <RefreshCw
            className={cn("size-3.5", ordersQuery.isFetching && "animate-spin")}
            aria-hidden="true"
          />
          Refresh
        </Button>
      </header>

      <div
        role="tablist"
        aria-label="Filter orders by status"
        data-ocid="orders.filter.tabs"
        className="flex flex-wrap gap-1.5"
      >
        {FILTERS.map((item) => {
          const active = filter === item.value;
          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={active}
              data-ocid={`orders.filter.tab.${item.value}`}
              onClick={() => setFilter(item.value)}
              className={cn(
                "rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.12em] transition-smooth",
                active
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border bg-card text-muted-foreground hover:border-primary/30 hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      {ordersQuery.isLoading ? (
        <OrdersSkeleton />
      ) : ordersQuery.isError ? (
        <div
          data-ocid="orders.error_state"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center"
        >
          <p className="text-sm text-destructive">
            Could not load orders. Check your connection and retry.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            data-ocid="orders.retry_button"
            onClick={() => void ordersQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : orders.length === 0 ? (
        <div
          data-ocid="orders.empty_state"
          className="rounded-lg border border-border bg-card p-10 text-center shadow-inset-soft"
        >
          <Inbox
            className="mx-auto size-8 text-muted-foreground"
            aria-hidden="true"
          />
          <h2 className="mt-3 font-display text-lg font-semibold text-foreground">
            {filter === "all" ? "No orders yet" : "No orders in this state"}
          </h2>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            {filter === "all"
              ? "Create a swap order from the console to see it tracked here."
              : "Try a different status filter to see other orders."}
          </p>
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-hidden rounded-lg border border-border bg-card shadow-inset-soft md:block">
            <Table data-ocid="orders.table">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    Order
                  </TableHead>
                  <TableHead className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    Status
                  </TableHead>
                  <TableHead className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    Token
                  </TableHead>
                  <TableHead className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    Recipient
                  </TableHead>
                  <TableHead className="text-right font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    Created
                  </TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.map((order, index) => (
                  <TableRow
                    key={order.id.toString()}
                    data-ocid={`orders.row.${index + 1}`}
                    className="group"
                  >
                    <TableCell className="num text-foreground">
                      #{order.id.toString()}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={order.routerStatus} />
                    </TableCell>
                    <TableCell className="num text-muted-foreground">
                      {order.tokenSymbol}
                    </TableCell>
                    <TableCell className="num text-muted-foreground">
                      {formatPrincipal(order.recipient.toText())}
                    </TableCell>
                    <TableCell className="num text-right text-muted-foreground">
                      {formatTimestamp(order.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link
                        to="/orders/$id"
                        params={{ id: order.id.toString() }}
                        data-ocid={`orders.open_link.${index + 1}`}
                        aria-label={`Open order ${order.id.toString()}`}
                        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-smooth hover:bg-accent/10 hover:text-primary"
                      >
                        <ArrowUpRight className="size-4" aria-hidden="true" />
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Mobile cards */}
          <ul className="space-y-3 md:hidden">
            {orders.map((order, index) => (
              <li key={order.id.toString()}>
                <Link
                  to="/orders/$id"
                  params={{ id: order.id.toString() }}
                  data-ocid={`orders.item.${index + 1}`}
                  className="block rounded-lg border border-border bg-card p-4 shadow-inset-soft transition-smooth hover:border-primary/40"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="num text-sm font-semibold text-foreground">
                      #{order.id.toString()}
                    </span>
                    <StatusBadge status={order.routerStatus} />
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                    <div className="min-w-0">
                      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                        Token
                      </dt>
                      <dd className="num truncate text-foreground">
                        {order.tokenSymbol} · {order.tokenChain}
                      </dd>
                    </div>
                    <div className="min-w-0 text-right">
                      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                        Recipient
                      </dt>
                      <dd className="num truncate text-foreground">
                        {formatPrincipal(order.recipient.toText())}
                      </dd>
                    </div>
                    <div className="col-span-2">
                      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                        Houdini leg
                      </dt>
                      <dd className="num text-muted-foreground">
                        {HOUDINI_LABELS[order.houdiniStatus]}
                      </dd>
                    </div>
                  </dl>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
