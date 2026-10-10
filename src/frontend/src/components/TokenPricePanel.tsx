import type { Token } from "@/backend";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useIcpPrice,
  useSetIcpPrice,
  useSetTokenPrice,
  useTokens,
} from "@/hooks/useBackend";
import { formatUsdMicro, parseUsdMicro } from "@/lib/format";
import { Coins, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

/**
 * Test Controls price editor. Edits each token's USD price and the ICP price,
 * persisting through `setTokenPrice` / `setIcpPrice`.
 */
export function TokenPricePanel() {
  const { data: tokens, isLoading } = useTokens();
  const { data: icpPrice } = useIcpPrice();
  const setTokenPrice = useSetTokenPrice();
  const setIcpPrice = useSetIcpPrice();

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [icpDraft, setIcpDraft] = useState("");
  const [seeded, setSeeded] = useState(false);

  // Seed the editable drafts once from the backend catalogue.
  useEffect(() => {
    if (tokens && icpPrice !== undefined && !seeded) {
      const next: Record<string, string> = {};
      for (const token of tokens) {
        next[`${token.symbol}:${token.chain}`] = (
          Number(token.usdMicro) / 1e6
        ).toString();
      }
      setDrafts(next);
      setIcpDraft((Number(icpPrice) / 1e6).toString());
      setSeeded(true);
    }
  }, [tokens, icpPrice, seeded]);

  const handleSaveToken = (token: Token) => {
    const key = `${token.symbol}:${token.chain}`;
    const usdMicro = parseUsdMicro(drafts[key] ?? "");
    if (usdMicro === null) {
      toast.error(`Enter a valid USD price for ${token.symbol}.`);
      return;
    }
    setTokenPrice.mutate(
      { symbol: key, usdMicro },
      {
        onSuccess: () => toast.success(`${token.symbol} price saved.`),
        onError: (error: Error) =>
          toast.error(error.message || `Could not save ${token.symbol} price.`),
      },
    );
  };

  const handleSaveIcp = () => {
    const usdMicro = parseUsdMicro(icpDraft);
    if (usdMicro === null) {
      toast.error("Enter a valid ICP price.");
      return;
    }
    setIcpPrice.mutate(usdMicro, {
      onSuccess: () => toast.success("ICP price saved."),
      onError: (error: Error) =>
        toast.error(error.message || "Could not save the ICP price."),
    });
  };

  return (
    <Card
      data-ocid="admin.prices.card"
      className="rounded-lg border-border shadow-none"
    >
      <CardHeader className="border-b border-border">
        <CardTitle className="flex items-center gap-2 font-display text-base">
          <Coins className="size-4 text-primary" aria-hidden="true" />
          Token Prices
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5 pt-6">
        <div className="flex flex-col gap-2 rounded-md border border-border bg-background/60 p-3.5 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="icp-price">ICP price (USD)</Label>
            <Input
              id="icp-price"
              data-ocid="admin.prices.icp_input"
              inputMode="decimal"
              value={icpDraft}
              onChange={(e) => setIcpDraft(e.target.value)}
              className="num"
            />
          </div>
          <Button
            type="button"
            data-ocid="admin.prices.icp_save_button"
            onClick={handleSaveIcp}
            disabled={setIcpPrice.isPending}
          >
            {setIcpPrice.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            Save ICP price
          </Button>
        </div>

        {isLoading ? (
          <p
            data-ocid="admin.prices.loading_state"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading token prices…
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {(tokens ?? []).map((token) => {
              const key = `${token.symbol}:${token.chain}`;
              const slug = `${token.symbol}-${token.chain}`.toLowerCase();
              return (
                <li
                  key={key}
                  data-ocid={`admin.prices.row.${slug}`}
                  className="flex flex-col gap-2 py-3 first:pt-0 sm:flex-row sm:items-end"
                >
                  <div className="min-w-0 flex-1">
                    <Label htmlFor={`price-${slug}`} className="text-sm">
                      {token.symbol}{" "}
                      <span className="text-muted-foreground">
                        · {token.chain}
                      </span>
                    </Label>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Current {formatUsdMicro(token.usdMicro)}
                    </p>
                  </div>
                  <div className="flex items-end gap-2">
                    <Input
                      id={`price-${slug}`}
                      data-ocid={`admin.prices.input.${slug}`}
                      inputMode="decimal"
                      value={drafts[key] ?? ""}
                      onChange={(e) =>
                        setDrafts((current) => ({
                          ...current,
                          [key]: e.target.value,
                        }))
                      }
                      className="num w-32"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      data-ocid={`admin.prices.save_button.${slug}`}
                      onClick={() => handleSaveToken(token)}
                      disabled={setTokenPrice.isPending}
                    >
                      Save
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
