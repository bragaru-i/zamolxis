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
  /** Which command approvals the backend grants for this role; absent means ask. */
  approvalPolicy?: ApprovalPolicy;
  /** Verifier only: absent means a reviewer model runs before the checks. */
  verification?: Verification;
  /** Backup agents in order, used when the ones before cannot run on that computer. */
  backups?: Backup[];
  /** The saved agent (My agents) this job's settings come from. */
  agentId?: Id<"agentDefinitions">;
  workflowId?: Id<"agentWorkflows">;
  updatedAt: number;
}
export interface Backup {
  runtime: string;
  model?: string;
  reasoningEffort?: string;
}
export const MAX_BACKUPS = 2;
/** "Claude · opus → Codex · gpt-6.1-sol": the agent, then its backups in order. */
export function describeChain(
  profile: Pick<Profile, "runtime" | "model" | "reasoningEffort" | "backups">,
) {
  return [profile, ...(profile.backups ?? [])].map((agent) => describeProfile(agent)).join(" → ");
}
export type Verification = "review" | "checks_only";
export const VERIFICATION_OPTIONS: Array<{
  value: Verification;
  label: string;
  description: string;
}> = [
  {
    value: "review",
    label: "Review and checks",
    description: "A reviewer model reads the change, then the repository's checks run.",
  },
  {
    value: "checks_only",
    label: "Checks only",
    description:
      "No model runs: the repository's typecheck, lint and tests decide. Far cheaper; trust is decided the same way.",
  },
];
export type ApprovalPolicy = "ask" | "auto_low" | "auto_low_medium";
export const APPROVAL_POLICY_OPTIONS: Array<{
  value: ApprovalPolicy;
  label: string;
  description: string;
}> = [
  {
    value: "ask",
    label: "Ask every time",
    description: "Every command the agent cannot run in its sandbox waits for you.",
  },
  {
    value: "auto_low",
    label: "Allow low risk",
    description: "Commands inside the workspace without network run at once.",
  },
  {
    value: "auto_low_medium",
    label: "Allow low and medium risk",
    description:
      "Also commands Codex only flags for their shape (quotes, braces, expansions). High and critical still ask.",
  },
];
export function approvalPolicyLabel(policy: ApprovalPolicy | undefined): string {
  return (
    APPROVAL_POLICY_OPTIONS.find((option) => option.value === (policy ?? "ask"))?.label ??
    "Ask every time"
  );
}
interface Product {
  _id: Id<"products">;
  name: string;
}
export interface RuntimeModels {
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

export const ROLES: Array<{ role: Role; label: string; job: string; help: string }> = [
  {
    role: "orchestrator",
    label: "Orchestrator",
    job: "Chats with you",
    help: "Writes replies in the home conversation from current Sessions, approvals and runs. It only talks: work starts in a Session when you ask for it or open a proposal. Without a connected computer, Zamolxis answers without a model.",
  },
  {
    role: "supervisor",
    label: "Supervisor",
    job: "Plans the work",
    help: "Your conversational project lead. It answers, summarizes and proposes work; execution starts only when you explicitly delegate.",
  },
  {
    role: "builder",
    label: "Builder",
    job: "Writes the code",
    help: "Implements each task in its own copy of the repository.",
  },
  {
    role: "verifier",
    label: "Verifier",
    job: "Checks the result",
    help: "Checks each result independently, in a separate copy, without seeing how it was built.",
  },
  {
    role: "repair",
    label: "Repair",
    job: "Fixes failed checks",
    help: "Fixes results that failed verification. At most two attempts per task.",
  },
  {
    role: "integration",
    label: "Integration",
    job: "Prepares the merge",
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
// Only roles that run commands ask for approvals (the Verifier's requests are always refused).
const APPROVAL_ROLES: readonly Role[] = ["builder", "repair"];
const VERIFICATION_ROLES: readonly Role[] = ["verifier"];
const RUNTIME_LABELS: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  local: "Local model",
  "codex-local": "Codex + local model",
};
/** Runtimes that only write text (a model on the owner's computer): Orchestrator only. */
export const TEXT_ONLY_RUNTIMES: readonly string[] = ["local"];
/** A local model with Codex's tools: it plans and checks, never builds or repairs. */
const READ_ONLY_RUNTIMES: readonly string[] = ["codex-local"];
const READING_ROLES: readonly string[] = ["orchestrator", "supervisor", "verifier"];
export function runtimeOfferedFor(role: Role | undefined, runtime: string): boolean {
  if (TEXT_ONLY_RUNTIMES.includes(runtime)) return role === "orchestrator";
  if (READ_ONLY_RUNTIMES.includes(runtime)) return !!role && READING_ROLES.includes(role);
  return true;
}
export function runtimeLabel(runtime: string | undefined): string {
  if (!runtime) return "Agent";
  return RUNTIME_LABELS[runtime] ?? runtime[0]?.toUpperCase() + runtime.slice(1);
}
function effortLabel(effort: string): string {
  return effort === "xhigh" ? "Extra high" : effort[0]?.toUpperCase() + effort.slice(1);
}
/**
 * The backend's last-resort runtime when no enabled profile applies and nothing is known
 * about the owner's computers; `agentProfiles.defaultRuntime` reports the real default
 * (Codex when a computer offers it, else what a computer offers).
 */
export const DEFAULT_RUNTIME = "codex";

/** The runtime every role uses in a scope, or "" when roles differ ("Mixed"). */
export function sharedRuntime(runtimes: Iterable<string>): string {
  const distinct = new Set(runtimes);
  return distinct.size === 1 ? ([...distinct][0] ?? "") : "";
}

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
  workflow?: Profile[],
): { profile?: Profile; source: "workflow" | "product" | "global" | "default" } {
  const enabled = (rows: Profile[]) => rows.find((row) => row.role === role && row.enabled);
  const fromWorkflow = workflow ? enabled(workflow) : undefined;
  if (fromWorkflow) return { profile: fromWorkflow, source: "workflow" };
  const fromProduct = product ? enabled(product) : undefined;
  if (fromProduct) return { profile: fromProduct, source: "product" };
  const fromGlobal = enabled(global);
  if (fromGlobal) return { profile: fromGlobal, source: "global" };
  return { source: "default" };
}

/**
 * Runtimes reported by the user's computers, plus the current value so it stays selectable.
 * A text-only runtime is offered only for the Orchestrator (`role`), never for all roles.
 */
export function runtimeChoices(
  devices: DeviceRuntimes[] | undefined,
  current?: string,
  role?: Role,
) {
  const choices = new Set<string>();
  for (const device of devices ?? []) {
    if (device.status === "revoked") continue;
    for (const runtime of device.runtimes)
      if (runtimeOfferedFor(role, runtime.runtime)) choices.add(runtime.runtime);
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

/**
 * Keeps the model and effort only where the selected runtime supports them. After an agent
 * switch (`runtimeChanged`) a model the new runtime does not report is cleared to its default,
 * including a typed one; otherwise an unreported model stays as saved. The effort resets when
 * the resulting model (or the runtime's default model) does not offer it.
 */
export function reconcileSelection(
  selection: { runtime: string; model: string; effort: string },
  catalogs: RuntimeModels[] | undefined,
  { runtimeChanged = false }: { runtimeChanged?: boolean } = {},
): { model: string; effort: string } {
  const catalog = catalogs?.find((item) => item.runtime === selection.runtime)?.models ?? [];
  const known = catalog.find((item) => item.id === selection.model);
  const model = selection.model && !known && runtimeChanged ? "" : selection.model;
  const offered = (model ? known : catalog.find((item) => item.isDefault))?.efforts;
  // Without a reported list the picker offers the generic efforts; only an agent switch checks them.
  const supported = offered?.length ? offered : runtimeChanged ? EFFORTS : undefined;
  const effort =
    selection.effort && supported && !supported.includes(selection.effort) ? "" : selection.effort;
  return { model, effort };
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
  INVALID_STATE: "Only a product override can be removed; turn the Default profile off instead.",
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
  /** A named workflow of the product; absent: its Default (or global). */
  workflowId?: Id<"agentWorkflows"> | undefined;
  existing: Profile | undefined;
  runtime: string;
  model: string;
  effort: string;
  enabled: boolean;
  maxConcurrency: string;
  instructions?: string;
  /** Sent for roles that run commands; "ask" clears a stored policy. */
  approvalPolicy?: ApprovalPolicy;
  /** Sent for the Verifier; "review" clears a stored mode. */
  verification?: Verification;
  /** Backup agents in order; an empty list clears them. */
  backups?: Backup[];
}) {
  const { existing } = input;
  const concurrency = input.maxConcurrency.trim();
  return {
    ...(existing ? { profileId: existing._id } : {}),
    ...(input.productId ? { productId: input.productId } : {}),
    ...(input.productId && input.workflowId ? { workflowId: input.workflowId } : {}),
    name: input.name.trim(),
    role: input.role,
    runtime: input.runtime,
    ...(input.model.trim() ? { model: input.model.trim() } : {}),
    ...(input.effort ? { reasoningEffort: input.effort } : {}),
    enabled: input.enabled,
    ...(concurrency ? { maxConcurrency: Number(concurrency) } : {}),
    ...(input.instructions !== undefined ? { instructions: input.instructions.trim() } : {}),
    ...(input.approvalPolicy !== undefined && APPROVAL_ROLES.includes(input.role)
      ? { approvalPolicy: input.approvalPolicy }
      : {}),
    ...(input.verification !== undefined && VERIFICATION_ROLES.includes(input.role)
      ? { verification: input.verification }
      : {}),
    ...(input.backups !== undefined
      ? {
          backups: input.backups.map((backup) => ({
            runtime: backup.runtime,
            ...(backup.model?.trim() ? { model: backup.model.trim() } : {}),
            ...(backup.reasoningEffort ? { reasoningEffort: backup.reasoningEffort } : {}),
          })),
        }
      : {}),
  };
}

export function AgentsSettings({
  active,
  devices,
  initialRole,
  initialScope = "",
  initialWorkflow = "",
  compact = false,
}: {
  active: boolean;
  devices: DeviceRuntimes[] | undefined;
  /** Opens one role directly, e.g. from a Session's work map. */
  initialRole?: Role;
  initialScope?: string;
  /** Opens one of the product's workflows, e.g. the one a Session uses. */
  initialWorkflow?: string;
  /** Only the editor for `initialRole`, for a surface that already describes the role. */
  compact?: boolean;
}) {
  const scope = initialScope;
  // "" is the Default; otherwise one of the owner's workflows.
  const workflow = initialWorkflow;
  const [editing, setEditing] = useState<Role | undefined>(initialRole);
  const [saved, setSaved] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string }>();
  const setEveryRole = useMutation(api.agentProfiles.setRuntimeForAllRoles);
  const products = useQuery(api.supervisor.products, active ? {} : "skip") as Product[] | undefined;
  const fallback =
    (useQuery(api.agentProfiles.defaultRuntime, active ? {} : "skip") as string | undefined) ??
    DEFAULT_RUNTIME;
  const global = useQuery(api.agentProfiles.list, active ? {} : "skip") as Profile[] | undefined;
  const productId = scope ? (scope as Id<"products">) : undefined;
  const scoped = useQuery(api.agentProfiles.list, active && productId ? { productId } : "skip") as
    | Profile[]
    | undefined;
  const workflows = useQuery(api.workflows.list, active ? {} : "skip") as WorkflowRow[] | undefined;
  const workflowId =
    workflow && workflows?.some((item) => item._id === workflow)
      ? (workflow as Id<"agentWorkflows">)
      : undefined;
  const workflowRows = useQuery(
    api.agentProfiles.list,
    active && workflowId ? { workflowId } : "skip",
  ) as Profile[] | undefined;
  const scopeRows = workflowId ? workflowRows : productId ? scoped : global;
  const productName = products?.find((product) => product._id === productId)?.name;
  const workflowName = workflows?.find((item) => item._id === workflowId)?.name;
  const scopeName = workflowName ?? productName ?? "Default";
  const roleState = (role: Role) => {
    const rows = scopeRows ?? [];
    const effective = effectiveProfile(
      role,
      productId ? (scoped ?? []) : undefined,
      global ?? [],
      workflowId ? rows : undefined,
    );
    return { effective, own: scopeProfile(role, rows), shown: effective.profile };
  };
  const badge = (source: "workflow" | "product" | "global" | "default") =>
    source === "default" ? (
      <StatusBadge status="planned" label="Default" />
    ) : source === "workflow" ? (
      <StatusBadge status="completed" label="Workflow" />
    ) : workflowId && source === "product" ? (
      <StatusBadge status="planned" label="From Default" />
    ) : productId && source === "product" ? (
      <StatusBadge status="completed" label="Override" />
    ) : (
      <StatusBadge status="completed" label="Custom" />
    );
  const summary = (shown: Profile | undefined) =>
    `${shown ? describeChain(shown) : `${runtimeLabel(fallback)} · default model`}${
      shown?.maxConcurrency ? ` · up to ${shown.maxConcurrency} at once` : ""
    }${
      shown?.approvalPolicy && shown.approvalPolicy !== "ask"
        ? ` · ${approvalPolicyLabel(shown.approvalPolicy).toLowerCase()}`
        : ""
    }${shown?.verification === "checks_only" ? " · checks only" : ""}`;
  const loading = global === undefined || scopeRows === undefined;
  const open = editing ? ROLES.find((item) => item.role === editing) : undefined;
  if (open && !loading) {
    const { effective, own, shown } = roleState(open.role);
    const editor = (
      <ProfileEditor
        key={`${open.role}:${scope}:${workflowId ?? ""}`}
        role={open.role}
        label={open.label}
        scopeName={scopeName}
        productId={productId}
        workflowId={workflowId}
        existing={own}
        prefill={own ?? shown}
        runtimes={runtimeChoices(devices, (own ?? shown)?.runtime, open.role)}
        fallback={fallback}
        onDone={() => (compact ? setSaved(true) : setEditing(undefined))}
      />
    );
    if (compact)
      return (
        <section className="z-stack" aria-label={`Change the ${open.label} agent`}>
          <p className="z-xsmall z-muted">
            {workflowId || productId
              ? `Saved for ${scopeName} only.`
              : "Saved for the Default (used where no workflow sets this job)."}
          </p>
          {saved && <Notice tone="success">Saved. The next {open.label} run uses it.</Notice>}
          {editor}
        </section>
      );
    return (
      <section className="z-stack" aria-label={`${open.label} agent`}>
        <Button
          variant="ghost"
          size="small"
          className="z-back-link"
          onClick={() => setEditing(undefined)}
        >
          ‹ All agents
        </Button>
        <div className="z-row">
          <h4 className="z-title">{open.label}</h4>
          {badge(effective.source)}
        </div>
        <p className="z-small z-muted">{open.help}</p>
        <p className="z-small">
          Now: {summary(shown)}
          {productId ? ` · for ${scopeName}` : ""}
        </p>
        {instructionsPreview(shown?.instructions) && (
          <p className="z-xsmall z-muted" title={shown?.instructions}>
            Instructions: {instructionsPreview(shown?.instructions)}
          </p>
        )}
        <ProfileNotes
          own={own}
          source={effective.source}
          productId={productId}
          scopeName={scopeName}
        />
        {editor}
      </section>
    );
  }
  return (
    <section className="z-stack" aria-label="Agents">
      <p className="z-xsmall z-muted">
        Each job is done by its own agent. Tap one to change its agent or model. Changes apply to
        new runs. Running and past runs keep the settings they started with.
      </p>
      {workflowId && (
        <p className="z-xsmall z-muted">
          Jobs you set here apply to work that uses {scopeName}; the others come from the Default.
        </p>
      )}
      {!loading && (
        <Picker
          label="Agent for every role"
          value={sharedRuntime(ROLES.map(({ role }) => roleState(role).shown?.runtime ?? fallback))}
          disabled={switching}
          options={[
            ...(sharedRuntime(ROLES.map(({ role }) => roleState(role).shown?.runtime ?? fallback))
              ? []
              : [{ value: "", label: "Mixed", description: "Roles use different agents." }]),
            ...runtimeChoices(devices, fallback).map((choice) => ({
              value: choice,
              label: runtimeLabel(choice),
            })),
          ]}
          onChange={async (value) => {
            if (!value) return;
            setSwitching(true);
            setNotice(undefined);
            try {
              await setEveryRole({
                ...(productId ? { productId } : {}),
                ...(workflowId ? { workflowId } : {}),
                runtime: value,
              });
              setNotice({
                tone: "success",
                text: `Every role uses ${runtimeLabel(value)} for ${scopeName} from the next run. Models are back to each agent's default.`,
              });
            } catch (error) {
              setNotice({ tone: "danger", text: explainProfileError(error) });
            } finally {
              setSwitching(false);
            }
          }}
        />
      )}
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      {loading ? (
        <p className="z-muted z-small" role="status">
          Loading agents…
        </p>
      ) : (
        <div className="z-settings-list">
          {ROLES.map(({ role, label, job }) => {
            const { effective, own, shown } = roleState(role);
            return (
              <button
                type="button"
                className="z-settings-row"
                key={role}
                aria-label={`${label}: ${summary(shown)}. Change`}
                onClick={() => setEditing(role)}
              >
                <span className="z-settings-row__text">
                  <span className="z-row">
                    <span className="z-settings-row__title">{label}</span>
                    <span className="z-xsmall z-muted">{job}</span>
                  </span>
                  <span className="z-settings-row__summary">{summary(shown)}</span>
                  {own && !own.enabled && (
                    <span className="z-xsmall z-muted">Your {scopeName} profile is off.</span>
                  )}
                </span>
                {badge(effective.source)}
                <span className="z-settings-row__chevron" aria-hidden="true">
                  ›
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ProfileNotes({
  own,
  source,
  productId,
  scopeName,
}: {
  own: Profile | undefined;
  source: "workflow" | "product" | "global" | "default";
  productId: Id<"products"> | undefined;
  scopeName: string;
}) {
  const off = own && !own.enabled ? `Your ${scopeName} profile is off. ` : "";
  const using =
    source === "global" && productId
      ? "Using the Default."
      : source === "default"
        ? "Using the built-in default."
        : "";
  if (!off && !using) return null;
  return (
    <p className="z-xsmall z-muted">
      {off}
      {using}
    </p>
  );
}

export function ProfileEditor({
  role,
  label,
  scopeName,
  productId,
  workflowId,
  existing,
  prefill,
  runtimes,
  fallback = DEFAULT_RUNTIME,
  onDone,
}: {
  role: Role;
  label: string;
  scopeName: string;
  productId: Id<"products"> | undefined;
  workflowId?: Id<"agentWorkflows"> | undefined;
  existing: Profile | undefined;
  prefill: Profile | undefined;
  runtimes: string[];
  /** The runtime roles use without a profile; preselected for a new profile. */
  fallback?: string;
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
  const [runtime, setRuntime] = useState(
    prefill?.runtime ?? (runtimes.includes(fallback) ? fallback : runtimes[0]) ?? fallback,
  );
  const [model, setModel] = useState(prefill?.model ?? "");
  const [effort, setEffort] = useState(prefill?.reasoningEffort ?? "");
  const [instructions, setInstructions] = useState(prefill?.instructions ?? "");
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>(
    prefill?.approvalPolicy ?? "ask",
  );
  const [verification, setVerification] = useState<Verification>(prefill?.verification ?? "review");
  const [backups, setBackups] = useState<Backup[]>(prefill?.backups ?? []);
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  // The models this runtime reports on the owner's computers; empty until a computer reports them.
  const catalogs = useQuery(api.agentProfiles.models, {}) as RuntimeModels[] | undefined;
  const catalog = catalogs?.find((item) => item.runtime === runtime)?.models ?? [];
  const chosen = catalog.find((item) => item.id === model);
  const defaultModel = catalog.find((item) => item.isDefault);
  const modelOptions = [
    {
      value: "",
      label: defaultModel ? `Default (${defaultModel.displayName})` : "Default",
      description: defaultModel ? `Currently ${defaultModel.displayName}.` : "The agent's default.",
    },
    ...catalog.map((item) => ({
      value: item.id,
      label: item.displayName,
      ...(item.description ? { description: item.description } : {}),
    })),
    // A saved model the computers no longer report stays visible instead of silently changing.
    ...(model && !chosen
      ? [{ value: model, label: model, description: "Not reported by your computer right now." }]
      : []),
  ];
  const offered = (chosen ?? (model ? undefined : defaultModel))?.efforts;
  const baseEfforts = offered?.length ? offered : EFFORTS;
  const efforts = effort && !baseEfforts.includes(effort) ? [...baseEfforts, effort] : baseEfforts;
  const select = (next: { runtime?: string; model?: string }) => {
    const nextRuntime = next.runtime ?? runtime;
    const reconciled = reconcileSelection(
      { runtime: nextRuntime, model: next.model ?? model, effort },
      catalogs,
      { runtimeChanged: nextRuntime !== runtime },
    );
    setRuntime(nextRuntime);
    setModel(reconciled.model);
    setEffort(reconciled.effort);
  };
  // What Save stores, in the same words as the profile summary shows afterwards.
  const selection = describeProfile({
    runtime,
    ...(model.trim() ? { model: model.trim() } : {}),
    ...(effort ? { reasoningEffort: effort } : {}),
  });
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
          workflowId,
          existing,
          runtime,
          model,
          effort,
          enabled: nextEnabled,
          maxConcurrency: concurrency,
          instructions,
          approvalPolicy,
          verification,
          backups,
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
        onChange={(next) => select({ runtime: next })}
      />
      {catalog.length ? (
        <Picker
          label="Model"
          value={model}
          options={modelOptions}
          onChange={(next) => select({ model: next })}
        />
      ) : (
        <div className="z-field">
          <label htmlFor={modelId}>Model</label>
          <div className="z-row" style={{ flexWrap: "nowrap" }}>
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
            <Button
              variant="secondary"
              size="small"
              disabled={!model}
              onClick={() => select({ model: "" })}
            >
              Use default
            </Button>
          </div>
          <span className="z-xsmall z-muted">
            Your computer lists the available models once it is online with the latest Zamolxis.
          </span>
        </div>
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
      <p className="z-xsmall z-muted" aria-live="polite">
        Saves as: {selection}
      </p>
      <BackupsEditor
        label={label}
        runtimes={runtimes}
        catalogs={catalogs}
        value={backups}
        onChange={setBackups}
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
      {APPROVAL_ROLES.includes(role) && (
        <Picker
          label="Approvals"
          value={approvalPolicy}
          options={APPROVAL_POLICY_OPTIONS}
          onChange={(value) => setApprovalPolicy(value as ApprovalPolicy)}
        />
      )}
      {VERIFICATION_ROLES.includes(role) && (
        <Picker
          label="Verification"
          value={verification}
          options={VERIFICATION_OPTIONS}
          onChange={(value) => setVerification(value as Verification)}
        />
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

/**
 * Backup agents for a role, in order: when the agent above cannot run on the computer a
 * Session uses (not installed there, or a local model server is off), the next one is used.
 */
function BackupsEditor({
  label,
  runtimes,
  catalogs,
  value,
  onChange,
}: {
  label: string;
  runtimes: string[];
  catalogs: RuntimeModels[] | undefined;
  value: Backup[];
  onChange: (next: Backup[]) => void;
}) {
  const update = (index: number, next: Backup) =>
    onChange(value.map((item, at) => (at === index ? next : item)));
  return (
    <section className="z-stack" aria-label={`${label} backups`}>
      <div className="z-row z-row--between">
        <strong className="z-small">Backups</strong>
        <span className="z-xsmall z-muted">Used in order when the agent above can't run.</span>
      </div>
      {value.map((backup, index) => {
        const catalog = catalogs?.find((item) => item.runtime === backup.runtime)?.models ?? [];
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: backups are an ordered list edited in place.
          <div className="z-stack" key={index}>
            <Picker
              label={`Backup ${index + 1}`}
              value={backup.runtime}
              options={runtimes.map((choice) => ({ value: choice, label: runtimeLabel(choice) }))}
              onChange={(runtime) => update(index, { runtime })}
            />
            <div className="z-row" style={{ flexWrap: "nowrap" }}>
              <Picker
                label={`Backup ${index + 1} model`}
                value={backup.model ?? ""}
                options={[
                  { value: "", label: "Default", description: "The agent's default model." },
                  ...catalog.map((item) => ({ value: item.id, label: item.displayName })),
                  ...(backup.model && !catalog.some((item) => item.id === backup.model)
                    ? [{ value: backup.model, label: backup.model }]
                    : []),
                ]}
                onChange={(model) =>
                  update(index, { runtime: backup.runtime, ...(model ? { model } : {}) })
                }
              />
              <Button
                variant="ghost"
                size="small"
                onClick={() => onChange(value.filter((_, at) => at !== index))}
              >
                Remove
              </Button>
            </div>
          </div>
        );
      })}
      {value.length < MAX_BACKUPS && (
        <Button
          variant="secondary"
          size="small"
          onClick={() => onChange([...value, { runtime: runtimes[0] ?? DEFAULT_RUNTIME }])}
        >
          Add backup
        </Button>
      )}
    </section>
  );
}

export interface WorkflowRow {
  _id: Id<"agentWorkflows">;
  name: string;
  roles: number;
  activeSessions: number;
  /** The computers whose new work starts with it. */
  computers: string[];
}
/** Recommended workflows (convex/lib/workflowPresets.ts), in the owner's words. */
export const WORKFLOW_PRESETS: Array<{ value: string; name: string; description: string }> = [
  {
    value: "save_tokens",
    name: "Save tokens",
    description:
      "Local model chats, Haiku plans, Sonnet builds, checks without AI; Codex as backup.",
  },
  {
    value: "balanced",
    name: "Balanced",
    description: "Local model chats, Sonnet plans, Opus builds, Codex checks Claude's work.",
  },
  {
    value: "max_quality",
    name: "Max quality",
    description: "Opus everywhere, Codex checks; Codex as backup.",
  },
  {
    value: "codex_only",
    name: "Codex only",
    description: "Every role on Codex, e.g. while Claude is at its limit.",
  },
  {
    value: "local_first",
    name: "Local first",
    description: "Local model chats, Codex does the work, checks without AI.",
  },
];
