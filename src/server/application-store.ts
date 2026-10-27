import { ApplicationError } from "../application/errors.js";
import { createFourFamilyRunProviderAdapter } from "../providers/runtime/four-family-run-provider-adapter.js";
import { bootstrapApplicationStore, type ApplicationStore } from "../application/storage/application-store.js";

type SharedState = {
  phase: "OPEN" | "CLOSING" | "CLOSED";
  store?: ApplicationStore;
  bootstrapPromise?: Promise<ApplicationStore>;
  closePromise?: Promise<void>;
  testBootstrap?: () => Promise<ApplicationStore>;
};

const STATE_KEY = Symbol.for("dev06-c4.shared-application-store.v1");
const globalState = globalThis as unknown as Record<symbol, SharedState | undefined>;

function sharedState(): SharedState {
  return globalState[STATE_KEY] ?? (globalState[STATE_KEY] = { phase: "OPEN" });
}

/** One lazy Store per Node process, shared across Next route handlers and dev reloads. */
export function getSharedApplicationStore(): Promise<ApplicationStore> {
  const state = sharedState();
  if (state.phase !== "OPEN") throw new ApplicationError("STORE_CLOSED", "The application store is closed.");
  if (state.store) return Promise.resolve(state.store);
  if (state.bootstrapPromise) return state.bootstrapPromise;

  const bootstrap = state.testBootstrap ?? (() => bootstrapApplicationStore({
    fourFamilyProviderPortFactory: (authority) => createFourFamilyRunProviderAdapter(authority),
  }));
  const pending = Promise.resolve().then(bootstrap);
  state.bootstrapPromise = pending;
  void pending.then(
    (store) => {
      if (state.phase === "OPEN") state.store = store;
      if (state.bootstrapPromise === pending) state.bootstrapPromise = undefined;
    },
    () => {
      // A failed startup is retryable; never retain a permanently rejected promise.
      if (state.bootstrapPromise === pending) state.bootstrapPromise = undefined;
    },
  );
  return pending;
}

/** Stops new access first, then waits for any bootstrap and drains Store.close(). */
export function closeSharedApplicationStore(): Promise<void> {
  const state = sharedState();
  if (state.closePromise) return state.closePromise;
  if (state.phase === "CLOSED") return Promise.resolve();
  state.phase = "CLOSING";
  const closing = (async () => {
    let store = state.store;
    if (!store && state.bootstrapPromise) {
      try { store = await state.bootstrapPromise; } catch { /* A failed bootstrap has no Store to close. */ }
    }
    try {
      if (store) await store.close();
    } finally {
      state.store = undefined;
      state.bootstrapPromise = undefined;
      state.phase = "CLOSED";
    }
  })();
  state.closePromise = closing;
  return closing;
}

/** Test-only reset seam. It is not reachable through HTTP routes. */
export function resetSharedApplicationStoreForTests(bootstrap?: () => Promise<ApplicationStore>): void {
  const state = sharedState();
  if (state.phase === "CLOSING" || state.store || state.bootstrapPromise) {
    throw new Error("Close the shared Store before resetting its test state.");
  }
  globalState[STATE_KEY] = { phase: "OPEN", testBootstrap: bootstrap };
}
