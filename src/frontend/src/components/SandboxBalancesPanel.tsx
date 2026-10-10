import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useNakBalance,
  useResetSandbox,
  useSandboxBalances,
} from "@/hooks/useBackend";
import { formatIcp, formatNak, formatPrincipal } from "@/lib/format";
import { Principal } from "@icp-sdk/core/principal";
import { Droplets, Loader2, RotateCcw, Wallet } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

/** Parse a typed principal, returning null when invalid. */
function parsePrincipal(value: string): Principal | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  try {
    return Principal.fromText(trimmed);
  } catch {
    return null;
  }
}

/**
 * Read-only snapshot of the simulated ledger: pool reserves, the router main
 * account, and the NAK balance of any PID typed in. Includes a reset control.
 */
export function SandboxBalancesPanel() {
  const { data, isLoading, isError } = useSandboxBalances();
  const reset = useResetSandbox();
  const [pid, setPid] = useState("");

  const principal = parsePrincipal(pid);
  const nakBalance = useNakBalance(principal);

  return (
    <Card
      data-ocid="admin.balances.card"
      className="rounded-lg border-border shadow-none"
    >
      <CardHeader className="border-b border-border">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 font-display text-base">
            <Wallet className="size-4 text-primary" aria-hidden="true" />
            Sandbox Balances
          </CardTitle>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-ocid="admin.balances.reset_button"
            onClick={() =>
              reset.mutate(undefined, {
                onSuccess: () =>
                  toast.success("Sandbox reset to its seeded state."),
                onError: (error: Error) =>
                  toast.error(error.message || "Could not reset the sandbox."),
              })
            }
            disabled={reset.isPending}
          >
            {reset.isPending ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <RotateCcw className="size-3.5" aria-hidden="true" />
            )}
            Reset sandbox
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6 pt-6">
        {isLoading ? (
          <p
            data-ocid="admin.balances.loading_state"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading balances…
          </p>
        ) : isError || !data ? (
          <p
            data-ocid="admin.balances.error_state"
            className="text-sm text-destructive"
          >
            Could not load sandbox balances.
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-border bg-background/60 p-4">
                <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  <Droplets className="size-3" aria-hidden="true" />
                  Pool ICP
                </p>
                <p className="num mt-2 text-lg font-semibold text-foreground">
                  {formatIcp(data.pool.icp)}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-background/60 p-4">
                <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  <Droplets className="size-3" aria-hidden="true" />
                  Pool NAK
                </p>
                <p className="num mt-2 text-lg font-semibold text-foreground">
                  {formatNak(data.pool.nak)}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-background/60 p-4">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  Router main
                </p>
                <p className="num mt-2 text-sm font-semibold text-foreground">
                  {formatIcp(data.routerMainIcp)} ICP
                </p>
                <p className="num text-sm text-muted-foreground">
                  {formatNak(data.routerMainNak)} NAK
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label
                htmlFor="nak-balance-pid"
                className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground"
              >
                NAK balance of a PID
              </Label>
              <Input
                id="nak-balance-pid"
                data-ocid="admin.balances.pid_input"
                placeholder="ICP principal (e.g. aaaaa-aa)"
                value={pid}
                onChange={(e) => setPid(e.target.value)}
                className="num"
              />
              {pid.trim() !== "" ? (
                principal === null ? (
                  <p
                    data-ocid="admin.balances.pid_error"
                    className="text-xs text-destructive"
                  >
                    That is not a valid principal.
                  </p>
                ) : (
                  <p
                    data-ocid="admin.balances.pid_result"
                    className="text-xs text-muted-foreground"
                  >
                    NAK balance:{" "}
                    <span className="num text-foreground">
                      {nakBalance.data !== undefined
                        ? formatNak(nakBalance.data)
                        : "…"}
                    </span>
                  </p>
                )
              ) : null}
            </div>

            <div>
              <h3 className="mb-2 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                User balances
              </h3>
              {data.users.length === 0 ? (
                <p
                  data-ocid="admin.balances.empty_state"
                  className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
                >
                  No simulated user balances yet.
                </p>
              ) : (
                <div className="rounded-lg border border-border">
                  <Table data-ocid="admin.balances.table">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Principal</TableHead>
                        <TableHead className="text-right">ICP</TableHead>
                        <TableHead className="text-right">NAK</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.users.map((user, index) => (
                        <TableRow
                          key={user.principal.toText()}
                          data-ocid={`admin.balances.row.${index + 1}`}
                        >
                          <TableCell
                            className="num text-muted-foreground"
                            title={user.principal.toText()}
                          >
                            {formatPrincipal(user.principal.toText())}
                          </TableCell>
                          <TableCell className="num text-right text-foreground">
                            {formatIcp(user.icp)}
                          </TableCell>
                          <TableCell className="num text-right text-foreground">
                            {formatNak(user.nak)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
