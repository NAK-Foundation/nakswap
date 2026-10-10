import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HoudiniStatus } from "@/backend";
import { OrderDetailPage } from "@/pages/OrderDetailPage";
import { SwapPage } from "@/pages/SwapPage";
import {
  SANDBOX_CONFIG,
  SANDBOX_QUOTE,
  SEEDED_TOKENS,
  coreInfraMock,
  makeOrder,
  makeOrderSummary,
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

describe("SwapPage token catalogue", () => {
  beforeEach(() => {
    resetCoreInfraMock();
    primeSwapBackend();
  });

  it("lists every seeded token with symbol, name, and chain badge", async () => {
    const user = userEvent.setup();
    renderWithRouter(<SwapPage />);

    await user.click(await screen.findByTestId("swap.token_picker_trigger"));
    const menu = await screen.findByTestId("swap.token_picker_menu");

    // Every seeded symbol is present, including the multi-chain stablecoins.
    for (const symbol of ["BTC", "ETH", "USDT", "USDC", "SOL", "ICP"]) {
      expect(menu).toHaveTextContent(symbol);
    }
    expect(menu).toHaveTextContent("Bitcoin");
    expect(menu).toHaveTextContent("Ethereum");
    expect(menu).toHaveTextContent("Solana");
    expect(menu).toHaveTextContent("Tron");
    expect(menu).toHaveTextContent("Base");
  });
});

describe("SwapPage recent orders", () => {
  beforeEach(() => {
    resetCoreInfraMock();
    primeSwapBackend();
  });

  it("shows recent orders on the main page", async () => {
    coreInfraMock.actor.listOrders.mockResolvedValue([
      makeOrderSummary({ id: 11n, tokenSymbol: "ETH" }),
      makeOrderSummary({ id: 12n, tokenSymbol: "BTC" }),
    ]);
    renderWithRouter(<SwapPage />);

    const recent = await screen.findByTestId("swap.recent_orders");
    expect(recent).toHaveTextContent("#11");
    expect(recent).toHaveTextContent("#12");
    expect(recent).toHaveTextContent("ETH");
  });

  it("hides the recent-orders strip when there are no orders", async () => {
    coreInfraMock.actor.listOrders.mockResolvedValue([]);
    renderWithRouter(<SwapPage />);

    await screen.findByTestId("swap.page");
    expect(screen.queryByTestId("swap.recent_orders")).not.toBeInTheDocument();
  });
});

describe("SwapPage track order", () => {
  beforeEach(() => {
    resetCoreInfraMock();
    primeSwapBackend();
  });

  it("opens an order by ID from the Track order box", async () => {
    const user = userEvent.setup();
    const { router } = renderWithRouter(<SwapPage />);

    await user.type(await screen.findByTestId("swap.track_input"), "42");
    await user.click(screen.getByTestId("swap.track_button"));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/orders/42"),
    );
  });

  it("disables the Track order button until an ID is typed", async () => {
    renderWithRouter(<SwapPage />);

    expect(await screen.findByTestId("swap.track_button")).toBeDisabled();
  });
});

describe("OrderDetailPage expired order", () => {
  beforeEach(() => {
    resetCoreInfraMock();
    coreInfraMock.actor.getConfig.mockResolvedValue(SANDBOX_CONFIG);
  });

  it("shows EXPIRED for an order whose deposit was never sent", async () => {
    coreInfraMock.actor.getOrder.mockResolvedValue(
      makeOrder({ id: 21n, houdiniStatus: HoudiniStatus.expired }),
    );
    renderWithRouter(<OrderDetailPage id="21" />);

    const timeline = await screen.findByTestId("status_timeline");
    expect(timeline).toHaveAttribute("data-houdini-status", "expired");
    expect(screen.getByTestId("status_timeline.exceptional")).toHaveTextContent(
      "Expired",
    );
  });
});
