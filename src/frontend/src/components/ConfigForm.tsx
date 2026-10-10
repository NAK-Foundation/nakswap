import type { Config } from "@/backend";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useConfig, useSetConfig } from "@/hooks/useBackend";
import { formatDuration, parseIcp } from "@/lib/format";
import { Loader2, RotateCcw, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

interface Draft {
  slippageBps: string;
  maxImpactBps: string;
  minOrderIcp: string;
  maxOrderIcp: string;
  orderTtlSeconds: string;
  paused: boolean;
}

function toDraft(config: Config): Draft {
  return {
    slippageBps: config.slippageBps.toString(),
    maxImpactBps: config.maxImpactBps.toString(),
    minOrderIcp: (Number(config.minOrderIcp) / 1e8).toString(),
    maxOrderIcp: (Number(config.maxOrderIcp) / 1e8).toString(),
    orderTtlSeconds: config.orderTtlSeconds.toString(),
    paused: config.paused,
  };
}

const EMPTY_DRAFT: Draft = {
  slippageBps: "",
  maxImpactBps: "",
  minOrderIcp: "",
  maxOrderIcp: "",
  orderTtlSeconds: "",
  paused: false,
};

/** Parse a non-negative integer string, returning null instead of throwing. */
function parseNat(input: string): bigint | null {
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

/**
 * Test Controls config editor. Edits thresholds and the paused flag, then saves
 * the whole Config via `setConfig`. Values are seeded once from `getConfig`.
 */
export function ConfigForm() {
  const { data: config, isLoading } = useConfig();
  const save = useSetConfig();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [seeded, setSeeded] = useState(false);

  // Seed the editable draft once when config first arrives. Never overwrite the
  // user's in-progress edits on a later refetch.
  useEffect(() => {
    if (config && !seeded) {
      setDraft(toDraft(config));
      setSeeded(true);
    }
  }, [config, seeded]);

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const handleReset = () => {
    if (config) setDraft(toDraft(config));
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!config) return;

    const slippageBps = parseNat(draft.slippageBps);
    const maxImpactBps = parseNat(draft.maxImpactBps);
    const minOrderIcp = parseIcp(draft.minOrderIcp);
    const maxOrderIcp = parseIcp(draft.maxOrderIcp);
    const orderTtlSeconds = parseNat(draft.orderTtlSeconds);

    if (
      slippageBps === null ||
      maxImpactBps === null ||
      orderTtlSeconds === null
    ) {
      toast.error("Enter whole numbers for slippage, impact and TTL.");
      return;
    }
    if (minOrderIcp === null || maxOrderIcp === null) {
      toast.error("Enter valid ICP amounts for the order bounds.");
      return;
    }
    if (minOrderIcp > maxOrderIcp) {
      toast.error("Minimum order must not exceed the maximum order.");
      return;
    }

    save.mutate(
      {
        ...config,
        slippageBps,
        maxImpactBps,
        minOrderIcp,
        maxOrderIcp,
        orderTtlSeconds,
        paused: draft.paused,
      },
      {
        onSuccess: () => toast.success("Config saved."),
        onError: (error: Error) =>
          toast.error(error.message || "Could not save config."),
      },
    );
  };

  return (
    <Card
      data-ocid="admin.config.card"
      className="rounded-lg border-border shadow-none"
    >
      <CardHeader className="border-b border-border">
        <CardTitle className="flex items-center gap-2 font-display text-base">
          <Settings2 className="size-4 text-primary" aria-hidden="true" />
          Router Configuration
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-6">
        {isLoading ? (
          <p
            data-ocid="admin.config.loading_state"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading configuration…
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="config-slippage">
                  Slippage tolerance (bps)
                </Label>
                <Input
                  id="config-slippage"
                  data-ocid="admin.config.slippage_input"
                  inputMode="numeric"
                  value={draft.slippageBps}
                  onChange={(e) => update("slippageBps", e.target.value)}
                  className="num"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="config-impact">Max price impact (bps)</Label>
                <Input
                  id="config-impact"
                  data-ocid="admin.config.max_impact_input"
                  inputMode="numeric"
                  value={draft.maxImpactBps}
                  onChange={(e) => update("maxImpactBps", e.target.value)}
                  className="num"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="config-min">Min order (ICP)</Label>
                <Input
                  id="config-min"
                  data-ocid="admin.config.min_order_input"
                  inputMode="decimal"
                  value={draft.minOrderIcp}
                  onChange={(e) => update("minOrderIcp", e.target.value)}
                  className="num"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="config-max">Max order (ICP)</Label>
                <Input
                  id="config-max"
                  data-ocid="admin.config.max_order_input"
                  inputMode="decimal"
                  value={draft.maxOrderIcp}
                  onChange={(e) => update("maxOrderIcp", e.target.value)}
                  className="num"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="config-ttl">Order TTL (seconds)</Label>
                <Input
                  id="config-ttl"
                  data-ocid="admin.config.ttl_input"
                  inputMode="numeric"
                  value={draft.orderTtlSeconds}
                  onChange={(e) => update("orderTtlSeconds", e.target.value)}
                  className="num"
                />
                <p className="text-xs text-muted-foreground">
                  Currently{" "}
                  <span className="num">
                    {formatDuration(parseNat(draft.orderTtlSeconds))}
                  </span>
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-background/60 px-3 py-3">
              <div className="min-w-0">
                <Label htmlFor="config-paused" className="text-sm">
                  Pause new orders
                </Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  When paused, new order creation is blocked with a visible
                  notice.
                </p>
              </div>
              <Switch
                id="config-paused"
                data-ocid="admin.config.paused_switch"
                checked={draft.paused}
                onCheckedChange={(checked) => update("paused", checked)}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                data-ocid="admin.config.save_button"
                disabled={save.isPending}
              >
                {save.isPending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : null}
                {save.isPending ? "Saving…" : "Save config"}
              </Button>
              <Button
                type="button"
                variant="outline"
                data-ocid="admin.config.reset_button"
                onClick={handleReset}
                disabled={save.isPending || !config}
              >
                <RotateCcw className="size-4" aria-hidden="true" />
                Reset
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
