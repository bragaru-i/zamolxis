"use client";
import { Button, Notice, Picker, StatusBadge, TextInput } from "@zamolxis/ui";
import { useMutation, useQuery } from "convex/react";
import { useId, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { errorCode, explainError } from "./errors";

export type Role =
  | "orchestrator"
  | "supervisor"
  | "builder"
  | "verifier"
  | "repair"
  | "integration";

export interface Profile {
  _id: Id<"agentProfiles">;
  productId?: Id<"products">;
  name: string;
  role: Role;
  runtime: string;
  model?: string;
  reasoningEffort?: string;
  enabled: boolean;
  maxConcurrency?: number;
  instructions?: string;
  instructionsDigest?: string;
  updatedAt: number;
}
interface Product {
  _id: Id<"products">;
  name: string;
}
interface RuntimeModels {
  runtime: string;
  models: Array<{
    id: string;
    displayName: string;
    description?: string;
    isDefault?: boolean;
    efforts?: string[];
    defaultEffort?: string;
  }>;
}
interface DeviceRuntimes {
  status: string;
  runtimes: Array<{ runtime: string; status: string }>;
}

export const ROLES: Array<{ role: Role; label: string; help: string }> = [
  {
    role: "orchestrator",
    label: "Orchestrator",
    help: "Writes replies in the home conversation from current Sessions, approvals and runs. It only talks: work starts in a Session when you ask for it or open a proposal. Without a connected Mac, Zamolxis answers without a model.",
  },
  {
    role: "supervisor",
    label: "Supervisor",
    help: "Your conversational project lead. It answers, summarizes and proposes work; execution starts only when you explicitly delegate.",
  },
  { role: "builder", label: "Builder", help: "Implements each task." },
  { role: "verifier", label: "Verifier", help: "Checks each result independently." },
  { role: "repair", label: "Repair", help: "Fixes results that failed verification." },
  {
    role: "integration",
    label: "Integration",
    help: "Saved for later; integration runs without an agent in Alpha.",
  },
];
const EFFORTS = ["low", "medium", "high"];
const EFFORT_HELP: Record<string, string> = {
  minimal: "Quickest, almost no extra thinking.",
  low: "Fastest replies, lighter thinking.",
  medium: "Balanced speed and depth.",
  high: "Slower, for complex problems.",
  xhigh: "Even deeper thinking, slower.",
  max: "Deepest thinking, slowest.",
};
// Only roles that start runs can be limited in how many run at once.
const RUN_ROLES: readonly Role[] = ["builder", "verifier", "repair"];
export function runtimeLabel(runtime: string): string {
  return runtime === "codex" ? "Codex" : runtime[0]?.toUpperCase() + runtime.slice(1);
}
function effortLabel(effort: string): string {
  return effort === "xhigh" ? "Extra high" : effort[0]?.toUpperCase() + effort.slice(1);
}
/** The backend's built-in runtime when no enabled profile applies. */
export const DEFAULT_RUNTIME = "codex";

/** The profile a scope owns for a role: its enabled one, else the most recently edited. */
export function scopeProfile(role: Role, rows: Profile[]): Profile | undefined {
  const own = rows.filter((row) => row.role === role);
  return own.find((row) => row.enabled) ?? [...own].sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

/** Mirrors backend resolution: enabled product profile, then enabled global, then default. */
export function effectiveProfile(
  role: Role,
  product: Profile[] | undefined,
  global: Profile[],
): { profile?: Profile; source: "product" | "global" | "default" } {
  const enabled = (rows: Profile[]) => rows.find((row) => row.role === role && row.enabled);
  const fromProduct = product ? enabled(product) : undefined;
  if (fromProduct) return { profile: fromProduct, source: "product" };
  const fromGlobal = enabled(global);
  if (fromGlobal) return { profile: fromGlobal, source: "global" };
  return { source: "default" };
}

/** Runtimes reported by the user's Macs, plus the current value so it stays selectable. */
export function runtimeChoices(devices: DeviceRuntimes[] | undefined, current?: string) {
  const choices = new Set<string>();
  for (const device of devices ?? []) {
    if (device.status === "revoked") continue;
    for (const runtime of device.runtimes) choices.add(runtime.runtime);
  }
  if (current) choices.add(current);
  if (!choices.size) choices.add(DEFAULT_RUNTIME);
  return [...choices].sort();
}

export function describeProfile(profile: Pick<Profile, "runtime" | "model" | "reasoningEffort">) {
  return [
    runtimeLabel(profile.runtime),
    profile.model ?? "default model",
    profile.reasoningEffort
      ? `${effortLabel(profile.reasoningEffort).toLowerCase()} effort`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Mirrors the backend bound on owner instructions (#48). */
export const INSTRUCTIONS_LIMIT = 4000;
export function instructionsProblem(value: string): string | undefined {
  return value.trim().length > INSTRUCTIONS_LIMIT
    ? `Use at most ${INSTRUCTIONS_LIMIT} characters of instructions.`
    : undefined;
}
/** A one-line preview of stored instructions for the profile summary. */
export function instructionsPreview(text: string | undefined, limit = 80): string | undefined {
  const line = text?.replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

const PROFILE_ERRORS: Record<string, string> = {
  AGENT_PROFILE_CONFLICT:
    "Another profile is already on for this role here. Turn that one off first, then try again.",
  INVALID_ARGUMENT:
    "Check the profile: a name of 1 to 64 characters, a runtime, at most 32 concurrent runs and at most 4000 characters of instructions.",
  AGENT_PROFILE_IN_USE:
    "Runs started with this override are still active. Remove it once they have finished.",
  INVALID_STATE:
    "Only a product override can be removed; turn the All products profile off instead.",
  PRODUCT_MISMATCH: "This product no longer exists or was archived.",
  LIMIT_EXCEEDED: "You have reached the limit of 100 agent profiles.",
  NOT_FOUND: "This profile no longer exists. Close Settings and try again.",
};

export function explainProfileError(error: unknown): string {
  const code = errorCode(error);
  return (code && PROFILE_ERRORS[code]) ?? explainError(error, "Could not save the profile.");
}

/** Mirrors the backend bounds: a trimmed name of 1..64 characters. */
export function profileNameProblem(value: string): string | undefined {
  const name = value.trim();
  if (!name) return "Enter a name.";
  if (name.length > 64) return "Use at most 64 characters.";
  return undefined;
}
/** Empty means no limit; otherwise a whole number from 1 to 32. */
export function concurrencyProblem(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 32)
    return "Use a whole number from 1 to 32, or leave it empty for no limit.";
  return undefined;
}

/**
 * Arguments for `agentProfiles.upsert`; empty model/effort mean the runtime default and
 * an empty concurrency means no limit (clearing an existing one). Instructions, when given,
 * are sent trimmed; an empty value clears them.
 */
export function upsertArgs(input: {
  role: Role;
  name: string;
  productId: Id<"products"> | undefined;
  existing: Profile | undefined;
  runtime: string;
  model: string;
  effort: string;
  enabled: boolean;
  maxConcurrency: string;
  instructions?: string;
}) {
  const { existing } = input;
  const concurrency = input.maxConcurrency.trim();
  return {
    ...(existing ? { profileId: existing._id } : {}),
    ...(input.productId ? { productId: input.productId } : {}),
    name: input.name.trim(),
    role: input.role,
    runtime: input.runtime,
    ...(input.model.trim() ? { model: input.model.trim() } : {}),
    ...(input.effort ? { reasoningEffort: input.effort } : {}),
    enabled: input.enabled,
    ...(concurrency ? { maxConcurrency: Number(concurrency) } : {}),
    ...(input.instructions !== undefined ? { instructions: input.instructions.trim() } : {}),
  };
}

export function AgentsSettings({
  active,
  devices,
}: {
  active: boolean;
  devices: DeviceRuntimes[] | undefined;
}) {
  const [scope, setScope] = useState("");
  const [editing, setEditing] = useState<Role>();
  const products = useQuery(api.supervisor.products, active ? {} : "skip") as Product[] | undefined;
  const global = useQuery(api.agentProfiles.list, active ? {} : "skip") as Profile[] | undefined;
  const productId = scope ? (scope as Id<"products">) : undefined;
  const scoped = useQuery(api.agentProfiles.list, active && productId ? { productId } : "skip") as
    | Profile[]
    | undefined;
  const scopeRows = productId ? scoped : global;
  const scopeName = products?.find((product) => product._id === productId)?.name ?? "All products";
  return (
    <section className="z-stack" aria-label="Orchestration">
      <h3 className="z-section-title">Orchestration</h3>
      <p className="z-small z-muted">
        Ask the Supervisor about the project without opening work. When you explicitly delegate,
        Builders implement, the Verifier checks the exact result, Repair handles failed checks and
        Integration prepares trusted changes.
      </p>
      <p className="z-xsmall z-muted">
        Changes apply to new runs. Running and past runs keep the settings they started with.
      </p>
      {products && products.length > 0 && (
        <Picker
          label="Applies to"
          value={scope}
          options={[
            { value: "", label: "All products" },
            ...products.map((product) => ({ value: product._id, label: product.name })),
          ]}
          onChange={(value) => {
            setScope(value);
            setEditing(undefined);
          }}
        />
      )}
      {productId && (
        <p className="z-xsmall z-muted">
          Roles you set here override All products for {scopeName} only. Remove an override to go
          back to All products.
        </p>
      )}
      {global === undefined || scopeRows === undefined ? (
        <p className="z-muted z-small" role="status">
          Loading agents…
        </p>
      ) : (
        <div className="z-list">
          {ROLES.map(({ role, label, help }) => {
            const effective = effectiveProfile(role, productId ? scopeRows : undefined, global);
            const own = scopeProfile(role, scopeRows);
            const shown = effective.profile;
            return (
              <div className="z-list-item" key={role}>
                <div className="z-row">
                  <span className="z-list-item__title">{label}</span>
                  <span className="z-spacer" />
                  {effective.source === "default" ? (
                    <StatusBadge status="planned" label="Default" />
                  ) : productId && effective.source === "product" ? (
                    <StatusBadge status="completed" label="Override" />
                  ) : (
                    <StatusBadge status="completed" label="Custom" />
                  )}
                </div>
                <span className="z-xsmall z-muted">{help}</span>
                <span className="z-small">
                  {shown
                    ? describeProfile(shown)
                    : `${runtimeLabel(DEFAULT_RUNTIME)} · default model`}
                  {shown?.maxConcurrency ? ` · up to ${shown.maxConcurrency} at once` : ""}
                </span>
                {shown && <span className="z-xsmall z-muted">{shown.name}</span>}
                {instructionsPreview(shown?.instructions) && (
                  <span className="z-xsmall z-muted" title={shown?.instructions}>
                    Instructions: {instructionsPreview(shown?.instructions)}
                  </span>
                )}
                {(own && !own.enabled) || (productId && effective.source !== "product") ? (
                  <span className="z-xsmall z-muted">
                    {own && !own.enabled ? `Your ${scopeName} profile is off. ` : ""}
                    {effective.source === "global" && productId
                      ? "Using All products."
                      : effective.source === "default"
                        ? "Using the built-in default."
                        : ""}
                  </span>
                ) : null}
                {editing === role ? (
                  <ProfileEditor
                    role={role}
                    label={label}
                    scopeName={scopeName}
                    productId={productId}
                    existing={own}
                    prefill={own ?? shown}
                    runtimes={runtimeChoices(devices, (own ?? shown)?.runtime)}
                    onDone={() => setEditing(undefined)}
                  />
                ) : (
                  <Button variant="ghost" size="small" onClick={() => setEditing(role)}>
                    {own
                      ? productId
                        ? "Edit override"
                        : "Edit"
                      : productId
                        ? `Override for ${scopeName}`
                        : "Set up"}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function ProfileEditor({
  role,
  label,
  scopeName,
  productId,
  existing,
  prefill,
  runtimes,
  onDone,
}: {
  role: Role;
  label: string;
  scopeName: string;
  productId: Id<"products"> | undefined;
  existing: Profile | undefined;
  prefill: Profile | undefined;
  runtimes: string[];
  onDone: () => void;
}) {
  const upsert = useMutation(api.agentProfiles.upsert);
  const removeOverride = useMutation(api.agentProfiles.removeOverride);
  const modelId = useId();
  const nameId = useId();
  const concurrencyId = useId();
  const instructionsId = useId();
  const instructionsHelpId = useId();
  const [name, setName] = useState(existing?.name ?? `${label} · ${scopeName}`);
  const [concurrency, setConcurrency] = useState(
    existing?.maxConcurrency !== undefined ? String(existing.maxConcurrency) : "",
  );
  const [runtime, setRuntime] = useState(prefill?.runtime ?? runtimes[0] ?? DEFAULT_RUNTIME);
  const [model, setModel] = useState(prefill?.model ?? "");
  const [effort, setEffort] = useState(prefill?.reasoningEffort ?? "");
  const [instructions, setInstructions] = useState(prefill?.instructions ?? "");
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  // The models this runtime reports on the owner's Macs; empty until a Mac reports them.
  const catalogs = useQuery(api.agentProfiles.models, {}) as RuntimeModels[] | undefined;
  const catalog = catalogs?.find((item) => item.runtime === runtime)?.models ?? [];
  const chosen = catalog.find((item) => item.id === model);
  const defaultModel = catalog.find((item) => item.isDefault);
  const modelOptions = [
    {
      value: "",
      label: "Default",
      description: defaultModel ? `Currently ${defaultModel.displayName}.` : "The agent's default.",
    },
    ...catalog.map((item) => ({
      value: item.id,
      label: item.displayName,
      ...(item.description ? { description: item.description } : {}),
    })),
    // A saved model the Macs no longer report stays visible instead of silently changing.
    ...(model && !chosen
      ? [{ value: model, label: model, description: "Not reported by your Mac right now." }]
      : []),
  ];
  const offered = (chosen ?? (model ? undefined : defaultModel))?.efforts;
  const baseEfforts = offered?.length ? offered : EFFORTS;
  const efforts = effort && !baseEfforts.includes(effort) ? [...baseEfforts, effort] : baseEfforts;
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setProblem("");
    try {
      await action();
      onDone();
    } catch (error) {
      setProblem(explainProfileError(error));
    } finally {
      setBusy(false);
    }
  };
  const save = async (nextEnabled: boolean) => {
    const invalid =
      profileNameProblem(name) ??
      concurrencyProblem(concurrency) ??
      instructionsProblem(instructions);
    if (invalid) return setProblem(invalid);
    await run(() =>
      upsert(
        upsertArgs({
          role,
          name,
          productId,
          existing,
          runtime,
          model,
          effort,
          enabled: nextEnabled,
          maxConcurrency: concurrency,
          instructions,
        }),
      ),
    );
  };
  return (
    <form
      className="z-stack"
      aria-label={`${label} profile for ${scopeName}`}
      onSubmit={(event) => {
        event.preventDefault();
        void save(enabled);
      }}
    >
      <label className="z-field" htmlFor={nameId}>
        Name
        <TextInput
          id={nameId}
          value={name}
          maxLength={64}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <Picker
        label="Agent"
        value={runtime}
        options={runtimes.map((choice) => ({ value: choice, label: runtimeLabel(choice) }))}
        onChange={setRuntime}
      />
      {catalog.length ? (
        <Picker
          label="Model"
          value={model}
          options={modelOptions}
          onChange={(next) => {
            setModel(next);
            const supported = catalog.find((item) => item.id === next)?.efforts;
            if (effort && supported && !supported.includes(effort)) setEffort("");
          }}
        />
      ) : (
        <label className="z-field" htmlFor={modelId}>
          Model
          <TextInput
            id={modelId}
            value={model}
            maxLength={128}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Default model"
            onChange={(event) => setModel(event.target.value)}
          />
          <span className="z-xsmall z-muted">
            Your Mac lists the available models once it is online with the latest Zamolxis.
          </span>
        </label>
      )}
      <Picker
        label="Thinking effort"
        value={effort}
        options={[
          { value: "", label: "Default", description: "Let the model decide." },
          ...efforts.map((choice) => ({
            value: choice,
            label: effortLabel(choice),
            ...(EFFORT_HELP[choice] ? { description: EFFORT_HELP[choice] } : {}),
          })),
        ]}
        onChange={setEffort}
      />
      {RUN_ROLES.includes(role) && (
        <label className="z-field" htmlFor={concurrencyId}>
          Max concurrent runs
          <TextInput
            id={concurrencyId}
            value={concurrency}
            inputMode="numeric"
            maxLength={2}
            placeholder="No limit"
            onChange={(event) => setConcurrency(event.target.value)}
          />
        </label>
      )}
      <label className="z-field" htmlFor={instructionsId}>
        Instructions
        <textarea
          id={instructionsId}
          className="z-textarea"
          style={{ padding: "8px", resize: "vertical" }}
          rows={3}
          maxLength={INSTRUCTIONS_LIMIT}
          aria-describedby={instructionsHelpId}
          placeholder="Optional, e.g. Always run pnpm lint before finishing; prefer small focused commits."
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </label>
      <span className="z-xsmall z-muted" id={instructionsHelpId}>
        {instructions.trim().length} / {INSTRUCTIONS_LIMIT} characters. Added to this role&apos;s
        prompt for new runs; it never overrides Zamolxis trust, approval or sandbox rules. Secrets
        are removed when you save.
      </span>
      <label className="z-check">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        Use this profile for {scopeName}
      </label>
      {problem && <Notice tone="danger">{problem}</Notice>}
      <div className="z-row">
        <Button type="submit" size="small" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
        {existing?.enabled && (
          <Button variant="secondary" size="small" disabled={busy} onClick={() => void save(false)}>
            Turn off
          </Button>
        )}
        {existing && productId && (
          <Button
            variant="danger"
            size="small"
            disabled={busy}
            onClick={() => void run(() => removeOverride({ profileId: existing._id }))}
          >
            Remove override
          </Button>
        )}
        <Button variant="ghost" size="small" disabled={busy} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
