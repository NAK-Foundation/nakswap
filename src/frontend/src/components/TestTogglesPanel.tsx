import type { TestToggles } from "@/backend";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useSetTestToggles, useTestToggles } from "@/hooks/useBackend";
import { FlaskConical, Loader2 } from "lucide-react";
import { toast } from "sonner";

const TOGGLES: Array<{
  key: keyof TestToggles;
  label: string;
  description: string;
  ocid: string;
}> = [
  {
    key: "failNextNakPayout",
    label: "Fail next NAK payout once",
    description:
      "The next completed swap fails its NAK payout and lands in needsReview.",
    ocid: "admin.toggles.fail_payout_switch",
  },
  {
    key: "poolWithdrawFailsNextSwap",
    label: "Pool withdraw fails on next swap",
    description:
      "The next swap's pool withdrawal fails and the order lands in needsReview.",
    ocid: "admin.toggles.pool_withdraw_switch",
  },
  {
    key: "houdiniLegFailsNextOrder",
    label: "Houdini leg fails next order",
    description: "The next order's Houdini leg goes FAILED → REFUNDED.",
    ocid: "admin.toggles.houdini_fail_switch",
  },
];

/**
 * Sandbox-only fault injection toggles. Read via `getTestToggles`, written
 * via `setTestToggles`. Each switch flips one flag and persists immediately.
 */
export function TestTogglesPanel() {
  const { data: toggles, isLoading } = useTestToggles();
  const save = useSetTestToggles();

  const handleToggle = (key: keyof TestToggles, checked: boolean) => {
    if (!toggles) return;
    save.mutate(
      { ...toggles, [key]: checked },
      {
        onError: (error: Error) =>
          toast.error(error.message || "Could not update test toggles."),
      },
    );
  };

  return (
    <Card
      data-ocid="admin.toggles.card"
      className="rounded-lg border-border shadow-none"
    >
      <CardHeader className="border-b border-border">
        <CardTitle className="flex items-center gap-2 font-display text-base">
          <FlaskConical className="size-4 text-primary" aria-hidden="true" />
          Sandbox Fault Injection
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-6">
        {isLoading ? (
          <p
            data-ocid="admin.toggles.loading_state"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading test toggles…
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {TOGGLES.map((toggle) => (
              <li
                key={toggle.key}
                className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <Label htmlFor={toggle.key} className="text-sm">
                    {toggle.label}
                  </Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {toggle.description}
                  </p>
                </div>
                <Switch
                  id={toggle.key}
                  data-ocid={toggle.ocid}
                  checked={toggles?.[toggle.key] ?? false}
                  disabled={save.isPending || !toggles}
                  onCheckedChange={(checked) =>
                    handleToggle(toggle.key, checked)
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
