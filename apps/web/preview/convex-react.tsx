// Preview stand-in for `convex/react` (see store.ts). Only the hooks the app uses.
import { getFunctionName } from "convex/server";
import { type ReactNode, useCallback, useSyncExternalStore } from "react";
import { getVersion, readPage, readQuery, runMutation, subscribe } from "./store";

type Reference = Parameters<typeof getFunctionName>[0];

export class ConvexReactClient {
  constructor(_url: string) {}
}

export function ConvexProvider({ children }: { children: ReactNode }) {
  return children;
}

export function useConvexAuth() {
  return { isAuthenticated: true, isLoading: false };
}

// Server rendering returns "loading" (version 0); the client resolves after hydration.
function useVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, () => 0);
}

export function useQuery(reference: Reference, args?: unknown): unknown {
  const version = useVersion();
  if (version === 0 || args === "skip") return undefined;
  return readQuery(getFunctionName(reference), args);
}

export function useMutation(reference: Reference) {
  const name = getFunctionName(reference);
  return useCallback((args?: unknown) => runMutation(name, args), [name]);
}

export function usePaginatedQuery(
  reference: Reference,
  args: unknown,
  _options: { initialNumItems: number },
) {
  const version = useVersion();
  const loadMore = useCallback(() => {}, []);
  if (version === 0 || args === "skip")
    return { results: [], status: "LoadingFirstPage" as const, isLoading: true, loadMore };
  return {
    results: readPage(getFunctionName(reference), args),
    status: "Exhausted" as const,
    isLoading: false,
    loadMore,
  };
}
