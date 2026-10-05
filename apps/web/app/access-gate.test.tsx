import { getFunctionName } from "convex/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  authenticated: true,
  loading: false,
  accessStatus: "pending" as "pending" | "allowed" | "blocked",
  queries: [] as string[],
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: state.authenticated, isLoading: state.loading }),
  useMutation: () => vi.fn(),
  usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
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
  state.loading = false;
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
    expect(html).not.toContain("Continue with Google");
    expect(html).toContain("Sign out");
    expect(html).toContain(
      status === "blocked"
        ? "Contact an admin to restore access"
        : "Wait until an admin adds you to the system",
    );
    expect(html).not.toContain("What should we work on?");
    expect(html).not.toContain("Approve this Mac");
    expect(state.queries).toEqual(["profiles:viewer"]);
  },
);
it("renders the sessions workspace only after a database grant", () => {
  state.accessStatus = "allowed";
  const html = renderToStaticMarkup(createElement(HomePage));
  expect(html).toContain("Sessions");
  expect(html).toContain("What should we work on?");
  expect(html).not.toContain("Access pending");
});
it("offers Google sign-in to signed-out users", () => {
  state.authenticated = false;
  expect(renderToStaticMarkup(createElement(HomePage))).toContain("Continue with Google");
});

it("hides Google sign-in while authentication is being restored", () => {
  state.authenticated = false;
  state.loading = true;
  const html = renderToStaticMarkup(createElement(HomePage));
  expect(html).toContain("Checking access");
  expect(html).not.toContain("Continue with Google");
});
