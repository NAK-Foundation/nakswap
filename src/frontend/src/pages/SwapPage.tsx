import { RouteType } from "@/backend";
import type { Order, OrderSummary, Token } from "@/backend";
import { DepositAccountCard } from "@/components/DepositAccountCard";
import { QuotePreview } from "@/components/QuotePreview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useConfig,
  useCreateOrder,
  useOrder,
  useOrders,
  useQuote,
  useTokens,
} from "@/hooks/useBackend";
import { ANONYMOUS_PRINCIPAL, DEFAULT_SEND_TOKEN } from "@/lib/constants";
import { formatPrincipal, formatTimestamp, parseIcp } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Principal } from "@icp-sdk/core/principal";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  Loader2,
  PauseCircle,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

/** Validate a principal string; returns an error message or null when valid. */
function validateRecipient(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return "Enter a recipient principal.";
  if (trimmed === ANONYMOUS_PRINCIPAL) {
    return "The anonymous principal cannot receive a swap payout.";
  }
  try {
    const principal = Principal.fromText(trimmed);
    if (principal.isAnonymous()) {
      return "The anonymous principal cannot receive a swap payout.";
    }
    return null;
  } catch {
    return "That is not a valid ICP principal.";
  }
}

/** Searchable token picker across chains. */
function TokenPicker({
  tokens,
  selected,
  onSelect,
  isLoading,
}: {
  tokens: Token[];
  selected: Token | null;
  onSelect: (token: Token) => void;
  isLoading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q === "") return tokens;
    return tokens.filter(
      (t) =>
        t.symbol.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.chain.toLowerCase().includes(q),
    );
  }, [tokens, search]);

  return (
    <div className="relative">
      <button
        type="button"
        data-ocid="swap.token_picker_trigger"
        onClick={() => setOpen((v) => !v)}
        disabled={isLoading}
        className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-background/60 px-3 py-2.5 text-left transition-smooth hover:border-primary/40 disabled:opacity-50"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          {selected ? (
            <>
              <span className="grid size-7 shrink-0 place-items-center rounded-full border border-primary/30 bg-primary/10 font-mono text-[10px] font-bold text-primary">
                {selected.symbol.slice(0, 3)}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-foreground">
                  {selected.symbol}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {selected.name} · {selected.chain}
                </span>
              </span>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">
              {isLoading ? "Loading tokens…" : "Select a token"}
            </span>
          )}
        </span>
        <ChevronDown
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div
          data-ocid="swap.token_picker_menu"
          className="absolute z-50 mt-1.5 w-full overflow-hidden rounded-md border border-border bg-popover shadow-panel"
        >
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search
              className="size-3.5 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              data-ocid="swap.token_picker_search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search symbol, name, or chain"
              className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          <ul className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-4 text-center text-sm text-muted-foreground">
                No tokens match.
              </li>
            ) : (
              filtered.map((token) => (
                <li key={`${token.symbol}-${token.chain}`}>
                  <button
                    type="button"
                    data-ocid={`swap.token_option.${token.symbol.toLowerCase()}`}
                    onClick={() => {
                      onSelect(token);
                      setOpen(false);
                      setSearch("");
                    }}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-smooth hover:bg-accent/10"
                  >
                    <span className="grid size-7 shrink-0 place-items-center rounded-full border border-border bg-background/60 font-mono text-[10px] font-bold text-foreground">
                      {token.symbol.slice(0, 3)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-foreground">
                        {token.symbol}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {token.name}
                      </span>
                    </span>
                    <span className="shrink-0 rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                      {token.chain}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Compact recent-orders strip shown under the swap card. */
function RecentOrders({ orders }: { orders: OrderSummary[] }) {
  if (orders.length === 0) return null;
  return (
    <div
      data-ocid="swap.recent_orders"
      className="rounded-lg border border-border bg-card p-5"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-sm font-semibold tracking-tight text-foreground">
          Recent orders
        </h2>
        <Link
          to="/orders"
          data-ocid="swap.all_orders_link"
          className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground transition-smooth hover:text-primary"
        >
          View all
        </Link>
      </div>
      <ul className="mt-3 divide-y divide-border">
        {orders.slice(0, 5).map((order, index) => (
          <li key={order.id.toString()}>
            <Link
              to="/orders/$id"
              params={{ id: order.id.toString() }}
              data-ocid={`swap.recent_order.${index + 1}`}
              className="flex items-center justify-between gap-3 py-2.5 transition-smooth hover:text-primary"
            >
              <span className="num text-sm text-foreground">
                #{order.id.toString()}
              </span>
              <span className="num text-xs text-muted-foreground">
                {order.tokenSymbol} ·{" "}
                {formatPrincipal(order.recipient.toText())}
              </span>
              <span className="num text-xs text-muted-foreground">
                {formatTimestamp(order.createdAt)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SwapPage() {
  const navigate = useNavigate();
  const { data: config } = useConfig();
  const tokensQuery = useTokens();
  const ordersQuery = useOrders(null);
  const createOrder = useCreateOrder();

  const [selectedToken, setSelectedToken] = useState<Token | null>(null);
  const [amount, setAmount] = useState("");
  const [debouncedAmount, setDebouncedAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [recipientTouched, setRecipientTouched] = useState(false);
  const [refundAddress, setRefundAddress] = useState("");
  const [routeType, setRouteType] = useState<RouteType>(RouteType.standard);
  const [createdOrderId, setCreatedOrderId] = useState<bigint | null>(null);
  const [trackId, setTrackId] = useState("");

  const createdOrder = useOrder(createdOrderId);

  // Default the token once the catalogue arrives: USDC on Solana, falling
  // back to the first listed token if it is ever missing from the catalogue.
  useEffect(() => {
    if (tokensQuery.data && tokensQuery.data.length > 0 && !selectedToken) {
      const preset = tokensQuery.data.find(
        (t) =>
          t.symbol.toUpperCase() === DEFAULT_SEND_TOKEN.symbol &&
          t.chain.toLowerCase() === DEFAULT_SEND_TOKEN.chain.toLowerCase(),
      );
      setSelectedToken(preset ?? tokensQuery.data[0]);
    }
  }, [tokensQuery.data, selectedToken]);

  // Debounce the amount before requesting a quote.
  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedAmount(amount), 350);
    return () => window.clearTimeout(handle);
  }, [amount]);

  const tokenAmount = useMemo(
    () => parseIcp(debouncedAmount),
    [debouncedAmount],
  );
  const hasAmount = tokenAmount !== null && tokenAmount > 0n;

  const quoteQuery = useQuote(
    selectedToken ? `${selectedToken.symbol}:${selectedToken.chain}` : null,
    hasAmount ? tokenAmount : null,
    routeType,
  );

  const recipientError = recipientTouched ? validateRecipient(recipient) : null;
  const recipientValid = validateRecipient(recipient) === null;
  const paused = config?.paused ?? false;
  const canCreate =
    recipientValid &&
    hasAmount &&
    !!selectedToken &&
    !paused &&
    !createOrder.isPending;

  function handleCreateOrder() {
    setRecipientTouched(true);
    if (!canCreate || !selectedToken || tokenAmount === null) return;
    createOrder.mutate(
      {
        recipient: Principal.fromText(recipient.trim()),
        tokenSymbol: `${selectedToken.symbol}:${selectedToken.chain}`,
        tokenAmount,
        routeType,
        refundAddress:
          refundAddress.trim() === "" ? null : refundAddress.trim(),
      },
      {
        onSuccess: (orderId) => setCreatedOrderId(orderId),
      },
    );
  }

  const created: Order | null = createdOrder.data ?? null;

  return (
    <section data-ocid="swap.page" className="animate-fade-up">
      <header className="max-w-2xl">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-primary">
          Route / Token → ICP → NAK
        </p>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-foreground">
          Two-Leg Swap Test Lab
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Quote a swap, open an order, and send the source token to a simulated
          deposit address. No real funds ever move.
        </p>
      </header>

      {paused ? (
        <div
          data-ocid="swap.paused_notice"
          role="alert"
          className="mt-6 flex items-start gap-2.5 rounded-lg border border-[oklch(var(--warning)/0.4)] bg-[oklch(var(--warning)/0.1)] px-4 py-3 text-sm text-[oklch(var(--warning))]"
        >
          <PauseCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div>
            <p className="font-medium">Order creation is paused</p>
            <p className="mt-0.5 text-xs opacity-90">
              An operator has paused new orders. Quotes remain available, but
              the create action is disabled until the pause is lifted.
            </p>
          </div>
        </div>
      ) : null}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* Order form */}
        <form
          data-ocid="swap.form"
          className="flex flex-col gap-5 rounded-lg border border-border bg-card p-5 shadow-swap-card"
          onSubmit={(event) => {
            event.preventDefault();
            handleCreateOrder();
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="swap-token">You send</Label>
            <TokenPicker
              tokens={tokensQuery.data ?? []}
              selected={selectedToken}
              onSelect={setSelectedToken}
              isLoading={tokensQuery.isLoading}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="swap-amount">Amount</Label>
            <div className="relative">
              <Input
                id="swap-amount"
                data-ocid="swap.amount_input"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                autoComplete="off"
                className="num pr-16 text-base"
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
                {selectedToken?.symbol ?? "TOKEN"}
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="swap-recipient">NAK recipient (your ICP PID)</Label>
            <Input
              id="swap-recipient"
              data-ocid="swap.recipient_input"
              value={recipient}
              onChange={(event) => setRecipient(event.target.value)}
              onBlur={() => setRecipientTouched(true)}
              placeholder="aaaaa-aa…"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={recipientError ? true : undefined}
              aria-describedby={
                recipientError ? "swap-recipient-error" : "swap-recipient-hint"
              }
              className="num"
            />
            {recipientError ? (
              <p
                id="swap-recipient-error"
                data-ocid="swap.recipient_error"
                className="flex items-center gap-1.5 text-xs text-destructive"
              >
                <AlertTriangle className="size-3" aria-hidden="true" />
                {recipientError}
              </p>
            ) : (
              <p
                id="swap-recipient-hint"
                className="text-xs text-muted-foreground"
              >
                NAK is paid out to this principal. The anonymous principal is
                rejected.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="swap-refund">Refund address (optional)</Label>
            <Input
              id="swap-refund"
              data-ocid="swap.refund_input"
              value={refundAddress}
              onChange={(event) => setRefundAddress(event.target.value)}
              placeholder="Source-chain refund address"
              spellCheck={false}
              autoComplete="off"
              className="num"
            />
            <p className="text-xs text-muted-foreground">
              Stored and shown only — never used to move real funds.
            </p>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium leading-none">
              Route type
            </legend>
            <div className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-background/60 p-1">
              <button
                type="button"
                data-ocid="swap.route_standard_button"
                aria-pressed={routeType === RouteType.standard}
                onClick={() => setRouteType(RouteType.standard)}
                className={cn(
                  "rounded-md px-3 py-2 text-sm font-medium transition-smooth",
                  routeType === RouteType.standard
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-accent/10 hover:text-foreground",
                )}
              >
                Standard
                <span className="mt-0.5 block text-[10px] font-normal uppercase tracking-[0.1em] opacity-70">
                  ~0.8% · faster
                </span>
              </button>
              <button
                type="button"
                data-ocid="swap.route_private_button"
                aria-pressed={routeType === RouteType.private}
                onClick={() => setRouteType(RouteType.private)}
                className={cn(
                  "rounded-md px-3 py-2 text-sm font-medium transition-smooth",
                  routeType === RouteType.private
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-accent/10 hover:text-foreground",
                )}
              >
                Private
                <span className="mt-0.5 block text-[10px] font-normal uppercase tracking-[0.1em] opacity-70">
                  ~1.5% · slower
                </span>
              </button>
            </div>
          </fieldset>

          <Button
            type="submit"
            data-ocid="swap.create_order_button"
            disabled={!canCreate}
            className="w-full"
          >
            {createOrder.isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Creating order…
              </>
            ) : (
              <>
                Swap
                <ArrowRight className="size-4" aria-hidden="true" />
              </>
            )}
          </Button>

          {createOrder.isError ? (
            <p
              data-ocid="swap.create_error"
              role="alert"
              className="flex items-center gap-1.5 text-xs text-destructive"
            >
              <AlertTriangle className="size-3" aria-hidden="true" />
              Could not create the order. Please try again.
            </p>
          ) : null}
        </form>

        {/* Quote preview */}
        <QuotePreview
          quote={quoteQuery.data ?? null}
          config={config ?? null}
          isLoading={quoteQuery.isFetching && hasAmount}
          isError={quoteQuery.isError}
          isIdle={!hasAmount}
        />
      </div>

      {createdOrderId !== null ? (
        <div className="mt-6 flex flex-col gap-4">
          {created ? (
            <DepositAccountCard
              depositAddress={created.depositAddress}
              depositAccountId={created.depositAccountId}
              tokenSymbol={created.tokenSymbol}
              tokenChain={created.tokenChain}
              tokenAmount={created.tokenAmount}
              orderId={created.id}
              createdAt={created.createdAt}
            />
          ) : (
            <Skeleton className="h-48 w-full rounded-lg" />
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              data-ocid="swap.view_order_button"
              onClick={() =>
                void navigate({
                  to: "/orders/$id",
                  params: { id: createdOrderId.toString() },
                })
              }
            >
              View order #{createdOrderId.toString()}
              <ArrowRight className="size-4" aria-hidden="true" />
            </Button>
            <button
              type="button"
              data-ocid="swap.new_order_button"
              onClick={() => {
                setCreatedOrderId(null);
                setAmount("");
                setDebouncedAmount("");
              }}
              className="text-xs text-muted-foreground underline-offset-4 transition-smooth hover:text-foreground hover:underline"
            >
              Start another order
            </button>
          </div>
        </div>
      ) : null}

      {/* Track order */}
      <div className="mt-6 rounded-lg border border-border surface-sunken p-5">
        <h2 className="font-display text-sm font-semibold tracking-tight text-foreground">
          Track order
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Enter an order ID to open its combined two-leg timeline.
        </p>
        <form
          className="mt-3 flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (trackId.trim() === "") return;
            void navigate({
              to: "/orders/$id",
              params: { id: trackId.trim() },
            });
          }}
        >
          <Input
            data-ocid="swap.track_input"
            value={trackId}
            onChange={(event) => setTrackId(event.target.value)}
            inputMode="numeric"
            placeholder="Order ID"
            className="num flex-1"
          />
          <Button
            type="submit"
            variant="outline"
            data-ocid="swap.track_button"
            disabled={trackId.trim() === ""}
          >
            Track order
          </Button>
        </form>
      </div>

      <div className="mt-6">
        <RecentOrders orders={ordersQuery.data ?? []} />
      </div>
    </section>
  );
}
