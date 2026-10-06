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
  concurrencyProblem,
  describeProfile,
  effectiveProfile,
  explainProfileError,
  INSTRUCTIONS_LIMIT,
  instructionsPreview,
  instructionsProblem,
  type Profile,
  ProfileEditor,
  profileNameProblem,
  runtimeChoices,
  runtimeLabel,
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

  it("offers Claude when a Mac reports it, labelled Claude", () => {
    const choices = runtimeChoices([
      {
        status: "online",
        runtimes: [
          { runtime: "codex", status: "available" },
          { runtime: "claude", status: "available" },
        ],
      },
    ]);
    expect(choices).toEqual(["claude", "codex"]);
    expect(choices.map(runtimeLabel)).toEqual(["Claude", "Codex"]);
    expect(describeProfile({ runtime: "claude", model: "claude-haiku-4-5" })).toContain("Claude");
    expect(runtimeLabel("hermes")).toBe("Hermes");
  });

  it("builds upsert arguments with the edited name and concurrency, inventing nothing", () => {
    const existing = profile({ name: "Mine", maxConcurrency: 2 });
    expect(
      upsertArgs({
        role: "builder",
        name: "  Fast builders ",
        productId: undefined,
        existing,
        runtime: "codex",
        model: "  ",
        effort: "",
        enabled: false,
        maxConcurrency: " 4 ",
      }),
    ).toEqual({
      profileId: existing._id,
      name: "Fast builders",
      role: "builder",
      runtime: "codex",
      enabled: false,
      maxConcurrency: 4,
    });
    // An empty limit clears it.
    expect(
      upsertArgs({
        role: "builder",
        name: "Mine",
        productId: undefined,
        existing,
        runtime: "codex",
        model: "",
        effort: "",
        enabled: true,
        maxConcurrency: "",
      }),
    ).not.toHaveProperty("maxConcurrency");
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
        maxConcurrency: "",
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

  it("sends trimmed instructions, clears them when empty and keeps them when omitted", () => {
    const base = {
      role: "builder" as const,
      name: "Mine",
      productId: undefined,
      existing: undefined,
      runtime: "codex",
      model: "",
      effort: "",
      enabled: true,
      maxConcurrency: "",
    };
    expect(upsertArgs({ ...base, instructions: "  Run pnpm lint.\n" })).toMatchObject({
      instructions: "Run pnpm lint.",
    });
    expect(upsertArgs({ ...base, instructions: "   " })).toMatchObject({ instructions: "" });
    expect(upsertArgs(base)).not.toHaveProperty("instructions");
  });

  it("bounds and previews instructions like the backend", () => {
    expect(instructionsProblem(` ${"x".repeat(INSTRUCTIONS_LIMIT)} `)).toBeUndefined();
    expect(instructionsProblem("x".repeat(INSTRUCTIONS_LIMIT + 1))).toContain("4000");
    expect(instructionsPreview(undefined)).toBeUndefined();
    expect(instructionsPreview("  \n ")).toBeUndefined();
    expect(instructionsPreview("Run lint.\n\nKeep commits small.")).toBe(
      "Run lint. Keep commits small.",
    );
    const long = instructionsPreview("word ".repeat(40));
    expect(long?.length).toBeLessThanOrEqual(80);
    expect(long?.endsWith("…")).toBe(true);
  });

  it("validates names and concurrency like the backend", () => {
    expect(profileNameProblem(" ")).toBe("Enter a name.");
    expect(profileNameProblem("x".repeat(65))).toContain("64");
    expect(profileNameProblem("Builder")).toBeUndefined();
    for (const bad of ["0", "33", "1.5", "-1", "two"])
      expect(concurrencyProblem(bad)).toContain("1 to 32");
    for (const good of ["", " ", "1", "32"]) expect(concurrencyProblem(good)).toBeUndefined();
  });

  it("explains profile errors in plain language", () => {
    expect(explainProfileError(new ConvexError({ code: "AGENT_PROFILE_CONFLICT" }))).toContain(
      "Turn that one off first",
    );
    expect(explainProfileError(new ConvexError({ code: "PRODUCT_MISMATCH" }))).toContain(
      "archived",
    );
    expect(explainProfileError(new ConvexError({ code: "AGENT_PROFILE_IN_USE" }))).toContain(
      "still active",
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
    expect(html).toContain("Codex · gpt-5-codex · high effort");
    expect(html).toContain("Custom");
    expect(html).toContain("Codex · default model");
    expect(html).toContain("Your All products profile is off.");
    expect(html).toContain("Orchestration");
    expect(html).toContain("without opening work");
    expect(html).toContain("Changes apply to new runs.");
    expect(html).not.toContain("Instructions:");
    // No products yet: no scope picker.
    expect(html).not.toContain("Applies to");
  });

  it("previews the effective profile's instructions", () => {
    state.data = {
      "supervisor:products": [],
      "agentProfiles:list": [profile({ instructions: "Always run pnpm lint before finishing." })],
    };
    const html = renderToStaticMarkup(createElement(AgentsSettings, { active: true, devices: [] }));
    expect(html).toContain("Instructions: Always run pnpm lint before finishing.");
  });

  it("offers a product scope when products exist", () => {
    state.data = {
      "supervisor:products": [{ _id: product, name: "App" }],
      "agentProfiles:list": [],
    };
    const html = renderToStaticMarkup(createElement(AgentsSettings, { active: true, devices: [] }));
    expect(html).toContain("Applies to");
    expect(html).toMatch(/role="option" aria-selected="false"[^>]*>.*?App</);
  });
});

describe("ProfileEditor", () => {
  it("offers the models the Mac reports with only their efforts", () => {
    state.data = {
      "agentProfiles:models": [
        {
          runtime: "codex",
          models: [
            {
              id: "gpt-6.1-sol",
              displayName: "GPT-6.1-Sol",
              description: "Latest workhorse model.",
              isDefault: true,
              efforts: ["low", "medium", "high", "xhigh"],
            },
            { id: "gpt-6-astra", displayName: "GPT-6-Astra", efforts: ["low", "max"] },
          ],
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(ProfileEditor, {
        role: "supervisor",
        label: "Supervisor",
        scopeName: "App",
        productId: undefined,
        existing: undefined,
        prefill: profile({ role: "supervisor", model: "gpt-6-astra", reasoningEffort: "max" }),
        runtimes: ["codex"],
        onDone: () => {},
      }),
    );
    expect(html).toMatch(/class="z-picker__value">GPT-6-Astra</);
    expect(html).toContain("Currently GPT-6.1-Sol.");
    expect(html).toContain("Latest workhorse model.");
    // Efforts follow the chosen model, not a fixed list.
    expect(html).toContain("Deepest thinking, slowest.");
    expect(html).not.toContain(">Medium<");
    expect(html).not.toContain("Max concurrent runs");
    expect(html).not.toContain('placeholder="Default model"');
  });

  it("keeps a text field until a Mac reports models", () => {
    state.data = {};
    const html = renderToStaticMarkup(
      createElement(ProfileEditor, {
        role: "builder",
        label: "Builder",
        scopeName: "App",
        productId: undefined,
        existing: undefined,
        prefill: undefined,
        runtimes: ["codex"],
        onDone: () => {},
      }),
    );
    expect(html).toContain('placeholder="Default model"');
    expect(html).toContain("Your Mac lists the available models");
  });

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
    // Pickers show the chosen value and mark it in their option sheet.
    expect(html).toMatch(/class="z-picker__value">Codex</);
    expect(html).toMatch(/class="z-picker__value">Minimal</);
    expect(html).toMatch(
      /aria-selected="true"[^>]*><span class="z-picker__text"><span class="z-picker__label">Minimal</,
    );
    expect(html).toContain("Let the model decide.");
    expect(html).toContain("Turn off");
    expect(html).toContain("Use this profile for App");
    // A product override can be removed; its name and limit are editable.
    expect(html).toContain("Remove override");
    expect(html).toContain('value="Builder"');
    expect(html).toContain("Max concurrent runs");
    expect(html).toContain("Instructions");
    expect(html).toContain("0 / 4000 characters");
    expect(html).toContain("never overrides Zamolxis trust, approval or sandbox rules");
  });

  it("prefills instructions with their character count", () => {
    const html = renderToStaticMarkup(
      createElement(ProfileEditor, {
        role: "supervisor",
        label: "Supervisor",
        scopeName: "All products",
        productId: undefined,
        existing: profile({ role: "supervisor", instructions: "Plan small tasks." }),
        prefill: profile({ role: "supervisor", instructions: "Plan small tasks." }),
        runtimes: ["codex"],
        onDone: () => {},
      }),
    );
    expect(html).toMatch(/<textarea[^>]*maxLength="4000"[^>]*>Plan small tasks\.<\/textarea>/);
    expect(html).toContain("17 / 4000 characters");
  });

  it("prefills the concurrency limit and never offers removal for All products", () => {
    const html = renderToStaticMarkup(
      createElement(ProfileEditor, {
        role: "builder",
        label: "Builder",
        scopeName: "All products",
        productId: undefined,
        existing: profile({ name: "Global builder", maxConcurrency: 3 }),
        prefill: profile({ name: "Global builder", maxConcurrency: 3 }),
        runtimes: ["codex"],
        onDone: () => {},
      }),
    );
    expect(html).toContain('value="Global builder"');
    expect(html).toContain('value="3"');
    expect(html).not.toContain("Remove override");
  });

  it("names a new override after the role and product", () => {
    const html = renderToStaticMarkup(
      createElement(ProfileEditor, {
        role: "verifier",
        label: "Verifier",
        scopeName: "App",
        productId: product,
        existing: undefined,
        prefill: profile({ role: "verifier" }),
        runtimes: ["codex"],
        onDone: () => {},
      }),
    );
    expect(html).toContain('value="Verifier · App"');
    expect(html).toContain('placeholder="No limit"');
    expect(html).not.toContain("Remove override");
  });
});
