import { getFunctionName } from "convex/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ data: {} as Record<string, unknown>, skipped: [] as string[] }));
vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) => {
    const name = getFunctionName(reference);
    if (args === "skip") {
      state.skipped.push(name);
      return undefined;
    }
    return state.data[name];
  },
}));

import { DevicesSection } from "./devices";
import { actionsFor, PeopleSection, type Person } from "./people";

const NOW = 10 * 86_400_000;
const person = (overrides: Partial<Person>): Person => ({
  userId: "u" as Person["userId"],
  email: "someone@example.com",
  name: null,
  accessStatus: "allowed",
  isAdmin: false,
  isSelf: false,
  createdAt: NOW - 3_600_000,
  lastSignInAt: NOW - 60_000,
  ...overrides,
});

beforeEach(() => {
  state.data = {};
  state.skipped = [];
});

describe("PeopleSection", () => {
  it("renders nothing for non-admins and never asks for the user list", () => {
    state.data = { "admin:viewerRole": { isAdmin: false } };
    expect(renderToStaticMarkup(createElement(PeopleSection, { active: true, now: NOW }))).toBe("");
    expect(state.skipped).toContain("admin:listUsers");
  });

  it("skips all queries while Settings is closed", () => {
    renderToStaticMarkup(createElement(PeopleSection, { active: false, now: NOW }));
    expect(state.skipped).toEqual(["admin:viewerRole", "admin:listUsers"]);
  });

  it("shows people in plain language with approve and block for pending users", () => {
    state.data = {
      "admin:viewerRole": { isAdmin: true },
      "admin:listUsers": [
        person({
          userId: "p" as Person["userId"],
          email: "new@example.com",
          accessStatus: "pending",
        }),
        person({
          userId: "me" as Person["userId"],
          email: "me@example.com",
          isAdmin: true,
          isSelf: true,
        }),
        person({
          userId: "b" as Person["userId"],
          email: "gone@example.com",
          accessStatus: "blocked",
        }),
      ],
    };
    const html = renderToStaticMarkup(createElement(PeopleSection, { active: true, now: NOW }));
    expect(html).toContain("1 person is waiting for approval.");
    expect(html).toContain("Waiting for approval");
    expect(html).toContain("Has access");
    expect(html).toContain("Blocked");
    expect(html).toContain("me@example.com (you)");
    expect(html).toContain("Approve…");
    expect(html).toContain("Restore access…");
    expect(html).toContain("last signed in 1 min ago");
    expect(html.indexOf("new@example.com")).toBeLessThan(html.indexOf("me@example.com"));
  });

  it("offers no actions on your own row", () => {
    expect(actionsFor(person({ isSelf: true, isAdmin: true }))).toEqual([]);
    expect(actionsFor(person({ accessStatus: "pending" }))).toEqual(["approve", "block"]);
    expect(actionsFor(person({ isAdmin: true }))).toEqual(["removeAdmin", "block"]);
    expect(actionsFor(person({ accessStatus: "blocked" }))).toEqual(["approve"]);
  });
});

describe("DevicesSection", () => {
  const signIn = (id: string, current = false) => ({
    sessionId: id,
    createdAt: NOW - 86_400_000,
    expiresAt: NOW + 86_400_000,
    lastActiveAt: NOW - 120_000,
    current,
  });

  it("marks this device and offers to sign out the others", () => {
    state.data = { "admin:mySignIns": [signIn("a", true), signIn("b"), signIn("c")] };
    const html = renderToStaticMarkup(createElement(DevicesSection, { active: true, now: NOW }));
    expect(html).toContain("This device");
    expect(html).toContain("You&#x27;re here");
    expect(html.match(/Another browser/g)).toHaveLength(2);
    expect(html.match(/Sign out…/g)).toHaveLength(2);
    expect(html).toContain("Sign out all other devices…");
  });

  it("offers nothing to revoke when only this device is signed in", () => {
    state.data = { "admin:mySignIns": [signIn("a", true)] };
    const html = renderToStaticMarkup(createElement(DevicesSection, { active: true, now: NOW }));
    expect(html).toContain("This device");
    expect(html).not.toContain("Sign out");
  });
});
