import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { configure } from "@testing-library/react";
import { afterEach } from "vitest";

// Generated components expose `data-ocid` hooks rather than roles/labels for
// some controls; make them queryable as test ids without misdiagnosing them as
// timing failures.
configure({ testIdAttribute: "data-ocid" });

// jsdom does not implement ResizeObserver, which Radix UI primitives (Switch,
// AlertDialog) use to measure their layout. A no-op observer is enough for the
// component tree to mount and for user interactions to be observable.
if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    ResizeObserverStub;
}

afterEach(() => {
  cleanup();
});
