"use client";
import { Button, Notice, StatusBadge, TextInput } from "@zamolxis/ui";
import { useMutation, useQuery } from "convex/react";
import { useId, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { errorCode, explainError } from "./errors";

export type Role = "supervisor" | "builder" | "verifier" | "repair" | "integration";

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
  updatedAt: number;
}
interface Product {
  _id: Id<"products">;
  name: string;
}
interface DeviceRuntimes {
  status: string;
  runtimes: Array<{ runtime: string; status: string }>;
}

export const ROLES: Array<{ role: Role; label: string; help: string }> = [
  { role: "supervisor", label: "Supervisor", help: "Answers, plans or asks you a question." },
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
    profile.runtime,
    profile.model ?? "default model",
    profile.reasoningEffort ? `${profile.reasoningEffort} effort` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

const PROFILE_ERRORS: Record<string, string> = {
  AGENT_PROFILE_CONFLICT:
    "Another profile is already on for this role here. Turn that one off first, then try again.",
  INVALID_ARGUMENT: "Choose a runtime before saving.",
  PRODUCT_MISMATCH: "This product no longer exists or was archived.",
  LIMIT_EXCEEDED: "You have reached the limit of 100 agent profiles.",
  NOT_FOUND: "This profile no longer exists. Close Settings and try again.",
};

export function explainProfileError(error: unknown): string {
  const code = errorCode(error);
  return (code && PROFILE_ERRORS[code]) ?? explainError(error, "Could not save the profile.");
}

/** Arguments for `agentProfiles.upsert`; empty model/effort mean the runtime default. */
export function upsertArgs(input: {
  role: Role;
  name: string;
  productId: Id<"products"> | undefined;
  existing: Profile | undefined;
  runtime: string;
  model: string;
  effort: string;
  enabled: boolean;
}) {
  const { existing } = input;
  return {
    ...(existing ? { profileId: existing._id } : {}),
    ...(input.productId ? { productId: input.productId } : {}),
    name: existing?.name ?? input.name,
    role: input.role,
    runtime: input.runtime,
    ...(input.model.trim() ? { model: input.model.trim() } : {}),
    ...(input.effort ? { reasoningEffort: input.effort } : {}),
    enabled: input.enabled,
    // Keep the owner-wide concurrency limit; this editor does not change it.
    ...(existing?.maxConcurrency !== undefined ? { maxConcurrency: existing.maxConcurrency } : {}),
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
    <section className="z-stack" aria-label="Agents">
      <h3 className="z-section-title">Agents</h3>
      <p className="z-xsmall z-muted">
        Changes apply to new runs. Running and past runs keep the settings they started with.
      </p>
      {products && products.length > 0 && (
        <label className="z-field">
          Applies to
          <select
            className="z-select"
            value={scope}
            onChange={(event) => {
              setScope(event.target.value);
              setEditing(undefined);
            }}
          >
            <option value="">All products</option>
            {products.map((product) => (
              <option key={product._id} value={product._id}>
                {product.name}
              </option>
            ))}
          </select>
        </label>
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
                  ) : (
                    <StatusBadge status="completed" label="Custom" />
                  )}
                </div>
                <span className="z-xsmall z-muted">{help}</span>
                <span className="z-small">
                  {shown ? describeProfile(shown) : `${DEFAULT_RUNTIME} · default model`}
                </span>
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
                    {own ? "Edit" : productId ? `Set for ${scopeName}` : "Set up"}
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
  const modelId = useId();
  const [runtime, setRuntime] = useState(prefill?.runtime ?? runtimes[0] ?? DEFAULT_RUNTIME);
  const [model, setModel] = useState(prefill?.model ?? "");
  const [effort, setEffort] = useState(prefill?.reasoningEffort ?? "");
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const efforts = effort && !EFFORTS.includes(effort) ? [...EFFORTS, effort] : EFFORTS;
  const save = async (nextEnabled: boolean) => {
    setBusy(true);
    setProblem("");
    try {
      await upsert(
        upsertArgs({
          role,
          name: `${label} · ${scopeName}`,
          productId,
          existing,
          runtime,
          model,
          effort,
          enabled: nextEnabled,
        }),
      );
      onDone();
    } catch (error) {
      setProblem(explainProfileError(error));
    } finally {
      setBusy(false);
    }
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
      <label className="z-field">
        Runtime
        <select
          className="z-select"
          value={runtime}
          onChange={(event) => setRuntime(event.target.value)}
        >
          {runtimes.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      </label>
      <label className="z-field" htmlFor={modelId}>
        Model
        <TextInput
          id={modelId}
          value={model}
          maxLength={128}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={
            runtime === "codex" ? "Runtime default, e.g. gpt-5-codex" : "Runtime default"
          }
          onChange={(event) => setModel(event.target.value)}
        />
      </label>
      <label className="z-field">
        Reasoning effort
        <select
          className="z-select"
          value={effort}
          onChange={(event) => setEffort(event.target.value)}
        >
          <option value="">Runtime default</option>
          {efforts.map((choice) => (
            <option key={choice} value={choice}>
              {choice[0]?.toUpperCase()}
              {choice.slice(1)}
            </option>
          ))}
        </select>
      </label>
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
        <Button variant="ghost" size="small" disabled={busy} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
