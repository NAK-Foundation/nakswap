import type { HoudiniStatus, RouterStatus } from "@/backend";
import { HoudiniStatus as HoudiniStatusEnum } from "@/backend";
import { formatNak } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CheckCircle2 } from "lucide-react";

/** Ordered Houdini leg lifecycle. */
const HOUDINI_PATH: HoudiniStatus[] = [
  HoudiniStatusEnum.waiting,
  HoudiniStatusEnum.confirming,
  HoudiniStatusEnum.exchanging,
  HoudiniStatusEnum.anonymizing,
  HoudiniStatusEnum.completed,
];

/** Ordered router leg lifecycle. */
const ROUTER_PATH: RouterStatus["__kind__"][] = [
  "awaitingDeposit",
  "swapping",
  "payoutPending",
  "completed",
];

const HOUDINI_LABELS: Record<HoudiniStatus, string> = {
  [HoudiniStatusEnum.waiting]: "Waiting for deposit",
  [HoudiniStatusEnum.confirming]: "Confirming deposit",
  [HoudiniStatusEnum.exchanging]: "Exchanging to ICP",
  [HoudiniStatusEnum.anonymizing]: "Anonymizing",
  [HoudiniStatusEnum.completed]: "ICP delivered",
  [HoudiniStatusEnum.expired]: "Expired",
  [HoudiniStatusEnum.failed]: "Failed",
  [HoudiniStatusEnum.refunded]: "Refunded",
};

const ROUTER_LABELS: Record<RouterStatus["__kind__"], string> = {
  awaitingDeposit: "Awaiting ICP",
  swapping: "Swapping ICP → NAK",
  payoutPending: "Payout pending",
  completed: "NAK delivered",
  refunded: "ICP refunded",
  needsReview: "Needs review",
};

const HOUDINI_EXCEPTIONAL: HoudiniStatus[] = [
  HoudiniStatusEnum.expired,
  HoudiniStatusEnum.failed,
  HoudiniStatusEnum.refunded,
];

/** Human-readable label for a router status kind. */
export function routerStatusLabel(status: RouterStatus): string {
  return ROUTER_LABELS[status.__kind__];
}

/** Human-readable label for a Houdini status. */
export function houdiniStatusLabel(status: HoudiniStatus): string {
  return HOUDINI_LABELS[status];
}

function StepRow({
  label,
  index,
  currentIndex,
  total,
  tone,
}: {
  label: string;
  index: number;
  currentIndex: number;
  total: number;
  tone: "houdini" | "nakswap";
}) {
  const isCurrent = index === currentIndex;
  const isDone = currentIndex > index;
  const accent =
    tone === "houdini" ? "text-[oklch(var(--leg-houdini))]" : "text-primary";
  const dot =
    tone === "houdini" ? "bg-[oklch(var(--leg-houdini))]" : "bg-primary";

  return (
    <li
      data-ocid={`status_timeline.step.${index + 1}`}
      data-state={isCurrent ? "current" : isDone ? "done" : "pending"}
      className="relative flex gap-3 pb-5 last:pb-0"
    >
      <span className="relative flex flex-col items-center">
        <span
          aria-hidden="true"
          className={cn(
            "z-10 grid size-5 shrink-0 place-items-center rounded-full border transition-smooth",
            isCurrent
              ? "border-primary bg-primary/15"
              : isDone
                ? "border-success/50 bg-success/15"
                : "border-border bg-card",
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              isCurrent
                ? cn(dot, "animate-leg-pulse")
                : isDone
                  ? "bg-success"
                  : "bg-muted-foreground/50",
            )}
          />
        </span>
        {index < total - 1 ? (
          <span
            aria-hidden="true"
            className={cn(
              "absolute top-5 h-full w-px",
              isDone ? "bg-success/40" : "bg-border",
            )}
          />
        ) : null}
      </span>
      <div className="min-w-0 pt-0.5">
        <p
          className={cn(
            "font-mono text-[11px] font-semibold uppercase tracking-[0.16em]",
            isCurrent
              ? accent
              : isDone
                ? "text-success"
                : "text-muted-foreground",
          )}
        >
          {label}
        </p>
      </div>
    </li>
  );
}

function Leg({
  title,
  tone,
  steps,
  currentIndex,
}: {
  title: string;
  tone: "houdini" | "nakswap";
  steps: string[];
  currentIndex: number;
}) {
  return (
    <div
      className={cn("pl-4", tone === "houdini" ? "leg-houdini" : "leg-nakswap")}
    >
      <p
        className={cn(
          "mb-3 font-mono text-[11px] font-semibold uppercase tracking-[0.18em]",
          tone === "houdini"
            ? "text-[oklch(var(--leg-houdini))]"
            : "text-primary",
        )}
      >
        {title}
      </p>
      <ol className="relative">
        {steps.map((label, index) => (
          <StepRow
            key={label}
            label={label}
            index={index}
            currentIndex={currentIndex}
            total={steps.length}
            tone={tone}
          />
        ))}
      </ol>
    </div>
  );
}

/**
 * Combined two-leg lifecycle timeline.
 * Leg 1 (Houdini) reads cool cyan; Leg 2 (NAKSwap router) reads amber-gold.
 * Exceptional states render as a banner above the timeline.
 */
export function StatusTimeline({
  houdiniStatus,
  routerStatus,
  recipient,
  nakOut,
  block,
}: {
  houdiniStatus: HoudiniStatus;
  routerStatus: RouterStatus;
  recipient?: string;
  nakOut?: bigint;
  block?: bigint;
}) {
  const houdiniIndex = HOUDINI_PATH.indexOf(houdiniStatus);
  const routerIndex = ROUTER_PATH.indexOf(routerStatus.__kind__);

  const exceptional = HOUDINI_EXCEPTIONAL.includes(houdiniStatus)
    ? HOUDINI_LABELS[houdiniStatus]
    : routerStatus.__kind__ === "needsReview"
      ? routerStatus.needsReview
      : routerStatus.__kind__ === "refunded"
        ? "ICP refunded to the recipient"
        : null;

  return (
    <div
      data-ocid="status_timeline"
      data-status={routerStatus.__kind__}
      data-houdini-status={houdiniStatus}
      data-router-status={routerStatus.__kind__}
      className="space-y-6"
    >
      {exceptional ? (
        <p
          data-ocid="status_timeline.exceptional"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {exceptional}
        </p>
      ) : null}
      <Leg
        title="Leg 1 · Houdini"
        tone="houdini"
        steps={HOUDINI_PATH.map((s) => HOUDINI_LABELS[s])}
        currentIndex={houdiniIndex}
      />
      <Leg
        title="Leg 2 · NAKSwap router"
        tone="nakswap"
        steps={ROUTER_PATH.map((s) => ROUTER_LABELS[s])}
        currentIndex={routerIndex}
      />
      {routerStatus.__kind__ === "completed" ? (
        <div
          data-ocid="status_timeline.terminal"
          className="rounded-md border border-success/40 bg-success/10 px-3 py-2.5"
        >
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-success">
            <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
            <span className="num font-semibold">
              {nakOut !== undefined ? `${formatNak(nakOut)} NAK` : "NAK"}
            </span>
            <span>delivered to</span>
            <span className="addr min-w-0 text-success">
              {recipient ?? "—"}
            </span>
          </p>
          {block !== undefined ? (
            <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.14em] text-success/80">
              Block #{block.toString()}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
