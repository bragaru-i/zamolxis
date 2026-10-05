import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";

const state = vi.hoisted(() => ({
  authenticated: true,
  accessStatus: "pending" as "pending" | "allowed" | "blocked",
  queries: [] as string[],
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: state.authenticated, isLoading: false }),
  useMutation: () => vi.fn(),
  useQuery: (reference: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(reference);
    state.queries.push(name);
    return name === "profiles:viewer"
      ? { userId: "user", email: "owner@example.com", accessStatus: state.accessStatus }
      : undefined;
  },
}));
vi.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signIn: vi.fn(), signOut: vi.fn() }),
}));
import HomePage from "./page";
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  state.authenticated = true;
  state.accessStatus = "pending";
  state.queries = [];
  vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://fixture.convex.cloud");
});
it.each(["pending", "blocked"] as const)(
  "shows only the access screen for %s accounts",
  (status) => {
    state.accessStatus = status;
    const html = renderToStaticMarkup(createElement(HomePage));
    expect(html).toContain(status === "blocked" ? "Access revoked" : "Access pending");
    expect(html).not.toContain("New command");
    expect(html).not.toContain("Approve this Mac");
    expect(state.queries).toEqual(["profiles:viewer"]);
  },
);
it("renders the dashboard only after a database grant", () => {
  state.accessStatus = "allowed";
  expect(renderToStaticMarkup(createElement(HomePage))).toContain("New command");
});
it("offers Google sign-in to signed-out users", () => {
  state.authenticated = false;
  expect(renderToStaticMarkup(createElement(HomePage))).toContain("Continue with Google");
});
