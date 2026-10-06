"use client";
import { Notice, Sheet, useWide } from "@zamolxis/ui";
import { useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import {
  AgentsSettings,
  DEFAULT_RUNTIME,
  describeProfile,
  effectiveProfile,
  type Profile,
  type Role,
  runtimeLabel,
} from "./agents";

export type StepKey = "plan" | "build" | "check" | "fix" | "ready";
export type StepState = "done" | "active" | "waiting" | "skipped" | "attention";

export interface MapTask {
  phase?: string;
  status: string;
}
export interface MapRun {
  role?: string;
  status: string;
  runtime: string;
  modelActual?: string;
  modelRequested?: string;
  _creationTime: number;
}
export interface WorkStep {
  key: StepKey;
  role: Role;
  title: string;
  roleLabel: string;
  /** What the step does, for someone who has never seen it. */
  about: string;
  state: StepState;
  detail: string;
}

export type TaskProcess = "queued" | "build" | "check" | "fix" | "ready";

/** The color family for a task card follows the concrete backend phase. */
export function taskProcess(task: MapTask): TaskProcess {
  const phase = task.phase ?? task.status;
  if (phase === "building") return "build";
  if (["waiting_for_verification", "verifying"].includes(phase)) return "check";
  if (["trust_failed", "repairing", "needs_input", "failed"].includes(phase)) return "fix";
  if (["ready_for_integration", "integrating", "completed"].includes(phase)) return "ready";
  return "queued";
}

const ACTIVE_RUN = new Set([
  "queued",
  "starting",
  "running",
  "waiting",
  "needs_approval",
  "stopping",
]);
const BUILT = new Set([
  "waiting_for_verification",
  "verifying",
  "trust_failed",
  "repairing",
  "ready_for_integration",
  "integrating",
  "completed",
]);
const PASSED = new Set(["ready_for_integration", "integrating", "completed"]);
const ENDED_SESSION = new Set(["completed", "failed", "cancelled"]);

const STEPS: Array<Pick<WorkStep, "key" | "role" | "title" | "roleLabel" | "about">> = [
  {
    key: "plan",
    role: "supervisor",
    title: "Plan",
    roleLabel: "Supervisor",
    about:
      "Reads the repository at an exact commit and splits your request into tasks. Nothing is changed yet.",
  },
  {
    key: "build",
    role: "builder",
    title: "Build",
    roleLabel: "Builder",
    about:
      "Writes the code for each task, each in its own copy of the repository, so your main checkout is never touched.",
  },
  {
    key: "check",
    role: "verifier",
    title: "Check",
    roleLabel: "Verifier",
    about:
      "A separate agent tests the exact result in a fresh copy, without seeing how it was built. Only results that pass are trusted.",
  },
  {
    key: "fix",
    role: "repair",
    title: "Fix",
    roleLabel: "Repair",
    about:
      "Only when a check fails: fixes the problem and sends it back to Check. At most two attempts per task.",
  },
  {
    key: "ready",
    role: "integration",
    title: "Ready",
    roleLabel: "Integration",
    about:
      "Trusted results are collected on a branch, ready for a pull request. Merging stays your decision.",
  },
];

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Where the Session's work is, step by step, from its tasks and runs alone. */
export function workSteps(input: {
  sessionStatus: string;
  tasks: MapTask[];
  runs: MapRun[];
}): WorkStep[] {
  const { tasks, runs } = input;
  const total = tasks.length;
  const ended = ENDED_SESSION.has(input.sessionStatus);
  const phase = (task: MapTask) => task.phase ?? "";
  const active = (role: string) =>
    runs.filter((run) => (run.role ?? "builder") === role && ACTIVE_RUN.has(run.status)).length;
  const built = tasks.filter((task) => BUILT.has(phase(task))).length;
  const passed = tasks.filter((task) => PASSED.has(phase(task))).length;
  const failedChecks = tasks.filter((task) => phase(task) === "trust_failed").length;
  const repairs = runs.filter((run) => run.role === "repair").length;
  const checks = runs.filter((run) => run.role === "verifier").length;
  const blocked = tasks.filter((task) => ["needs_input", "failed"].includes(phase(task))).length;
  const merged = tasks.filter((task) => phase(task) === "completed").length;

  const plan = (): Pick<WorkStep, "state" | "detail"> => {
    if (total) return { state: "done", detail: `${count(total, "task")} planned` };
    if (input.sessionStatus === "planning")
      return { state: "active", detail: "Reading the repository and planning" };
    if (ended) return { state: "skipped", detail: "No tasks were planned" };
    return { state: "waiting", detail: "Waiting for your request" };
  };
  const build = (): Pick<WorkStep, "state" | "detail"> => {
    const working = active("builder");
    if (working)
      return {
        state: "active",
        detail: `${count(working, "agent")} writing code · ${built} of ${total} done`,
      };
    if (blocked && built < total)
      return {
        state: "attention",
        detail: `${count(blocked, "task")} need${blocked === 1 ? "s" : ""} you`,
      };
    if (total && built === total) return { state: "done", detail: `All ${total} written` };
    if (ended || !total)
      return { state: ended ? "skipped" : "waiting", detail: "Starts after the plan" };
    return { state: "waiting", detail: `${built} of ${total} done` };
  };
  const check = (): Pick<WorkStep, "state" | "detail"> => {
    const working = active("verifier");
    if (working) return { state: "active", detail: `Checking ${count(working, "result")}` };
    if (failedChecks)
      return { state: "attention", detail: `${count(failedChecks, "result")} did not pass` };
    if (total && passed === total) return { state: "done", detail: `All ${total} passed` };
    if (passed) return { state: "waiting", detail: `${passed} of ${total} passed so far` };
    return { state: ended ? "skipped" : "waiting", detail: "Starts when code is written" };
  };
  const fix = (): Pick<WorkStep, "state" | "detail"> => {
    const working = active("repair");
    if (working) return { state: "active", detail: `Fixing ${count(working, "result")}` };
    if (repairs) return { state: "done", detail: `${count(repairs, "fix attempt")} so far` };
    if (checks) return { state: "skipped", detail: "Not needed so far" };
    return { state: ended ? "skipped" : "waiting", detail: "Only if a check fails" };
  };
  const ready = (): Pick<WorkStep, "state" | "detail"> => {
    if (total && merged === total) return { state: "done", detail: "All done" };
    if (total && passed === total) return { state: "done", detail: `All ${total} ready` };
    if (passed) return { state: "active", detail: `${passed} of ${total} ready` };
    return { state: ended ? "skipped" : "waiting", detail: "Collects trusted results" };
  };
  const derive: Record<StepKey, () => Pick<WorkStep, "state" | "detail">> = {
    plan,
    build,
    check,
    fix,
    ready,
  };
  return STEPS.map((step) => ({ ...step, ...derive[step.key]() }));
}

/** The step to name in the summary line: what is happening now, else what needs the owner. */
export function currentStep(steps: WorkStep[]): WorkStep | undefined {
  return (
    steps.find((step) => step.state === "attention") ??
    steps.find((step) => step.state === "active") ??
    [...steps].reverse().find((step) => step.state === "done")
  );
}

/** The agent that did a step most recently in this Session, else the one that would do it now. */
export function stepAgent(
  role: Role,
  runs: MapRun[],
  profiles: { product?: Profile[]; global?: Profile[] },
): string {
  const latest = [...runs]
    .filter((run) => (run.role ?? "builder") === role)
    .sort((a, b) => b._creationTime - a._creationTime)[0];
  if (latest)
    return `${runtimeLabel(latest.runtime)} · ${latest.modelActual ?? latest.modelRequested ?? "default model"}`;
  const effective = effectiveProfile(role, profiles.product, profiles.global ?? []).profile;
  return effective
    ? describeProfile(effective)
    : `${runtimeLabel(DEFAULT_RUNTIME)} · default model`;
}

const STATE_LABEL: Record<StepState, string> = {
  done: "Done",
  active: "Working",
  waiting: "Not yet",
  skipped: "Skipped",
  attention: "Needs attention",
};

export function WorkMap({
  ready,
  productId,
  sessionStatus,
  tasks,
  runs,
}: {
  ready: boolean;
  productId: Id<"products"> | undefined;
  sessionStatus: string;
  tasks: MapTask[];
  runs: MapRun[];
}) {
  const wide = useWide();
  const [openStep, setOpenStep] = useState<StepKey>();
  const [changing, setChanging] = useState(false);
  const global = useQuery(api.agentProfiles.list, ready ? {} : "skip") as Profile[] | undefined;
  const product = useQuery(api.agentProfiles.list, ready && productId ? { productId } : "skip") as
    | Profile[]
    | undefined;
  const devices = useQuery(api.workstations.listMine, ready && changing ? {} : "skip") as
    | Array<{ status: string; runtimes: Array<{ runtime: string; status: string }> }>
    | undefined;
  const steps = workSteps({ sessionStatus, tasks, runs });
  const now = currentStep(steps);
  const profiles = { ...(product ? { product } : {}), ...(global ? { global } : {}) };
  const selected = steps.find((step) => step.key === openStep);
  return (
    <section className="z-flow-card" aria-label="How this work moves">
      <details className="z-flow-details" open={wide || undefined}>
        <summary className="z-flow-summary">
          <span className="z-flow-dots" aria-hidden="true">
            {steps.map((step) => (
              <span key={step.key} className={`z-flow-dot z-flow-dot--${step.state}`} />
            ))}
          </span>
          <span className="z-flow-summary__text">
            {now ? (
              <>
                <strong>{now.title}</strong> · {now.detail}
              </>
            ) : (
              "How this work moves"
            )}
          </span>
        </summary>
        <ol className="z-flow">
          {steps.map((step) => (
            <li key={step.key} className={`z-flow-step z-flow-step--${step.state}`}>
              <button
                type="button"
                className="z-flow-step__button"
                aria-label={`${step.title}, ${STATE_LABEL[step.state]}: ${step.detail}. Done by ${step.roleLabel}. Details`}
                onClick={() => {
                  setChanging(false);
                  setOpenStep(step.key);
                }}
              >
                <span className="z-flow-step__marker" aria-hidden="true">
                  {step.state === "done" ? "✓" : step.state === "attention" ? "!" : ""}
                </span>
                <span className="z-flow-step__text">
                  <span className="z-flow-step__title">
                    {step.title}
                    <span className="z-flow-step__role">{step.roleLabel}</span>
                  </span>
                  <span className="z-flow-step__detail">{step.detail}</span>
                  <span className="z-flow-step__agent">{stepAgent(step.role, runs, profiles)}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      </details>
      <Sheet
        open={selected !== undefined}
        title={selected ? `${selected.title} · ${selected.roleLabel}` : ""}
        onClose={() => setOpenStep(undefined)}
      >
        {selected && (
          <div className="z-stack">
            <p>{selected.about}</p>
            <p className="z-small">
              <strong>{STATE_LABEL[selected.state]}:</strong> {selected.detail}
            </p>
            <p className="z-small z-muted">Done by {stepAgent(selected.role, runs, profiles)}</p>
            {selected.role === "integration" ? (
              <Notice>
                In Alpha this step runs without an agent, so there is nothing to change.
              </Notice>
            ) : changing ? (
              <AgentsSettings
                active
                devices={devices}
                initialRole={selected.role}
                compact
                {...(productId ? { initialScope: productId } : {})}
              />
            ) : (
              <button
                type="button"
                className="z-button z-button--secondary z-button--block"
                onClick={() => setChanging(true)}
              >
                Change the {selected.roleLabel} agent
              </button>
            )}
            {changing && (
              <p className="z-xsmall z-muted">
                A change applies to the next run of this step. Agents already working keep their
                settings.
              </p>
            )}
          </div>
        )}
      </Sheet>
    </section>
  );
}

/** A compact, per-task view of the same trusted Build → Check → Fix → Ready journey. */
export function TaskProgress({
  sessionStatus,
  task,
  runs,
}: {
  sessionStatus: string;
  task: MapTask;
  runs: MapRun[];
}) {
  const steps = workSteps({ sessionStatus, tasks: [task], runs }).filter(
    (step) => step.key !== "plan",
  );
  return (
    <ol className="z-task-progress" aria-label="Task progress">
      {steps.map((step) => (
        <li
          key={step.key}
          className={`z-task-progress__step z-task-progress__step--${step.state}`}
          aria-label={`${step.title}: ${STATE_LABEL[step.state]}`}
          title={`${step.title}: ${step.detail}`}
        >
          <span className="z-task-progress__marker" aria-hidden="true">
            {step.state === "done" ? "✓" : step.state === "attention" ? "!" : ""}
          </span>
          <span className="z-task-progress__label">{step.title}</span>
        </li>
      ))}
    </ol>
  );
}
