import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RouteType } from "@/backend";
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

describe("SwapPage token picker", () => {
  beforeEach(() => {
    resetCoreInfraMock();
    primeSwapBackend();
  });

  it("lists the seeded tokens with symbol, name, and chain badge", async () => {
    const user = userEvent.setup();
    renderWithRouter(<SwapPage />);

    await user.click(await screen.findByTestId("swap.token_picker_trigger"));

    const menu = await screen.findByTestId("swap.token_picker_menu");
    expect(menu).toHaveTextContent("BTC");
    expect(menu).toHaveTextContent("Bitcoin");
    expect(menu).toHaveTextContent("Ethereum");
    expect(menu).toHaveTextContent("Solana");
  });

  it("filters the dropdown by search text", async () => {
    const user = userEvent.setup();
    renderWithRouter(<SwapPage />);

    await user.click(await screen.findByTestId("swap.token_picker_trigger"));
    await user.type(
      await screen.findByTestId("swap.token_picker_search"),
      "sol",
    );

    expect(
      await screen.findByTestId("swap.token_option.sol"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("swap.token_option.btc"),
    ).not.toBeInTheDocument();
  });
});

describe("SwapPage recipient validation", () => {
  beforeEach(() => {
    resetCoreInfraMock();
    primeSwapBackend();
  });

  it("rejects the anonymous principal and blocks the Swap button", async () => {
    const user = userEvent.setup();
    renderWithRouter(<SwapPage />);

    const recipient = await screen.findByTestId("swap.recipient_input");
    await user.type(recipient, "2vxsx-fae");
    await user.type(screen.getByTestId("swap.amount_input"), "1");

    expect(await screen.findByTestId("swap.recipient_error")).toHaveTextContent(
      "anonymous principal",
    );
    expect(screen.getByTestId("swap.create_order_button")).toBeDisabled();
  });

  it("rejects a malformed principal", async () => {
    const user = userEvent.setup();
    renderWithRouter(<SwapPage />);

    const recipient = await screen.findByTestId("swap.recipient_input");
    await user.type(recipient, "not-a-principal");
    await user.type(screen.getByTestId("swap.amount_input"), "1");

    expect(await screen.findByTestId("swap.recipient_error")).toHaveTextContent(
      "not a valid ICP principal",
    );
    expect(screen.getByTestId("swap.create_order_button")).toBeDisabled();
  });
});

describe("SwapPage quote preview", () => {
  beforeEach(() => {
    resetCoreInfraMock();
    primeSwapBackend();
  });

  it("shows both legs with fees, ETA, price impact, and minimum received", async () => {
    const user = userEvent.setup();
    renderWithRouter(<SwapPage />);

    await user.type(await screen.findByTestId("swap.amount_input"), "1");

    const result = await screen.findByTestId("swap.quote_result");
    expect(result).toHaveTextContent("Leg 1 · Houdini");
    expect(result).toHaveTextContent("Leg 2 · NAKSwap router");
    expect(result).toHaveTextContent("Houdini fee");
    expect(result).toHaveTextContent("ETA");
    expect(result).toHaveTextContent("3 ICP fees in");
    expect(result).toHaveTextContent("2 NAK fees out");
    expect(result).toHaveTextContent("Price impact");
    expect(result).toHaveTextContent("Min received (1%)");
  });

  it("requests a Private quote when the Private route is selected", async () => {
    const user = userEvent.setup();
    renderWithRouter(<SwapPage />);

    await user.type(await screen.findByTestId("swap.amount_input"), "1");
    await screen.findByTestId("swap.quote_result");

    await user.click(screen.getByTestId("swap.route_private_button"));

    await waitFor(() =>
      expect(coreInfraMock.actor.getQuote).toHaveBeenCalledWith(
        "USDC:Solana",
        100_000_000n,
        RouteType.private,
      ),
    );
  });
});

describe("SwapPage order creation", () => {
  beforeEach(() => {
    resetCoreInfraMock();
    primeSwapBackend();
  });

  it("creates an order and shows the deposit address with a countdown", async () => {
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
    expect(card).toHaveTextContent("Send exactly");
    expect(card).toHaveTextContent("ETH");
    expect(
      await screen.findByTestId("swap.deposit_countdown"),
    ).toHaveTextContent("Expires in");
    expect(
      screen.getByTestId("swap.deposit_account_id.value"),
    ).toHaveTextContent(accountId);
  });

  it("copies the deposit address to the clipboard", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    coreInfraMock.actor.createOrder.mockResolvedValue(4n);
    coreInfraMock.actor.getOrder.mockResolvedValue(
      makeOrder({ id: 4n, depositAddress: "0xabc123" }),
    );

    renderWithRouter(<SwapPage />);

    await user.type(
      await screen.findByTestId("swap.recipient_input"),
      "aaaaa-aa",
    );
    await user.type(screen.getByTestId("swap.amount_input"), "1");
    await waitFor(() =>
      expect(screen.getByTestId("swap.create_order_button")).toBeEnabled(),
    );
    await user.click(screen.getByTestId("swap.create_order_button"));

    await user.click(await screen.findByTestId("swap.deposit_address"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("0xabc123"));
  });
});
