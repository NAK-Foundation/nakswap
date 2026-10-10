import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Header } from "@/components/Header";
import { ModeBanner } from "@/components/ModeBanner";
import { resetCoreInfraMock } from "./coreInfraMock";
import { renderWithRouter } from "./test-utils";

vi.mock("@caffeineai/core-infrastructure", () =>
  import("./coreInfraMock").then((m) => m.coreInfraModule()),
);

describe("ModeBanner", () => {
  beforeEach(() => {
    resetCoreInfraMock();
  });

  it("shows the persistent SANDBOX — no real funds banner", async () => {
    renderWithRouter(<ModeBanner />);

    const banner = await screen.findByTestId("mode_banner");
    expect(banner).toHaveAttribute("data-mode", "sandbox");
    expect(banner).toHaveTextContent("SANDBOX");
    expect(banner).toHaveTextContent("No real funds");
  });

  it("never renders a Live mode switch", async () => {
    renderWithRouter(<ModeBanner />);

    const banner = await screen.findByTestId("mode_banner");
    expect(banner).toHaveAttribute("data-mode", "sandbox");
    expect(screen.queryByText(/live/i)).not.toBeInTheDocument();
  });
});

describe("Header", () => {
  beforeEach(() => {
    resetCoreInfraMock();
  });

  it("shows no sign-in, wallet, or admin link to any visitor", async () => {
    renderWithRouter(<Header />);

    expect(await screen.findByTestId("nav.brand_link")).toBeInTheDocument();
    expect(screen.queryByTestId("auth.sign_in_button")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("auth.sign_out_button"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("nav.admin_link")).not.toBeInTheDocument();
    expect(screen.queryByText(/connect wallet/i)).not.toBeInTheDocument();
  });

  it("links to the swap, orders, and test-controls pages", async () => {
    renderWithRouter(<Header />);

    expect(await screen.findByTestId("nav.swap_link")).toBeInTheDocument();
    expect(screen.getByTestId("nav.orders_link")).toBeInTheDocument();
    expect(screen.getByTestId("nav.test_controls_link")).toBeInTheDocument();
  });
});
