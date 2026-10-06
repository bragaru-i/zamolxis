// Preview stand-in for `@convex-dev/auth/react` (see store.ts): always signed in.
import type { ReactNode } from "react";

export function ConvexAuthProvider({ children }: { client?: unknown; children: ReactNode }) {
  return children;
}

export function useAuthActions() {
  return {
    signIn: async () => ({ signingIn: true, redirect: undefined }),
    signOut: async () => {},
  };
}
