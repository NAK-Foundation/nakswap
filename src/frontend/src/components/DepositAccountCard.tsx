import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { DEPOSIT_TTL_SECONDS } from "@/lib/constants";
import { cn } from "@/lib/utils";

interface DepositAccountCardProps {
  depositAddress: string;
  depositAccountId: string;
  tokenSymbol: string;
  tokenChain: string;
  tokenAmount: bigint;
  orderId: bigint;
  createdAt: bigint;
}

function elapsedSeconds(createdAt: bigint): number {
  const nowNanos = BigInt(Date.now()) * 1_000_000n;
  const elapsed = Number((nowNanos - createdAt) / 1_000_000_000n);
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
}

function useCountdown(createdAt: bigint): number {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, DEPOSIT_TTL_SECONDS - elapsedSeconds(createdAt)),
  );

  useEffect(() => {
    const handle = window.setInterval(() => {
      setRemaining(
        Math.max(0, DEPOSIT_TTL_SECONDS - elapsedSeconds(createdAt)),
      );
    }, 1000);
    return () => window.clearInterval(handle);
  }, [createdAt]);

  return remaining;
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function CopyField({
  label,
  value,
  ocid,
  hint,
}: {
  label: string;
  value: string;
  ocid: string;
  hint: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="rounded-md border border-border bg-background/70 p-3.5">
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          {label}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-ocid={ocid}
          onClick={() => void handleCopy()}
          aria-label={copied ? `${label} copied` : `Copy ${label}`}
          className="h-6 px-2 text-[11px]"
        >
          {copied ? (
            <Check className="size-3 text-success" aria-hidden="true" />
          ) : (
            <Copy className="size-3" aria-hidden="true" />
          )}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <code
        data-ocid={`${ocid}.value`}
        className="addr mt-1.5 block break-all text-xs leading-relaxed text-foreground"
      >
        {value}
      </code>
      <p className="mt-1.5 text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}

/**
 * Fresh-order deposit pane: the chain-correct source address the user sends to,
 * the router-derived 64-hex ICP deposit account, and a 30-minute countdown.
 */
export function DepositAccountCard({
  depositAddress,
  depositAccountId,
  tokenSymbol,
  tokenChain,
  tokenAmount,
  orderId,
  createdAt,
}: DepositAccountCardProps) {
  const remaining = useCountdown(createdAt);
  const expired = remaining === 0;

  return (
    <section
      data-ocid="swap.deposit_card"
      aria-label="Order deposit details"
      className="rounded-lg border border-primary/30 bg-primary/[0.06] p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-sm font-semibold tracking-tight text-foreground">
          Send {tokenSymbol} to this deposit address
        </h2>
        <span
          data-ocid="swap.deposit_countdown"
          data-expired={expired}
          className={cn(
            "num rounded-full border px-2.5 py-0.5 font-mono text-[11px]",
            expired
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "border-primary/40 bg-primary/10 text-primary",
          )}
        >
          {expired ? "Expired" : `Expires in ${formatCountdown(remaining)}`}
        </span>
      </div>

      <p className="mt-1.5 text-xs text-muted-foreground">
        Send exactly{" "}
        <span className="num text-foreground">
          {tokenAmount.toString()} {tokenSymbol}
        </span>{" "}
        on {tokenChain}. Order #{orderId.toString()}.
      </p>

      <div className="mt-3.5 space-y-3">
        <CopyField
          label={`${tokenChain} deposit address`}
          value={depositAddress}
          ocid="swap.deposit_address"
          hint="Simulated address — no real funds move."
        />
        <CopyField
          label="Houdini pays ICP here (router deposit account)"
          value={depositAccountId}
          ocid="swap.deposit_account_id"
          hint="The router credits this account, then swaps ICP → NAK."
        />
      </div>
    </section>
  );
}
