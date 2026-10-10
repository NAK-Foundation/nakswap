import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { type RenderOptions, render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

/**
 * Render a component inside a fresh TanStack Query client.
 *
 * Retries are disabled and the cache is per-render so a test never observes
 * another test's data or waits on a retry backoff.
 */
export function renderWithQuery(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  }

  return { queryClient, ...render(ui, { wrapper: Wrapper, ...options }) };
}

/**
 * Render a component inside a real TanStack Router (memory history) and a fresh
 * Query client. Components that use `<Link>` or `useParams` need a router
 * context; this provides one with stub routes for every path the app links to.
 */
export function renderWithRouter(
  ui: ReactElement,
  options?: { initialPath?: string } & Omit<RenderOptions, "wrapper">,
) {
  const { initialPath = "/", ...renderOptions } = options ?? {};
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });

  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <Outlet />
      </QueryClientProvider>
    ),
  });

  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => ui,
  });
  const ordersRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/orders",
    component: () => null,
  });
  const orderDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/orders/$id",
    component: () => null,
  });
  const adminRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/admin",
    component: () => null,
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      ordersRoute,
      orderDetailRoute,
      adminRoute,
    ]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });

  return {
    queryClient,
    router,
    ...render(<RouterProvider router={router} />, renderOptions),
  };
}
