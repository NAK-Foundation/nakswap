import { createActor } from "@/backend";
import type {
  Backend,
  Config,
  Order,
  OrderSummary,
  Quote,
  RouteType,
  RouterStatus,
  SandboxBalances,
  TestToggles,
  Token,
} from "@/backend";
import { createActorWithConfig } from "@caffeineai/core-infrastructure";
import type { Principal } from "@icp-sdk/core/principal";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const ACTOR_QUERY_KEY = "anonymousActor";

/**
 * Anonymous backend actor.
 *
 * The app is sandbox-only and must never touch Internet Identity, so we do NOT
 * use the platform's `useActor` hook (it calls `useInternetIdentity()` and
 * asserts an `InternetIdentityProvider` is present). Instead we build the actor
 * directly with `createActorWithConfig`, which creates a plain anonymous agent.
 * The actor is cached through TanStack Query and shared by every feature hook.
 */
function useAnonymousActor() {
  const queryClient = useQueryClient();
  const actorQuery = useQuery({
    queryKey: [ACTOR_QUERY_KEY],
    queryFn: async (): Promise<Backend> => createActorWithConfig(createActor),
    staleTime: Number.POSITIVE_INFINITY,
    enabled: true,
  });

  return {
    actor: actorQuery.data ?? null,
    isFetching: actorQuery.isFetching,
    queryClient,
  };
}

/**
 * Shared access to the generated backend actor.
 * The actor is created once and cached through TanStack Query; every feature
 * hook reads it from here.
 */
export function useBackend() {
  const { actor, isFetching } = useAnonymousActor();
  return { actor, isFetching, isReady: !!actor && !isFetching };
}

/** Read the backend config (router thresholds). */
export function useConfig() {
  const { actor, isFetching } = useAnonymousActor();
  return useQuery({
    queryKey: ["config"],
    queryFn: async () => {
      if (!actor) throw new Error("Backend is not ready");
      return actor.getConfig();
    },
    enabled: !!actor && !isFetching,
  });
}

/** Read the token catalogue (symbols, chains, USD prices). */
export function useTokens() {
  const { actor, isFetching } = useAnonymousActor();
  return useQuery({
    queryKey: ["tokens"],
    queryFn: async () => {
      if (!actor) throw new Error("Backend is not ready");
      return actor.listTokens();
    },
    enabled: !!actor && !isFetching,
  });
}

/** Read the ICP USD price. */
export function useIcpPrice() {
  const { actor, isFetching } = useAnonymousActor();
  return useQuery({
    queryKey: ["icpPrice"],
    queryFn: async () => {
      if (!actor) throw new Error("Backend is not ready");
      return actor.getIcpPrice();
    },
    enabled: !!actor && !isFetching,
  });
}

/** Read the sandbox fault-injection toggles. */
export function useTestToggles() {
  const { actor, isFetching } = useAnonymousActor();
  return useQuery({
    queryKey: ["testToggles"],
    queryFn: async () => {
      if (!actor) throw new Error("Backend is not ready");
      return actor.getTestToggles();
    },
    enabled: !!actor && !isFetching,
  });
}

/** Read the simulated ledger snapshot. */
export function useSandboxBalances() {
  const { actor, isFetching } = useAnonymousActor();
  return useQuery({
    queryKey: ["sandboxBalances"],
    queryFn: async () => {
      if (!actor) throw new Error("Backend is not ready");
      return actor.getSandboxBalances();
    },
    enabled: !!actor && !isFetching,
  });
}

/** Read the simulated NAK balance of a principal. */
export function useNakBalance(principal: Principal | null) {
  const { actor, isFetching } = useAnonymousActor();
  return useQuery({
    queryKey: ["nakBalance", principal?.toText() ?? null],
    queryFn: async () => {
      if (!actor || !principal) throw new Error("Backend is not ready");
      return actor.getNakBalance(principal);
    },
    enabled: !!actor && !isFetching && !!principal,
  });
}

/** Read a single order by id. */
export function useOrder(id: bigint | null) {
  const { actor, isFetching } = useAnonymousActor();
  return useQuery({
    queryKey: ["order", id?.toString() ?? null],
    queryFn: async (): Promise<Order | null> => {
      if (!actor || id === null) return null;
      return actor.getOrder(id);
    },
    enabled: !!actor && !isFetching && id !== null,
  });
}

/** List orders, optionally filtered by router status. */
export function useOrders(filter: RouterStatus | null) {
  const { actor, isFetching } = useAnonymousActor();
  return useQuery({
    queryKey: ["orders", filter?.__kind__ ?? "all"],
    queryFn: async (): Promise<OrderSummary[]> => {
      if (!actor) return [];
      return actor.listOrders(filter);
    },
    enabled: !!actor && !isFetching,
  });
}

/** Two-leg quote preview for a prospective order. */
export function useQuote(
  tokenSymbol: string | null,
  tokenAmount: bigint | null,
  routeType: RouteType,
) {
  const { actor, isFetching } = useAnonymousActor();
  return useQuery({
    queryKey: [
      "quote",
      tokenSymbol,
      tokenAmount?.toString() ?? null,
      routeType,
    ],
    queryFn: async (): Promise<Quote> => {
      if (!actor || !tokenSymbol || tokenAmount === null) {
        throw new Error("Invalid quote request");
      }
      return actor.getQuote(tokenSymbol, tokenAmount, routeType);
    },
    enabled: !!actor && !isFetching && !!tokenSymbol && tokenAmount !== null,
    staleTime: 10_000,
  });
}

/** Create a new order; resolves to the new order id. */
export function useCreateOrder() {
  const { actor } = useAnonymousActor();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      recipient: Principal;
      tokenSymbol: string;
      tokenAmount: bigint;
      routeType: RouteType;
      refundAddress: string | null;
    }) => {
      if (!actor) throw new Error("Backend is not ready");
      return actor.createOrder(
        input.recipient,
        input.tokenSymbol,
        input.tokenAmount,
        input.routeType,
        input.refundAddress,
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
    },
  });
}

/** Simulate the user having sent the source token. */
export function useSimulateDeposit() {
  const { actor } = useAnonymousActor();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: bigint) => {
      if (!actor) throw new Error("Backend is not ready");
      return actor.simulateDeposit(id);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["order"] });
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
    },
  });
}

/** Advance a single order through the router pipeline. */
export function useProcessOrder() {
  const { actor } = useAnonymousActor();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: bigint) => {
      if (!actor) throw new Error("Backend is not ready");
      return actor.processOrder(id);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["order"] });
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
    },
  });
}

/** Persist the whole router config. */
export function useSetConfig() {
  const { actor } = useAnonymousActor();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (config: Config) => {
      if (!actor) throw new Error("Backend is not ready");
      return actor.setConfig(config);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["config"] });
    },
  });
}

/** Persist the whole test-toggle set. */
export function useSetTestToggles() {
  const { actor } = useAnonymousActor();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (toggles: TestToggles) => {
      if (!actor) throw new Error("Backend is not ready");
      return actor.setTestToggles(toggles);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["testToggles"] });
    },
  });
}

/** Update a single token's USD price. */
export function useSetTokenPrice() {
  const { actor } = useAnonymousActor();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { symbol: string; usdMicro: bigint }) => {
      if (!actor) throw new Error("Backend is not ready");
      return actor.setTokenPrice(input.symbol, input.usdMicro);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tokens"] });
    },
  });
}

/** Update the ICP USD price. */
export function useSetIcpPrice() {
  const { actor } = useAnonymousActor();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (usdMicro: bigint) => {
      if (!actor) throw new Error("Backend is not ready");
      return actor.setIcpPrice(usdMicro);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["icpPrice"] });
    },
  });
}

/** Reset the sandbox to its seeded state. */
export function useResetSandbox() {
  const { actor } = useAnonymousActor();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!actor) throw new Error("Backend is not ready");
      return actor.resetSandbox();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries();
    },
  });
}

/** Re-export the token type for consumers of this module. */
export type { Token };
