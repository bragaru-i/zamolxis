"use client";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { type ReactNode, useCallback, useEffect, useState } from "react";

const url = process.env.NEXT_PUBLIC_CONVEX_URL;
const client = url ? new ConvexReactClient(url) : null;
function useAuth() {
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const fetchAccessToken = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/token", { cache: "no-store" });
      const { token } = (await response.json()) as { token: string | null };
      setAuthenticated(Boolean(token));
      setLoading(false);
      return token;
    } catch {
      setAuthenticated(false);
      setLoading(false);
      return null;
    }
  }, []);
  useEffect(() => {
    void fetchAccessToken();
  }, [fetchAccessToken]);
  return { isLoading: loading, isAuthenticated: authenticated, fetchAccessToken };
}
export function ConvexClientProvider({ children }: { children: ReactNode }) {
  if (!client) return children;
  return (
    <ConvexProviderWithAuth client={client} useAuth={useAuth}>
      {children}
    </ConvexProviderWithAuth>
  );
}
