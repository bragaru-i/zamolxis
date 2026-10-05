"use client";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import { type ReactNode, useEffect } from "react";

const url = process.env.NEXT_PUBLIC_CONVEX_URL;
const client = url ? new ConvexReactClient(url) : null;
export function ConvexClientProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    // Tells the startup watchdog in the layout that the app bundle is running.
    (window as { __zamolxisStarted?: boolean }).__zamolxisStarted = true;
  }, []);
  if (!client) return children;
  return <ConvexAuthProvider client={client}>{children}</ConvexAuthProvider>;
}
