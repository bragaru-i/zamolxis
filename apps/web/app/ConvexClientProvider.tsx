"use client";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";
const url = process.env.NEXT_PUBLIC_CONVEX_URL;
const client = url ? new ConvexReactClient(url) : null;
export function ConvexClientProvider({ children }: { children: ReactNode }) {
  if (!client) return children;
  return <ConvexAuthProvider client={client}>{children}</ConvexAuthProvider>;
}
