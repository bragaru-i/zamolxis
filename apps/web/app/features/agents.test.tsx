import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../../../convex/_generated/dataModel";

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

import {
  AgentsSettings,
  effectiveProfile,
  explainProfileError,
  type Profile,
  ProfileEditor,
  runtimeChoices,
  scopeProfile,
  upsertArgs,
} from "./agents";

const product = "p1" as Id<"products">;
function profile(overrides: Partial<Profile>): Profile {
  return {
    _id: `a${Math.random()}` as Id<"agentProfiles">,
    name: "Builder",
    role: "builder",
    runtime: "codex",
    enabled: true,
    updatedAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  state.data = {};
  state.calls = [];
});

describe("profile resolution", () => {
  it("prefers the enabled product profile, then global, then the default", () => {
    const global = [profile({ model: "gpt-5" })];
    const scoped = [profile({ productId: product, model: "gpt-5-mini" })];
    expect(effectiveProfile("builder", scoped, global)).toMatchObject({
      source: "product",
      profile: { model: "gpt-5-mini" },
    });
    expect(
      effectiveProfile("builder", [profile({ productId: product, enabled: false })], global),
    ).toMatchObject({ source: "global", profile: { model: "gpt-5" } });
    expect(effectiveProfile("verifier", scoped, global)).toEqual({ source: "default" });
    expect(effectiveProfile("builder", undefined, [])).toEqual({ source: "default" });
  });

  it("picks the scope's enabled profile, else its latest edit", () => {
    const old = profile({ enabled: false, updatedAt: 1, model: "old" });
    const recent = profile({ enabled: false, updatedAt: 5, model: "recent" });
    expect(scopeProfile("builder", [old, recent])?.model).toBe("recent");
    const on = profile({ updatedAt: 0, model: "on" });
    expect(scopeProfile("builder", [old, on, recent])?.model).toBe("on");
    expect(scopeProfile("repair", [on])).toBeUndefined();
  });

  it("offers runtimes reported by active Macs plus the current one", () => {
    expect(runtimeChoices(undefined)).toEqual(["codex"]);
    expect(
      runtimeChoices(
        [
          { status: "online", runtimes: [{ runtime: "codex", status: "available" }] },
          { status: "revoked", runtimes: [{ runtime: "hermes", status: "available" }] },
        ],
        "claude",
      ),
    ).toEqual(["claude", "codex"]);
  });

  it("builds upsert arguments without dropping concurrency or inventing values", () => {
    const existing = profile({ name: "Mine", maxConcurrency: 2 });
    expect(
      upsertArgs({
        role: "builder",
        name: "Builder · All products",
        productId: undefined,
        existing,
        runtime: "codex",
        model: "  ",
        effort: "",
        enabled: false,
      }),
    ).toEqual({
      profileId: existing._id,
      name: "Mine",
      role: "builder",
      runtime: "codex",
      enabled: false,
      maxConcurrency: 2,
    });
    expect(
      upsertArgs({
        role: "verifier",
        name: "Verifier · App",
        productId: product,
        existing: undefined,
        runtime: "codex",
        model: " gpt-5 ",
        effort: "high",
        enabled: true,
      }),
    ).toEqual({
      productId: product,
      name: "Verifier · App",
      role: "verifier",
      runtime: "codex",
      model: "gpt-5",
      reasoningEffort: "high",
      enabled: true,
    });
  });

  it("explains profile errors in plain language", () => {
    expect(explainProfileError(new ConvexError({ code: "AGENT_PROFILE_CONFLICT" }))).toContain(
      "Turn that one off first",
    );
    expect(explainProfileError(new ConvexError({ code: "PRODUCT_MISMATCH" }))).toContain(
      "archived",
    );
    expect(explainProfileError(new Error("boom"))).toBe("Could not save the profile.");
  });
});

describe("AgentsSettings", () => {
  it("does not query while Settings is closed", () => {
    const html = renderToStaticMarkup(
      createElement(AgentsSettings, { active: false, devices: undefined }),
    );
    expect(html).toContain("Loading agents…");
    expect(state.calls.every((call) => call.args === "skip")).toBe(true);
  });

  it("lists every role with its effective profile", () => {
    state.data = {
      "supervisor:products": [],
      "agentProfiles:list": [
        profile({ model: "gpt-5-codex", reasoningEffort: "high" }),
        profile({ role: "repair", enabled: false, model: "x" }),
      ],
    };
    const html = renderToStaticMarkup(createElement(AgentsSettings, { active: true, devices: [] }));
    for (const label of ["Supervisor", "Builder", "Verifier", "Repair", "Integration"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("codex · gpt-5-codex · high effort");
    expect(html).toContain("Custom");
    expect(html).toContain("codex · default model");
    expect(html).toContain("Your All products profile is off.");
    expect(html).toContain("Changes apply to new runs.");
    // No products yet: no scope picker.
    expect(html).not.toContain("Applies to");
  });

  it("offers a product scope when products exist", () => {
    state.data = {
      "supervisor:products": [{ _id: product, name: "App" }],
      "agentProfiles:list": [],
    };
    const html = renderToStaticMarkup(createElement(AgentsSettings, { active: true, devices: [] }));
    expect(html).toContain("Applies to");
    expect(html).toContain(">App</option>");
  });
});

describe("ProfileEditor", () => {
  it("prefills the current values and keeps unknown efforts selectable", () => {
    const html = renderToStaticMarkup(
      createElement(ProfileEditor, {
        role: "builder",
        label: "Builder",
        scopeName: "App",
        productId: product,
        existing: profile({ model: "gpt-5", reasoningEffort: "minimal" }),
        prefill: profile({ model: "gpt-5", reasoningEffort: "minimal" }),
        runtimes: ["claude", "codex"],
        onDone: () => {},
      }),
    );
    expect(html).toContain('value="gpt-5"');
    expect(html).toContain('<option value="codex" selected="">codex</option>');
    expect(html).toContain('<option value="minimal" selected="">Minimal</option>');
    expect(html).toContain("Runtime default");
    expect(html).toContain("Turn off");
    expect(html).toContain("Use this profile for App");
  });
});
