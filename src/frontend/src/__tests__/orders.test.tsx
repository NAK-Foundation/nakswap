import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HoudiniStatus } from "@/backend";
import { OrderDetailPage } from "@/pages/OrderDetailPage";
import { OrdersPage } from "@/pages/OrdersPage";
import {
  COMPLETED_ROUTER_STATUS,
  NEEDS_REVIEW_ROUTER_STATUS,
  PROCESS_ADVANCED,
  REFUNDED_ROUTER_STATUS,
  SANDBOX_CONFIG,
  coreInfraMock,
  makeOrder,
  makeOrderSummary,
  resetCoreInfraMock,
} from "./coreInfraMock";
import { renderWithRouter } from "./test-utils";

vi.mock("@caffeineai/core-infrastructure", () =>
  import("./coreInfraMock").then((m) => m.coreInfraModule()),
);

describe("OrdersPage", () => {
  beforeEach(() => {
    resetCoreInfraMock();
    coreInfraMock.actor.getConfig.mockResolvedValue(SANDBOX_CONFIG);
  });

  it("shows an empty state when there are no orders", async () => {
    coreInfraMock.actor.listOrders.mockResolvedValue([]);
    renderWithRouter(<OrdersPage />);

    expect(await screen.findByTestId("orders.empty_state")).toBeInTheDocument();
  });

  it("renders a row per order with its status", async () => {
    coreInfraMock.actor.listOrders.mockResolvedValue([
      makeOrderSummary({ id: 1n, routerStatus: COMPLETED_ROUTER_STATUS }),
      makeOrderSummary({ id: 2n, routerStatus: NEEDS_REVIEW_ROUTER_STATUS }),
    ]);
    renderWithRouter(<OrdersPage />);

    expect(await screen.findByTestId("orders.row.1")).toHaveTextContent(
      "Completed",
    );
    expect(screen.getByTestId("orders.row.2")).toHaveTextContent(
      "Needs review",
    );
  });

  it("requests a status-filtered list when a filter tab is selected", async () => {
    const user = userEvent.setup();
    coreInfraMock.actor.listOrders.mockResolvedValue([]);
    renderWithRouter(<OrdersPage />);

    await screen.findByTestId("orders.empty_state");
    await user.click(screen.getByTestId("orders.filter.tab.completed"));

    await waitFor(() =>
      expect(coreInfraMock.actor.listOrders).toHaveBeenCalledWith({
        __kind__: "completed",
        completed: null,
      }),
    );
  });
});

describe("OrderDetailPage", () => {
  beforeEach(() => {
    resetCoreInfraMock();
    coreInfraMock.actor.getConfig.mockResolvedValue(SANDBOX_CONFIG);
  });

  it("shows the combined timeline and the 64-hex deposit account", async () => {
    const accountId = "abcdef01".repeat(8);
    coreInfraMock.actor.getOrder.mockResolvedValue(
      makeOrder({
        id: 5n,
        houdiniStatus: HoudiniStatus.completed,
        routerStatus: COMPLETED_ROUTER_STATUS,
        depositAccountId: accountId,
        nakOut: 1_100_000_000n,
        block: 42n,
      }),
    );
    renderWithRouter(<OrderDetailPage id="5" />);

    expect(await screen.findByTestId("status_timeline")).toHaveAttribute(
      "data-router-status",
      "completed",
    );
    expect(
      screen.getByTestId("order_detail.deposit_account_id"),
    ).toHaveTextContent(accountId);
    expect(accountId).toMatch(/^[0-9a-f]{64}$/);
    expect(screen.getByTestId("status_timeline.terminal")).toHaveTextContent(
      "delivered to",
    );
    expect(screen.getByTestId("status_timeline.terminal")).toHaveTextContent(
      "Block #42",
    );
  });

  it("shows a refunded result panel with the refund reason", async () => {
    coreInfraMock.actor.getOrder.mockResolvedValue(
      makeOrder({
        id: 6n,
        houdiniStatus: HoudiniStatus.completed,
        routerStatus: REFUNDED_ROUTER_STATUS,
        refundReason: { __kind__: "tooSmall", tooSmall: null },
        icpIn: 5_000_000n,
        block: 7n,
      }),
    );
    renderWithRouter(<OrderDetailPage id="6" />);

    const result = await screen.findByTestId("order_result.panel");
    expect(result).toHaveAttribute("data-outcome", "refunded");
    expect(result).toHaveTextContent("ICP refunded");
    expect(result).toHaveTextContent("Deposit below minimum order size");
  });

  it("shows the needsReview reason in the timeline", async () => {
    coreInfraMock.actor.getOrder.mockResolvedValue(
      makeOrder({ id: 7n, routerStatus: NEEDS_REVIEW_ROUTER_STATUS }),
    );
    renderWithRouter(<OrderDetailPage id="7" />);

    expect(
      await screen.findByTestId("status_timeline.exceptional"),
    ).toHaveTextContent("pool withdraw failed (test toggle)");
  });

  it("simulates the deposit through the 'I've sent it' control", async () => {
    const user = userEvent.setup();
    coreInfraMock.actor.getOrder.mockResolvedValue(makeOrder({ id: 8n }));
    coreInfraMock.actor.simulateDeposit.mockResolvedValue(undefined);
    renderWithRouter(<OrderDetailPage id="8" />);

    await user.click(
      await screen.findByTestId("simulate_payout.submit_button"),
    );

    await waitFor(() =>
      expect(coreInfraMock.actor.simulateDeposit).toHaveBeenCalledWith(8n),
    );
  });

  it("advances an order through the 'Process now' control", async () => {
    const user = userEvent.setup();
    coreInfraMock.actor.getOrder.mockResolvedValue(makeOrder({ id: 9n }));
    coreInfraMock.actor.processOrder.mockResolvedValue(PROCESS_ADVANCED);
    renderWithRouter(<OrderDetailPage id="9" />);

    await user.click(await screen.findByTestId("order_detail.process_button"));

    await waitFor(() =>
      expect(coreInfraMock.actor.processOrder).toHaveBeenCalledWith(9n),
    );
  });
});
