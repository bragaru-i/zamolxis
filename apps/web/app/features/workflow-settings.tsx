"use client";
import { Button, Notice, Picker, TextInput } from "@zamolxis/ui";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { agentStep, type ChainEntry, chainText, JOBS, type Job, modelName } from "./agent-names";
import {
  AgentsSettings,
  DEFAULT_RUNTIME,
  INSTRUCTIONS_LIMIT,
  type Profile,
  type RuntimeModels,
  runtimeOfferedFor,
  WORKFLOW_PRESETS,
  type WorkflowRow,
} from "./agents";
import { errorCode, explainError } from "./errors";
import type { Device } from "./macs";

/** A saved agent (convex/agents.ts `list`). */
export interface SavedAgent {
  _id: Id<"agentDefinitions">;
  name: string;
  chain: ChainEntry[];
  checksOnly: boolean;
  instructions?: string;
  jobs: Job[];
  usedBy: number;
}

/** What a model costs the owner: free on their computer, or a plan's limit. */
export type Cost = "free" | "claude" | "codex";
export const COST_LABEL: Record<Cost, string> = {
  free: "Free",
  claude: "Claude plan",
  codex: "Codex plan",
};
const LOCAL_RUNTIMES = ["local", "codex-local"];
export function costOf(chain: readonly ChainEntry[], checksOnly = false): Cost | undefined {
  const first = chain[0];
  if (checksOnly || (first && LOCAL_RUNTIMES.includes(first.runtime))) return "free";
  if (first?.runtime === "claude") return "claude";
  if (first?.runtime === "codex") return "codex";
  return undefined;
}
export function CostPill({ cost }: { cost: Cost | undefined }) {
  if (!cost) return null;
  return <span className={`z-cost z-cost--${cost}`}>{COST_LABEL[cost]}</span>;
}

/** A job's settings as the models it tries, in order. */
export function profileChain(profile: Pick<Profile, "runtime" | "model" | "backups">) {
  return [
    { runtime: profile.runtime, ...(profile.model ? { model: profile.model } : {}) },
    ...(profile.backups ?? []),
  ];
}

/** Mirrors convex/agents.ts `jobsFor`: every model must be allowed for the job. */
export function agentJobs(chain: readonly ChainEntry[], checksOnly: boolean): Job[] {
  if (checksOnly) return ["verifier"];
  return JOBS.map((job) => job.role).filter((role) =>
    chain.every((entry) => runtimeOfferedFor(role, entry.runtime)),
  );
}
const SHORT_JOB: Record<Job, string> = {
  orchestrator: "chat",
  supervisor: "plan",
  builder: "write code",
  verifier: "check",
  repair: "fix",
};
export function jobsText(jobs: readonly Job[]): string {
  if (jobs.length === JOBS.length) return "every job";
  return jobs.map((job) => SHORT_JOB[job]).join(", ") || "no job";
}

/** The job's settings in a workflow: its own, else the Default's, else the built-in agent. */
export function jobProfile(
  role: Job,
  global: Profile[],
  workflow: Profile[] | undefined,
): Profile | undefined {
  const enabled = (rows: Profile[]) => rows.find((row) => row.role === role && row.enabled);
  return (workflow && enabled(workflow)) ?? enabled(global);
}

/**
 * The model a computer actually uses for a job: the first one of the chain it has. Absent
 * when it has none of them (the job waits for another computer of the same project).
 */
export function runsHere(
  chain: readonly ChainEntry[],
  runtimes: readonly string[],
): { entry: ChainEntry; backup: boolean } | undefined {
  const index = chain.findIndex((entry) => runtimes.includes(entry.runtime));
  const entry = chain[index];
  return entry ? { entry, backup: index > 0 } : undefined;
}

function availableRuntimes(device: Pick<Device, "runtimes">): string[] {
  return device.runtimes.filter((item) => item.status === "available").map((item) => item.runtime);
}

const WORKFLOW_ERRORS: Record<string, string> = {
  WORKFLOW_NAME_TAKEN: "You already have a workflow with that name.",
  WORKFLOW_IN_USE: "A session that is not finished uses this workflow. Finish or close it first.",
  AGENT_NOT_ALLOWED_FOR_JOB:
    "That agent cannot do this job. A local model chats, plans and checks; it never writes code.",
  LIMIT_EXCEEDED: "You have reached the limit. Delete one you no longer use first.",
};
function explain(error: unknown, fallback: string) {
  const code = errorCode(error);
  return (code && WORKFLOW_ERRORS[code]) ?? explainError(error, fallback);
}

/** "Start from" choices for a new workflow: a recommended one, empty, or a copy of yours. */
export function workflowSources(
  workflows: Pick<WorkflowRow, "_id" | "name">[],
): Array<{ value: string; label: string; description?: string }> {
  return [
    ...WORKFLOW_PRESETS.map((preset) => ({
      value: `preset:${preset.value}`,
      label: `Recommended · ${preset.name}`,
      description: preset.description,
    })),
    { value: "copy:", label: "Copy of Default" },
    ...workflows.map((workflow) => ({
      value: `copy:${workflow._id}`,
      label: `Copy of ${workflow.name}`,
    })),
    { value: "", label: "Empty", description: "Every job uses the Default until you pick one." },
  ];
}

function useStarterAgents(active: boolean) {
  const agents = useQuery(api.agents.list, active ? {} : "skip") as SavedAgent[] | undefined;
  const ensure = useMutation(api.agents.ensureStarter);
  const asked = useRef(false);
  useEffect(() => {
    if (agents?.length !== 0 || asked.current) return;
    asked.current = true;
    void ensure({}).catch(() => undefined);
  }, [agents, ensure]);
  return agents;
}

/**
 * Settings → Workflows: which agent does each job. Workflows belong to the owner; each
 * computer picks the one it uses (Computers & projects).
 */
export function WorkflowsSettings({
  active,
  devices,
}: {
  active: boolean;
  devices: Device[] | undefined;
}) {
  const workflows = useQuery(api.workflows.list, active ? {} : "skip") as WorkflowRow[] | undefined;
  const [selected, setSelected] = useState("");
  const [creating, setCreating] = useState(false);
  const current = workflows?.find((item) => item._id === selected);
  const computers = (devices ?? []).filter((device) => device.status !== "revoked");
  const defaultUsers = computers
    .filter(
      (device) =>
        !device.defaultWorkflowId ||
        !workflows?.some((item) => item._id === device.defaultWorkflowId),
    )
    .map((device) => device.name);
  const usedBy = (names: string[]) =>
    names.length ? `Used by ${names.join(", ")}` : "No computer uses it";
  return (
    <section className="z-stack" aria-label="Workflows">
      <p className="z-small z-muted">
        A workflow says which agent does each job. Make it once; each computer picks the one it uses
        (Computers &amp; projects).
      </p>
      <div className="z-workflows">
        <div className="z-workflows__list">
          <button
            type="button"
            className="z-workflow-pick"
            aria-pressed={!current}
            onClick={() => setSelected("")}
          >
            <span className="z-workflow-pick__name">Default</span>
            <span className="z-workflow-pick__used">{usedBy(defaultUsers)}</span>
          </button>
          {(workflows ?? []).map((item) => (
            <button
              type="button"
              key={item._id}
              className="z-workflow-pick"
              aria-pressed={current?._id === item._id}
              onClick={() => setSelected(item._id)}
            >
              <span className="z-workflow-pick__name">{item.name}</span>
              <span className="z-workflow-pick__used">{usedBy(item.computers)}</span>
            </button>
          ))}
          {creating ? (
            <NewWorkflow
              workflows={workflows ?? []}
              onDone={(id) => {
                setCreating(false);
                if (id) setSelected(id);
              }}
            />
          ) : (
            <Button variant="secondary" size="small" onClick={() => setCreating(true)}>
              + New workflow
            </Button>
          )}
        </div>
        <WorkflowJobs
          key={current?._id ?? "default"}
          active={active}
          devices={devices}
          workflow={current}
          usedBy={current ? usedBy(current.computers) : usedBy(defaultUsers)}
          onDeleted={() => setSelected("")}
        />
      </div>
    </section>
  );
}

function NewWorkflow({
  workflows,
  onDone,
}: {
  workflows: WorkflowRow[];
  onDone: (id?: Id<"agentWorkflows">) => void;
}) {
  const create = useMutation(api.workflows.create);
  const [name, setName] = useState(WORKFLOW_PRESETS[0]?.name ?? "");
  const [source, setSource] = useState(`preset:${WORKFLOW_PRESETS[0]?.value ?? ""}`);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const nameId = useId();
  return (
    <form
      className="z-stack z-workflow-new"
      aria-label="New workflow"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!name.trim()) return setProblem("Give the workflow a name.");
        setBusy(true);
        setProblem("");
        try {
          const [kind, from] = source.split(":");
          const id = await create({
            name: name.trim(),
            ...(kind === "preset" && from
              ? { preset: from as "save_tokens" }
              : kind === "copy"
                ? { copyFrom: from ? { workflowId: from as Id<"agentWorkflows"> } : {} }
                : {}),
          });
          onDone(id);
        } catch (error) {
          setProblem(explain(error, "Could not create the workflow."));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Picker
        label="Start from"
        value={source}
        options={workflowSources(workflows)}
        onChange={(next) => {
          setSource(next);
          // A recommended one names the workflow unless the owner typed their own name.
          const preset = WORKFLOW_PRESETS.find((item) => next === `preset:${item.value}`);
          if (preset && (!name.trim() || WORKFLOW_PRESETS.some((item) => item.name === name)))
            setName(preset.name);
        }}
      />
      <label className="z-field" htmlFor={nameId}>
        Name
        <TextInput
          id={nameId}
          value={name}
          maxLength={64}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {problem && <Notice tone="danger">{problem}</Notice>}
      <div className="z-row">
        <Button type="submit" size="small" disabled={busy}>
          {busy ? "Creating…" : "Create"}
        </Button>
        <Button variant="ghost" size="small" disabled={busy} onClick={() => onDone()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function WorkflowJobs({
  active,
  devices,
  workflow,
  usedBy,
  onDeleted,
}: {
  active: boolean;
  devices: Device[] | undefined;
  workflow: WorkflowRow | undefined;
  usedBy: string;
  onDeleted: () => void;
}) {
  const workflowId = workflow?._id;
  const global = useQuery(api.agentProfiles.list, active ? {} : "skip") as Profile[] | undefined;
  const own = useQuery(api.agentProfiles.list, active && workflowId ? { workflowId } : "skip") as
    | Profile[]
    | undefined;
  const fallback =
    (useQuery(api.agentProfiles.defaultRuntime, active ? {} : "skip") as string | undefined) ??
    DEFAULT_RUNTIME;
  const agents = useStarterAgents(active);
  const assign = useMutation(api.agents.assign);
  const unassign = useMutation(api.agents.unassign);
  const rename = useMutation(api.workflows.rename);
  const remove = useMutation(api.workflows.remove);
  const [mode, setMode] = useState<"idle" | "rename" | "delete">("idle");
  const [name, setName] = useState(workflow?.name ?? "");
  const [more, setMore] = useState<Job>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const nameId = useId();
  const loading = global === undefined || (workflowId && own === undefined) || !agents;
  const run = async (action: () => Promise<unknown>, fallbackText: string) => {
    setBusy(true);
    setProblem("");
    try {
      await action();
      setMode("idle");
    } catch (error) {
      setProblem(explain(error, fallbackText));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="z-workflow-card">
      <div className="z-workflow-card__top">
        <div className="z-workflow-card__title">
          <h4 className="z-title">{workflow?.name ?? "Default"}</h4>
          <span className="z-xsmall z-muted">
            {usedBy}
            {workflow ? "" : ". New computers start with it; a workflow's empty jobs use it."}
          </span>
        </div>
        {workflow && mode === "idle" && (
          <div className="z-row">
            <Button
              variant="ghost"
              size="small"
              onClick={() => {
                setName(workflow.name);
                setMode("rename");
              }}
            >
              Rename
            </Button>
            <Button variant="ghost" size="small" onClick={() => setMode("delete")}>
              Delete
            </Button>
          </div>
        )}
      </div>
      {workflow && mode === "rename" && (
        <form
          className="z-workflow-card__form"
          aria-label="Rename workflow"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return setProblem("Give the workflow a name.");
            void run(
              () => rename({ workflowId: workflow._id, name: name.trim() }),
              "Could not rename the workflow.",
            );
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
          <div className="z-row">
            <Button type="submit" size="small" disabled={busy}>
              Save
            </Button>
            <Button variant="ghost" size="small" onClick={() => setMode("idle")}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {workflow && mode === "delete" && (
        <div className="z-workflow-card__form">
          <p className="z-small">
            Delete {workflow.name}? Computers that use it go back to the Default.
          </p>
          <div className="z-row">
            <Button
              variant="danger"
              size="small"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await remove({ workflowId: workflow._id });
                  onDeleted();
                }, "Could not delete the workflow.")
              }
            >
              Delete workflow
            </Button>
            <Button variant="ghost" size="small" onClick={() => setMode("idle")}>
              Keep
            </Button>
          </div>
        </div>
      )}
      {problem && (
        <div className="z-workflow-card__form">
          <Notice tone="danger">{problem}</Notice>
        </div>
      )}
      <div className="z-jobs__head" aria-hidden="true">
        <span>Job</span>
        <span>Agent</span>
        <span>Cost</span>
      </div>
      {loading ? (
        <p className="z-muted z-small z-jobs__loading" role="status">
          Loading…
        </p>
      ) : (
        JOBS.map((job) => {
          const mine = (workflowId ? own : global)?.find(
            (row) => row.role === job.role && row.enabled,
          );
          const shown = jobProfile(job.role, global ?? [], workflowId ? own : undefined);
          const chain = shown ? profileChain(shown) : [{ runtime: fallback }];
          const checksOnly = shown?.verification === "checks_only";
          const linked = mine?.agentId && agents?.some((agent) => agent._id === mine.agentId);
          const value = mine ? (linked ? (mine.agentId as string) : "custom") : "";
          const inherited = jobProfile(job.role, global ?? [], undefined);
          return (
            <div className="z-job" key={job.role}>
              <div className="z-job__name">
                <span className="z-job__label">{job.label}</span>
                <span className="z-xsmall z-muted">{job.help}</span>
              </div>
              <div className="z-job__agent">
                <Picker
                  label={`${job.label}: agent`}
                  hideLabel
                  value={value}
                  disabled={busy}
                  options={[
                    ...(workflowId
                      ? [
                          {
                            value: "",
                            label: "Same as Default",
                            description: inherited
                              ? chainText(profileChain(inherited))
                              : agentStep({ runtime: fallback }),
                          },
                        ]
                      : mine
                        ? []
                        : [{ value: "", label: `Built-in · ${modelName(fallback)}` }]),
                    ...(value === "custom" && mine
                      ? [
                          {
                            value: "custom",
                            label: "Set by hand",
                            description: chainText(profileChain(mine), checksOnly),
                          },
                        ]
                      : []),
                    ...(agents ?? [])
                      .filter((agent) => agent.jobs.includes(job.role))
                      .map((agent) => ({
                        value: agent._id,
                        label: agent.name,
                        description: chainText(agent.chain, agent.checksOnly),
                      })),
                  ]}
                  onChange={(next) => {
                    if (next === value || next === "custom") return;
                    void run(
                      () =>
                        next
                          ? assign({
                              ...(workflowId ? { workflowId } : {}),
                              role: job.role,
                              agentId: next as Id<"agentDefinitions">,
                            })
                          : workflowId
                            ? unassign({ workflowId, role: job.role })
                            : Promise.resolve(),
                      "Could not change the agent.",
                    );
                  }}
                />
                <span className="z-job__chain">{chainText(chain, checksOnly)}</span>
                <button
                  type="button"
                  className="z-link-button"
                  aria-expanded={more === job.role}
                  onClick={() => setMore(more === job.role ? undefined : job.role)}
                >
                  {more === job.role ? "Hide details" : "Approvals, limits…"}
                </button>
              </div>
              <div className="z-job__cost">
                <CostPill cost={costOf(chain, checksOnly)} />
              </div>
              {more === job.role && (
                <div className="z-job__more">
                  <AgentsSettings
                    active={active}
                    devices={devices}
                    initialRole={job.role}
                    compact
                    {...(workflowId ? { initialWorkflow: workflowId } : {})}
                  />
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

const RUNTIME_CHOICES: Array<{ value: string; label: string; description: string }> = [
  {
    value: "codex-local",
    label: "Local model via Codex",
    description: "Free, on your computer. Can read the code: chats, plans and checks.",
  },
  {
    value: "local",
    label: "Local model (chat only)",
    description: "Free, on your computer. Only chats with you.",
  },
  { value: "claude", label: "Claude", description: "Counts toward your Claude plan." },
  { value: "codex", label: "Codex", description: "Counts toward your ChatGPT plan." },
];
const MAX_CHAIN = 3;

/** Settings → My agents: named agents of one to three models in order. */
export function MyAgentsSettings({
  active,
  devices,
}: {
  active: boolean;
  devices: Device[] | undefined;
}) {
  const agents = useStarterAgents(active);
  const [editing, setEditing] = useState<SavedAgent | "new">();
  const catalogs = useQuery(api.agentProfiles.models, active ? {} : "skip") as
    | RuntimeModels[]
    | undefined;
  const setUnnamed = useMutation(api.agents.setUnnamedModel);
  const [switched, setSwitched] = useState("");
  // Codex without a named model runs its own default (GPT-6.1-Sol), which uses the plan
  // fastest; its affordable model is offered in one tap.
  const codexModels = catalogs?.find((item) => item.runtime === "codex")?.models ?? [];
  const codexDefault = codexModels.find((model) => model.isDefault);
  const affordable = codexModels.find((model) => /luna/i.test(model.id));
  const unnamed = (agents ?? []).filter((agent) =>
    agent.chain.some((entry) => entry.runtime === "codex" && !entry.model),
  ).length;
  return (
    <section className="z-stack" aria-label="My agents">
      <div className="z-page-head">
        <p className="z-small z-muted">
          An agent is one to three models in order. The first does the work; the next take over only
          if it can&apos;t run (computer off, limit reached).
        </p>
        {!editing && (
          <Button size="small" onClick={() => setEditing("new")}>
            + New agent
          </Button>
        )}
      </div>
      {unnamed > 0 && codexDefault && affordable && codexDefault.id !== affordable.id && (
        <Notice tone="warning">
          <span className="z-stack">
            <span>
              {unnamed} {unnamed === 1 ? "agent uses" : "agents use"} Codex&apos;s default model,{" "}
              {codexDefault.displayName}, which uses your plan fastest. {affordable.displayName} is
              Codex&apos;s affordable model.
            </span>
            <Button
              size="small"
              variant="secondary"
              onClick={async () => {
                const changed = await setUnnamed({ runtime: "codex", model: affordable.id });
                setSwitched(
                  `${affordable.displayName} now runs wherever Codex had no model (${changed} ${
                    changed === 1 ? "place" : "places"
                  }). Work already running keeps its model.`,
                );
              }}
            >
              Use {affordable.displayName} instead
            </Button>
          </span>
        </Notice>
      )}
      {switched && <Notice tone="success">{switched}</Notice>}
      {editing && (
        <AgentEditor
          key={editing === "new" ? "new" : editing._id}
          active={active}
          devices={devices}
          agent={editing === "new" ? undefined : editing}
          onDone={() => setEditing(undefined)}
        />
      )}
      {agents === undefined ? (
        <p className="z-muted z-small" role="status">
          Loading agents…
        </p>
      ) : (
        <div className="z-agent-grid">
          {agents.map((agent) => (
            <div className="z-agent-card" key={agent._id}>
              <div className="z-agent-card__top">
                <span className="z-agent-card__name">{agent.name}</span>
                <CostPill cost={costOf(agent.chain, agent.checksOnly)} />
              </div>
              {agent.checksOnly ? (
                <p className="z-small">Runs the project&apos;s own checks; no AI model.</p>
              ) : (
                <ol className="z-agent-steps">
                  {agent.chain.map((entry, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a model's place in the order is its identity.
                    <li key={index}>
                      <span className="z-agent-steps__num">{index + 1}</span>
                      <span>{agentStep(entry)}</span>
                    </li>
                  ))}
                </ol>
              )}
              <div className="z-agent-card__foot">
                <span className="z-xsmall z-muted">
                  Can do: {jobsText(agent.jobs)} · Used in {agent.usedBy}{" "}
                  {agent.usedBy === 1 ? "job" : "jobs"}
                </span>
                <Button variant="ghost" size="small" onClick={() => setEditing(agent)}>
                  Edit
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function AgentEditor({
  active,
  devices,
  agent,
  onDone,
}: {
  active: boolean;
  devices: Device[] | undefined;
  agent: SavedAgent | undefined;
  onDone: () => void;
}) {
  const save = useMutation(api.agents.save);
  const remove = useMutation(api.agents.remove);
  const catalogs = useQuery(api.agentProfiles.models, active ? {} : "skip") as
    | RuntimeModels[]
    | undefined;
  const [name, setName] = useState(agent?.name ?? "");
  const [chain, setChain] = useState<ChainEntry[]>(agent?.chain ?? [{ runtime: "claude" }]);
  const [checksOnly, setChecksOnly] = useState(agent?.checksOnly ?? false);
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const nameId = useId();
  const notesId = useId();
  const offered = new Set(
    (devices ?? [])
      .filter((device) => device.status !== "revoked")
      .flatMap((device) => availableRuntimes(device)),
  );
  const runtimes = RUNTIME_CHOICES.filter(
    (choice) => offered.has(choice.value) || chain.some((entry) => entry.runtime === choice.value),
  );
  const jobs = agentJobs(chain, checksOnly);
  const modelOptions = (entry: ChainEntry) => {
    const models = catalogs?.find((item) => item.runtime === entry.runtime)?.models ?? [];
    // A local model is always named: the local server has no "default" Codex could send.
    const local = LOCAL_RUNTIMES.includes(entry.runtime) && models.length > 0;
    return [
      ...(local
        ? []
        : [
            {
              value: "",
              label: `${entry.runtime === "codex" ? "Codex" : "Its"} default${
                models.find((model) => model.isDefault)
                  ? ` (${models.find((model) => model.isDefault)?.displayName})`
                  : " model"
              }`,
            },
          ]),
      ...models.map((model) => ({ value: model.id, label: modelName(entry.runtime, model.id) })),
      ...(entry.model && !models.some((model) => model.id === entry.model)
        ? [{ value: entry.model, label: modelName(entry.runtime, entry.model) }]
        : []),
    ];
  };
  const update = (index: number, next: ChainEntry) =>
    setChain(chain.map((entry, at) => (at === index ? next : entry)));
  const act = async (action: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setProblem("");
    try {
      await action();
      onDone();
    } catch (error) {
      setProblem(explain(error, fallback));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="z-agent-editor"
      aria-label={agent ? `Edit ${agent.name}` : "New agent"}
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) return setProblem("Give the agent a name.");
        if (!jobs.length)
          return setProblem("No job allows this mix of models. Put the local model last or alone.");
        void act(
          () =>
            save({
              ...(agent ? { agentId: agent._id } : {}),
              name: name.trim(),
              chain,
              checksOnly,
              instructions,
            }),
          "Could not save the agent.",
        );
      }}
    >
      <div className="z-agent-card__top">
        <strong>{agent ? `Edit ${agent.name}` : "New agent"}</strong>
        <CostPill cost={costOf(chain, checksOnly)} />
      </div>
      <label className="z-field" htmlFor={nameId}>
        Name
        <TextInput
          id={nameId}
          value={name}
          maxLength={64}
          placeholder="e.g. Local reviewer"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {!checksOnly && (
        <fieldset className="z-agent-chain">
          <legend className="z-small">Models, in order</legend>
          {chain.map((entry, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a model's place in the order is its identity.
            <div className="z-agent-chain__row" key={index}>
              <span className="z-agent-steps__num" aria-hidden="true">
                {index + 1}
              </span>
              <Picker
                label={`Model ${index + 1}: where it runs`}
                hideLabel
                value={entry.runtime}
                options={runtimes}
                onChange={(runtime) => {
                  const models = catalogs?.find((item) => item.runtime === runtime)?.models ?? [];
                  const first = models.find((model) => model.isDefault) ?? models[0];
                  update(index, {
                    runtime,
                    ...(LOCAL_RUNTIMES.includes(runtime) && first ? { model: first.id } : {}),
                  });
                }}
              />
              <Picker
                label={`Model ${index + 1}: model`}
                hideLabel
                value={entry.model ?? ""}
                options={modelOptions(entry)}
                onChange={(model) =>
                  update(index, { runtime: entry.runtime, ...(model ? { model } : {}) })
                }
              />
              {chain.length > 1 && (
                <Button
                  variant="ghost"
                  size="small"
                  aria-label={`Remove model ${index + 1}`}
                  onClick={() => setChain(chain.filter((_, at) => at !== index))}
                >
                  ✕
                </Button>
              )}
            </div>
          ))}
          {chain.length < MAX_CHAIN && (
            <Button
              variant="secondary"
              size="small"
              onClick={() =>
                setChain([...chain, { runtime: offered.has("codex") ? "codex" : "claude" }])
              }
            >
              + Add a backup
            </Button>
          )}
        </fieldset>
      )}
      <label className="z-check">
        <input
          type="checkbox"
          checked={checksOnly}
          onChange={(event) => setChecksOnly(event.target.checked)}
        />
        Only run the project&apos;s tests, no AI model (for &quot;Check it&quot;)
      </label>
      {!checksOnly && (
        <label className="z-field" htmlFor={notesId}>
          Instructions (optional)
          <textarea
            id={notesId}
            className="z-textarea"
            style={{ padding: "8px", resize: "vertical" }}
            rows={2}
            maxLength={INSTRUCTIONS_LIMIT}
            placeholder="e.g. Review for missing tests first."
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </label>
      )}
      <p className="z-xsmall z-muted">
        Can do:{" "}
        {jobs.length
          ? JOBS.filter((job) => jobs.includes(job.role))
              .map((job) => job.label)
              .join(", ")
          : "no job"}
        .
        {chain.some((entry) => LOCAL_RUNTIMES.includes(entry.runtime)) && !checksOnly
          ? " A local model never writes code."
          : ""}
      </p>
      {problem && <Notice tone="danger">{problem}</Notice>}
      <div className="z-row">
        <Button type="submit" size="small" disabled={busy}>
          {busy ? "Saving…" : "Save agent"}
        </Button>
        <Button variant="ghost" size="small" disabled={busy} onClick={onDone}>
          Cancel
        </Button>
        {agent &&
          (confirmDelete ? (
            <Button
              variant="danger"
              size="small"
              disabled={busy}
              onClick={() => void act(() => remove({ agentId: agent._id }), "Could not delete it.")}
            >
              Delete {agent.name}
            </Button>
          ) : (
            <Button variant="ghost" size="small" onClick={() => setConfirmDelete(true)}>
              Delete…
            </Button>
          ))}
      </div>
      {agent && confirmDelete && (
        <p className="z-xsmall z-muted">Jobs that use it keep their models.</p>
      )}
    </form>
  );
}

/**
 * The workflow a computer uses and what each job runs there: a model the computer lacks
 * falls to the agent's next one.
 */
export function ComputerWorkflow({ device, active }: { device: Device; active: boolean }) {
  const workflows = useQuery(api.workflows.list, active ? {} : "skip") as WorkflowRow[] | undefined;
  const setForComputer = useMutation(api.workflows.setForComputer);
  const [problem, setProblem] = useState("");
  const value =
    device.defaultWorkflowId && workflows?.some((item) => item._id === device.defaultWorkflowId)
      ? device.defaultWorkflowId
      : "";
  return (
    <div className="z-stack">
      <Picker
        label="Workflow on this computer"
        value={value}
        options={[
          { value: "", label: "Default" },
          ...(workflows ?? []).map((item) => ({ value: item._id, label: item.name })),
        ]}
        onChange={async (next) => {
          setProblem("");
          try {
            await setForComputer({
              workstationId: device._id,
              ...(next ? { workflowId: next as Id<"agentWorkflows"> } : {}),
            });
          } catch (error) {
            setProblem(explain(error, "Could not change the workflow."));
          }
        }}
      />
      {problem && <Notice tone="danger">{problem}</Notice>}
      <RunsHere
        active={active}
        runtimes={availableRuntimes(device)}
        {...(value ? { workflowId: value as Id<"agentWorkflows"> } : {})}
      />
    </div>
  );
}

function RunsHere({
  active,
  runtimes,
  workflowId,
}: {
  active: boolean;
  runtimes: string[];
  workflowId?: Id<"agentWorkflows">;
}) {
  const global = useQuery(api.agentProfiles.list, active ? {} : "skip") as Profile[] | undefined;
  const own = useQuery(api.agentProfiles.list, active && workflowId ? { workflowId } : "skip") as
    | Profile[]
    | undefined;
  const fallback =
    (useQuery(api.agentProfiles.defaultRuntime, active ? {} : "skip") as string | undefined) ??
    DEFAULT_RUNTIME;
  if (!global || (workflowId && !own)) return null;
  return (
    <section className="z-runs-here" aria-label="What runs here">
      <span className="z-runs-here__title">What runs here</span>
      {JOBS.map((job) => {
        const shown = jobProfile(job.role, global, workflowId ? own : undefined);
        const chain = shown ? profileChain(shown) : [{ runtime: fallback }];
        const here = runsHere(chain, runtimes);
        const first = chain[0];
        return (
          <div className="z-runs-here__row" key={job.role}>
            <strong>{job.label}</strong>
            {shown?.verification === "checks_only" ? (
              <span className="z-muted">The project&apos;s checks, no AI</span>
            ) : !here ? (
              <span className="z-runs-here__warn">
                Can&apos;t run here: {chainText(chain)} not on this computer
              </span>
            ) : here.backup && first ? (
              <span className="z-runs-here__warn">
                {agentStep(here.entry)} — backup, no {modelName(first.runtime, first.model)} here
              </span>
            ) : (
              <span className="z-muted">{agentStep(here.entry)}</span>
            )}
          </div>
        );
      })}
    </section>
  );
}

/** A project's own workflow on one computer, instead of the computer's. */
export function ProjectWorkflow({
  location,
  active,
}: {
  location: {
    repositoryLocationId: Id<"repositoryLocations">;
    repositoryName: string;
    defaultWorkflowId?: Id<"agentWorkflows">;
  };
  active: boolean;
}) {
  const workflows = useQuery(api.workflows.list, active ? {} : "skip") as WorkflowRow[] | undefined;
  const save = useMutation(api.workflows.setForLocation);
  const [problem, setProblem] = useState("");
  return (
    <div className="z-stack">
      <Picker
        label={location.repositoryName}
        value={location.defaultWorkflowId ?? ""}
        options={[
          { value: "", label: "Same as the computer" },
          ...(workflows ?? []).map((item) => ({ value: item._id, label: item.name })),
        ]}
        onChange={async (next) => {
          setProblem("");
          try {
            await save({
              repositoryLocationId: location.repositoryLocationId,
              ...(next ? { workflowId: next as Id<"agentWorkflows"> } : {}),
            });
          } catch (error) {
            setProblem(explain(error, "Could not save the workflow."));
          }
        }}
      />
      {problem && <Notice tone="danger">{problem}</Notice>}
    </div>
  );
}
