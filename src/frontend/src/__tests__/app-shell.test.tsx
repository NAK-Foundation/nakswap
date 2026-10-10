import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "@/App";
import { Layout } from "@/components/Layout";
import { SwapPage } from "@/pages/SwapPage";
import {
  SANDBOX_CONFIG,
  SANDBOX_QUOTE,
  SEEDED_TOKENS,
  coreInfraMock,
  makeOrder,
  resetCoreInfraMock,
} from "./coreInfraMock";
import { renderWithRouter } from "./test-utils";

vi.mock("@caffeineai/core-infrastructure", () =>
  import("./coreInfraMock").then((m) => m.coreInfraModule()),
);

function primeSwapBackend() {
  coreInfraMock.actor.getConfig.mockResolvedValue(SANDBOX_CONFIG);
  coreInfraMock.actor.listTokens.mockResolvedValue(SEEDED_TOKENS);
  coreInfraMock.actor.listOrders.mockResolvedValue([]);
  coreInfraMock.actor.getQuote.mockResolvedValue(SANDBOX_QUOTE);
}

describe("App default route", () => {
  beforeEach(() => {
    resetCoreInfraMock();
    primeSwapBackend();
  });

  it("loads the swap page on the default route without a blank screen", async () => {
    // `main.tsx` supplies the QueryClientProvider in the real app; mirror it.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId("swap.page")).toBeInTheDocument();
    expect(screen.getByTestId("mode_banner")).toBeInTheDocument();
  });
});

describe("Layout sandbox rail", () => {
  beforeEach(() => {
    resetCoreInfraMock();
  });

  it("shows the SANDBOX — no real funds banner on every page", async () => {
    renderWithRouter(
      <Layout>
        <div data-testid="page.content" />
      </Layout>,
    );

    const banner = await screen.findByTestId("mode_banner");
    expect(banner).toHaveTextContent("SANDBOX");
    expect(banner).toHaveTextContent("No real funds");
    expect(screen.queryByText(/live/i)).not.toBeInTheDocument();
  });
});

describe("SwapPage full token catalogue", () => {
  beforeEach(() => {
    resetCoreInfraMock();
    primeSwapBackend();
  });

  it("lists all 21 seeded tokens with symbol, name, and chain badge", async () => {
    const user = userEvent.setup();
    renderWithRouter(<SwapPage />);

    await user.click(await screen.findByTestId("swap.token_picker_trigger"));
    const menu = await screen.findByTestId("swap.token_picker_menu");

    // Every seeded symbol is present, including the multi-chain stablecoins.
    for (const symbol of [
      "BTC",
      "ETH",
      "USDT",
      "USDC",
      "SOL",
      "BNB",
      "XRP",
      "DOGE",
      "LTC",
      "TRX",
      "ADA",
      "AVAX",
      "POL",
      "TON",
      "XMR",
      "SUI",
      "ICP",
    ]) {
      expect(menu).toHaveTextContent(symbol);
    }
    // Names and chain badges are rendered for the catalogue.
    expect(menu).toHaveTextContent("Bitcoin");
    expect(menu).toHaveTextContent("Ethereum");
    expect(menu).toHaveTextContent("Solana");
    expect(menu).toHaveTextContent("Tron");
    expect(menu).toHaveTextContent("Base");
    expect(menu).toHaveTextContent("Cardano");
    expect(menu).toHaveTextContent("Avalanche");
    expect(menu).toHaveTextContent("Polygon");
    expect(menu).toHaveTextContent("Toncoin");
    expect(menu).toHaveTextContent("Monero");
    expect(menu).toHaveTextContent("Sui");
    expect(menu).toHaveTextContent("Internet Computer");
  });
});

describe("SwapPage deposit card", () => {
  beforeEach(() => {
    resetCoreInfraMock();
    primeSwapBackend();
  });

  it("labels the 64-hex ICP deposit account as the router deposit account", async () => {
    const user = userEvent.setup();
    const accountId = "0123456789abcdef".repeat(4);
    coreInfraMock.actor.createOrder.mockResolvedValue(3n);
    coreInfraMock.actor.getOrder.mockResolvedValue(
      makeOrder({
        id: 3n,
        depositAccountId: accountId,
        createdAt: BigInt(Date.now()) * 1_000_000n,
      }),
    );

    renderWithRouter(<SwapPage />);

    await user.type(
      await screen.findByTestId("swap.recipient_input"),
      "aaaaa-aa",
    );
    await user.type(screen.getByTestId("swap.amount_input"), "1");
    const createButton = screen.getByTestId("swap.create_order_button");
    await waitFor(() => expect(createButton).toBeEnabled());
    await user.click(createButton);

    const card = await screen.findByTestId("swap.deposit_card");
    expect(card).toHaveTextContent(
      "Houdini pays ICP here (router deposit account)",
    );
    expect(card).toHaveTextContent(accountId);
  });
});
