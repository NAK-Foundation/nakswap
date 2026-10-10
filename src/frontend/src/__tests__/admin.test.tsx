import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminPage } from "@/pages/AdminPage";
import {
  SANDBOX_BALANCES,
  SANDBOX_CONFIG,
  SANDBOX_TOGGLES,
  SEEDED_TOKENS,
  coreInfraMock,
  resetCoreInfraMock,
} from "./coreInfraMock";
import { renderWithRouter } from "./test-utils";

vi.mock("@caffeineai/core-infrastructure", () =>
  import("./coreInfraMock").then((m) => m.coreInfraModule()),
);

function primeAdminBackend() {
  coreInfraMock.actor.getConfig.mockResolvedValue(SANDBOX_CONFIG);
  coreInfraMock.actor.getTestToggles.mockResolvedValue(SANDBOX_TOGGLES);
  coreInfraMock.actor.getSandboxBalances.mockResolvedValue(SANDBOX_BALANCES);
  coreInfraMock.actor.listTokens.mockResolvedValue(SEEDED_TOKENS);
  coreInfraMock.actor.getIcpPrice.mockResolvedValue(3_000_000n);
}

describe("AdminPage access", () => {
  beforeEach(() => {
    resetCoreInfraMock();
    primeAdminBackend();
  });

  it("renders the Test Controls console for an anonymous visitor", async () => {
    renderWithRouter(<AdminPage />);

    expect(await screen.findByTestId("admin.page")).toBeInTheDocument();
    expect(screen.getByTestId("admin.config.card")).toBeInTheDocument();
    expect(screen.getByTestId("admin.toggles.card")).toBeInTheDocument();
    expect(screen.getByTestId("admin.prices.card")).toBeInTheDocument();
    expect(screen.getByTestId("admin.balances.card")).toBeInTheDocument();
  });
});

describe("AdminPage config", () => {
  beforeEach(() => {
    resetCoreInfraMock();
    primeAdminBackend();
  });

  it("seeds the config form from the backend config and saves edits", async () => {
    const user = userEvent.setup();
    coreInfraMock.actor.setConfig.mockResolvedValue(undefined);
    renderWithRouter(<AdminPage />);

    // The form first renders against the disabled actor query, then remounts
    // once the actor resolves and `getConfig` seeds the draft. Re-query inside
    // `waitFor` so the assertion never reads a detached input.
    await waitFor(() =>
      expect(screen.getByTestId("admin.config.min_order_input")).toHaveValue(
        "0.1",
      ),
    );

    const minInput = screen.getByTestId("admin.config.min_order_input");
    await user.clear(minInput);
    await user.type(minInput, "0.2");
    await user.click(screen.getByTestId("admin.config.save_button"));

    await waitFor(() =>
      expect(coreInfraMock.actor.setConfig).toHaveBeenCalledWith(
        expect.objectContaining({ minOrderIcp: 20_000_000n }),
      ),
    );
  });
});

describe("AdminPage test toggles", () => {
  beforeEach(() => {
    resetCoreInfraMock();
    primeAdminBackend();
  });

  it("persists the fail-next-NAK-payout toggle", async () => {
    const user = userEvent.setup();
    coreInfraMock.actor.setTestToggles.mockResolvedValue(undefined);
    renderWithRouter(<AdminPage />);

    // The panel renders before the actor resolves, with every switch disabled.
    // Wait for the toggle data to arrive and enable the switch before clicking.
    await waitFor(() =>
      expect(
        screen.getByTestId("admin.toggles.fail_payout_switch"),
      ).toBeEnabled(),
    );
    await user.click(screen.getByTestId("admin.toggles.fail_payout_switch"));

    await waitFor(() =>
      expect(coreInfraMock.actor.setTestToggles).toHaveBeenCalledWith({
        ...SANDBOX_TOGGLES,
        failNextNakPayout: true,
      }),
    );
  });

  it("persists the Houdini-leg-fails toggle", async () => {
    const user = userEvent.setup();
    coreInfraMock.actor.setTestToggles.mockResolvedValue(undefined);
    renderWithRouter(<AdminPage />);

    await waitFor(() =>
      expect(
        screen.getByTestId("admin.toggles.houdini_fail_switch"),
      ).toBeEnabled(),
    );
    await user.click(screen.getByTestId("admin.toggles.houdini_fail_switch"));

    await waitFor(() =>
      expect(coreInfraMock.actor.setTestToggles).toHaveBeenCalledWith({
        ...SANDBOX_TOGGLES,
        houdiniLegFailsNextOrder: true,
      }),
    );
  });
});

describe("AdminPage prices and balances", () => {
  beforeEach(() => {
    resetCoreInfraMock();
    primeAdminBackend();
  });

  it("edits a token USD price", async () => {
    const user = userEvent.setup();
    coreInfraMock.actor.setTokenPrice.mockResolvedValue(undefined);
    renderWithRouter(<AdminPage />);

    const input = await screen.findByTestId("admin.prices.input.eth-ethereum");
    await user.clear(input);
    await user.type(input, "3.5");
    await user.click(
      screen.getByTestId("admin.prices.save_button.eth-ethereum"),
    );

    await waitFor(() =>
      expect(coreInfraMock.actor.setTokenPrice).toHaveBeenCalledWith(
        "ETH:Ethereum",
        3_500_000n,
      ),
    );
  });

  it("edits the ICP price", async () => {
    const user = userEvent.setup();
    coreInfraMock.actor.setIcpPrice.mockResolvedValue(undefined);
    renderWithRouter(<AdminPage />);

    const input = await screen.findByTestId("admin.prices.icp_input");
    await waitFor(() => expect(input).toHaveValue("3"));
    await user.clear(input);
    await user.type(input, "4");
    await user.click(screen.getByTestId("admin.prices.icp_save_button"));

    await waitFor(() =>
      expect(coreInfraMock.actor.setIcpPrice).toHaveBeenCalledWith(4_000_000n),
    );
  });

  it("shows the sandbox pool balances and resets the sandbox", async () => {
    const user = userEvent.setup();
    coreInfraMock.actor.resetSandbox.mockResolvedValue(undefined);
    renderWithRouter(<AdminPage />);

    const card = await screen.findByTestId("admin.balances.card");
    await waitFor(() => expect(card).toHaveTextContent("Pool ICP"));
    expect(card).toHaveTextContent("Pool NAK");
    expect(card).toHaveTextContent("Router main");

    await user.click(screen.getByTestId("admin.balances.reset_button"));
    await waitFor(() =>
      expect(coreInfraMock.actor.resetSandbox).toHaveBeenCalled(),
    );
  });
});
