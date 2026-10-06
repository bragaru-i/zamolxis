import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  calls: [] as Array<{ name: string; args: unknown }>,
}));
vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) => {
    const name = getFunctionName(reference);
    state.calls.push({ name, args });
    return args === "skip" ? undefined : state.data[name];
  },
}));
vi.mock("@convex-dev/auth/react", () => ({ useAuthActions: () => ({ signOut: vi.fn() }) }));

import { type Device, explainMacError, MacItem, macNameProblem } from "./macs";

const NOW = 1_000_000;
const device = (overrides: Partial<Device> = {}): Device => ({
  _id: "w1" as Device["_id"],
  name: "Studio",
  status: "online",
  lastHeartbeatAt: NOW - 1000,
  runtimes: [{ runtime: "codex", status: "available" }],
  ...overrides,
});
const render = (props: Partial<Parameters<typeof MacItem>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(MacItem, { device: device(), now: NOW, onMessage: () => {}, ...props }),
  );

beforeEach(() => {
  state.data = {};
  state.calls = [];
});

describe("Settings → Macs", () => {
  it("offers rename, repositories and removal for an active Mac", () => {
    const html = render();
    expect(html).toContain("Codex ready");
    expect(html).toContain("Rename");
    expect(html).toContain("Repositories");
    expect(html).toContain("Remove this Mac…");
    // Nothing is queried until the repositories are opened.
    expect(state.calls).toEqual([]);
  });

  it("reports any available agent runtime", () => {
    expect(
      render({ device: device({ runtimes: [{ runtime: "claude", status: "available" }] }) }),
    ).toContain("Claude Code ready");
    expect(render({ device: device({ runtimes: [] }) })).toContain("No agent runtime");
  });

  it("offers nothing for a revoked Mac", () => {
    const html = render({ device: device({ status: "revoked" }) });
    expect(html).toContain("Revoked");
    expect(html).not.toContain("Rename");
  });

  it("prefills the rename form with the current name, bounded to 64 characters", () => {
    const html = render({ initialMode: "rename" });
    expect(html).toContain('value="Studio"');
    expect(html).toContain('maxLength="64"');
    expect(macNameProblem("  ")).toBe("Enter a name.");
    expect(macNameProblem("x".repeat(65))).toContain("64");
    expect(macNameProblem(" Laptop ")).toBeUndefined();
  });

  it("lists this Mac's repositories with a way to remove each", () => {
    state.data = {
      "repositories:listLocations": [
        {
          repositoryLocationId: "l1",
          repositoryName: "zamolxis",
          canonicalPath: "/Users/me/Projects/zamolxis",
          status: "available",
        },
      ],
    };
    const html = render({ initialMode: "repositories" });
    expect(state.calls).toEqual([
      { name: "repositories:listLocations", args: { workstationId: "w1" } },
    ]);
    expect(html).toContain("zamolxis");
    expect(html).toContain("/Users/me/Projects/zamolxis");
    expect(html).toContain("Remove from this Mac…");
    // Not a GitHub repository: no GitHub row.
    expect(html).not.toContain("GitHub");
  });

  it("shows each GitHub repository's publishing access on this Mac", () => {
    state.data = {
      "repositories:listLocations": [
        {
          repositoryLocationId: "l1",
          repositoryName: "zamolxis",
          canonicalPath: "/Users/me/Projects/zamolxis",
          status: "available",
          github: {
            slug: "bragaru-i/zamolxis",
            tokenUrl:
              "https://github.com/settings/personal-access-tokens/new?target_name=bragaru-i",
          },
          githubAccess: { status: "ok", login: "bragaru-i", checkedAt: NOW - 1000 },
        },
        {
          repositoryLocationId: "l2",
          repositoryName: "site",
          canonicalPath: "/Users/me/Projects/site",
          status: "available",
          github: {
            slug: "wellcopy/site",
            tokenUrl: "https://github.com/settings/personal-access-tokens/new?target_name=wellcopy",
          },
        },
      ],
    };
    const html = render({ initialMode: "repositories" });
    expect(html).toContain("GitHub: publishing as bragaru-i");
    expect(html).toContain("GitHub not connected");
    expect(html).toContain("Create a token on GitHub");
  });

  it("explains a refused removal in plain language", () => {
    expect(explainMacError(new ConvexError({ code: "LOCATION_BUSY" }), "x")).toContain(
      "still running",
    );
    expect(explainMacError(new Error("boom"), "Could not rename this Mac.")).toBe(
      "Could not rename this Mac.",
    );
  });
});
