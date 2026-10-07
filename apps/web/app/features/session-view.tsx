"use client";
import {
  AgentRow,
  AppHeader,
  AppShell,
  Button,
  Collapsible,
  Composer,
  IconButton,
  Markdown,
  Message,
  Notice,
  Picker,
  SessionStatusBadge,
  StatusBadge,
  Thinking,
} from "@zamolxis/ui";
import { useMutation, useQuery } from "convex/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { SessionApprovals, showApprovals } from "./approvals";
import {
  assistantReply,
  type ConversationMessage,
  likelyLongSummary,
  plannedLabel,
  startsNewSession,
  thinkingDetail,
  usageLine,
} from "./conversation";
import { explainError, explainFailure } from "./errors";
import { FailureDetails, RunFailure } from "./failure";
import { type ProofImage, ProofImages } from "./proof-images";
import { PublishTask } from "./publish";
import { RunDetail } from "./run-detail";
import { runtimeLabel } from "./run-detail-model";
import { STEERABLE, SteerRun } from "./steer";
import { SupervisorLog } from "./supervisor-log";
import { relativeTime } from "./time";
import { SessionUsage } from "./usage";
import { useSearchParam } from "./use-location";
import { TaskProgress, taskProcess, WorkMap } from "./work-map";

interface Session {
  _id: Id<"workSessions">;
  title: string;
  status: string;
  activeRunCount?: number;
  contextSummary?: string;
  /** The computer the Session's work runs on (Sessions from before have none). */
  workstationName?: string;
  /** The product workflow the Session uses, when not the Default. */
  workflowName?: string;
  workflowId?: Id<"agentWorkflows">;
  productId?: Id<"products">;
}
interface UserMessage extends ConversationMessage {
  _id: string;
  text: string;
  createdAt: number;
  productId: Id<"products">;
  repositoryId: Id<"repositories">;
}
interface Task {
  _id: Id<"tasks">;
  _creationTime: number;
  title: string;
  status: string;
  phase?: string;
  repairAttempts?: number;
  trustOutcome?: string;
  failureReason?: string;
}
interface Run {
  _id: Id<"agentRuns">;
  _creationTime: number;
  taskId: Id<"tasks">;
  role?: string;
  runtime: string;
  /** Which backup of the role's chain ran (absent: the profile's own agent). */
  backup?: number;
  status: string;
  modelRequested?: string;
  modelActual?: string;
  activityLabel?: string;
  totalTokens?: number;
  estimatedCostUsd?: number;
  startedAt?: number;
  completedAt?: number;
  resultSummary?: string;
}

const ENDED = ["completed", "failed", "cancelled"];
const ACTIVE_RUN = ["queued", "starting", "running", "waiting", "needs_approval"];
const ROLE: Record<string, string> = { builder: "Builder", verifier: "Verifier", repair: "Repair" };

export function SessionView({
  sessionId,
  ready,
  indicator,
  notices,
  onBack,
  onOpen,
}: {
  sessionId: Id<"workSessions">;
  ready: boolean;
  indicator: ReactNode;
  notices: ReactNode;
  onBack: () => void;
  onOpen: (id: Id<"workSessions">) => void;
}) {
  const args = ready ? { workSessionId: sessionId } : "skip";
  const session = useQuery(api.sessions.get, args) as Session | undefined;
  const messages = useQuery(api.supervisor.messages, args) as UserMessage[] | undefined;
  const tasks = useQuery(api.tasks.listBySession, args) as Task[] | undefined;
  const runs = useQuery(api.runs.listBySession, args) as Run[] | undefined;
  const proof = useQuery(api.proof.listForSession, args) as ProofImage[] | undefined;
  const submit = useMutation(api.supervisor.submit);
  const cancel = useMutation(api.sessions.cancel);
  const close = useMutation(api.sessions.close);
  const stopRun = useMutation(api.runs.stop);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  // The open Run lives in the URL so an Orchestrator link can open it directly.
  const [runParam, setRunParam] = useSearchParam("run");
  const openRun = (runParam || undefined) as Id<"agentRuns"> | undefined;
  const [notice, setNotice] = useState<{ tone: "danger" | "info"; text: string }>();
  const end = useRef<HTMLDivElement>(null);
  const count = (messages?.length ?? 0) + (tasks?.length ?? 0) + (runs?.length ?? 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when new content arrives.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [count]);
  const ended = session ? ENDED.includes(session.status) : false;
  const now = useNow((runs ?? []).some((run) => ACTIVE_RUN.includes(run.status)));
  const last = messages?.[messages.length - 1];
  const startsNew = startsNewSession(session?.status);
  const asking = last ? assistantReply(last).kind === "ask" : false;
  const sortedTasks = [...(tasks ?? [])].sort((a, b) => a._creationTime - b._creationTime);
  const runsFor = (taskId: Id<"tasks">) =>
    (runs ?? [])
      .filter((run) => run.taskId === taskId)
      .sort((a, b) => a._creationTime - b._creationTime);
  return (
    <AppShell
      header={
        <AppHeader
          leading={<IconButton icon="back" label="Back to Home" onClick={onBack} />}
          title={session?.title ?? "Session"}
          subtitle={
            <>
              {session && <SessionStatusBadge status={session.status} />}
              {session?.workstationName && (
                <span className="z-xsmall z-muted">Runs on {session.workstationName}</span>
              )}
              {session?.workflowName && (
                <span className="z-xsmall z-muted">Workflow: {session.workflowName}</span>
              )}
              {indicator}
            </>
          }
          trailing={
            session &&
            !ended &&
            (["planning", "running"].includes(session.status) ||
            (session.activeRunCount ?? 0) > 0 ? (
              <Button variant="danger" size="small" onClick={() => setConfirmStop(true)}>
                Stop
              </Button>
            ) : (
              // Nothing is running: the owner can mark the session done.
              <Button
                variant="secondary"
                size="small"
                onClick={async () => {
                  try {
                    await close({ workSessionId: sessionId });
                  } catch (error) {
                    setNotice({
                      tone: "danger",
                      text: explainError(error, "Could not close the session."),
                    });
                  }
                }}
              >
                Close session
              </Button>
            ))
          }
        />
      }
      footer={
        <Composer
          value={text}
          onChange={setText}
          busy={busy}
          disabled={!ready || !last}
          placeholder={
            startsNew ? "Start a new session…" : asking ? "Reply…" : "Add to this session…"
          }
          submitLabel={startsNew ? "Start" : "Send"}
          hint={startsNew ? "This session has ended. Sending starts a new session." : undefined}
          onSubmit={async () => {
            if (!last) return;
            setBusy(true);
            setNotice(undefined);
            try {
              const id = await submit({
                productId: last.productId,
                repositoryId: last.repositoryId,
                text,
                idempotencyKey: crypto.randomUUID(),
                ...(startsNew ? {} : { sessionId }),
              });
              setText("");
              if (id !== sessionId) onOpen(id);
            } catch (error) {
              setNotice({
                tone: "danger",
                text: explainError(error, "Could not send. Try again."),
              });
            } finally {
              setBusy(false);
            }
          }}
        />
      }
    >
      {notices}
      {session?.productId && !ended && (
        <SessionWorkflow
          sessionId={sessionId}
          productId={session.productId}
          value={session.workflowId ?? ""}
        />
      )}
      <SessionApprovals sessionId={sessionId} ready={ready} />
      {confirmStop && (
        <div className="z-card z-stack" role="alertdialog" aria-label="Stop session">
          <p>Stop all work in this session? Running agents are interrupted on your computer.</p>
          <div className="z-row">
            <Button
              variant="danger"
              onClick={async () => {
                setConfirmStop(false);
                try {
                  await cancel({ workSessionId: sessionId });
                } catch (error) {
                  setNotice({
                    tone: "danger",
                    text: explainError(error, "Could not stop the session."),
                  });
                }
              }}
            >
              Stop session
            </Button>
            <Button variant="ghost" onClick={() => setConfirmStop(false)}>
              Keep running
            </Button>
          </div>
        </div>
      )}
      {session && (sortedTasks.length > 0 || session.status === "planning") && (
        <WorkMap
          ready={ready}
          productId={messages?.[0]?.productId ?? session.productId}
          workflowId={session.workflowId}
          sessionStatus={session.status}
          tasks={sortedTasks}
          runs={runs ?? []}
        />
      )}
      {session === undefined || messages === undefined ? (
        <p className="z-muted" role="status">
          Loading session…
        </p>
      ) : (
        <div className="z-chat-timeline" aria-live="polite">
          {messages.map((message) => (
            <div className="z-chat-timeline__item" key={message._id}>
              <span className="z-chat-timeline__marker" aria-hidden="true" />
              <div className="z-chat-timeline__exchange">
                <Message author="user" label="You" meta={relativeTime(message.createdAt, now)}>
                  {message.text}
                </Message>
                <AssistantMessage
                  message={message}
                  onError={(text) => setNotice({ tone: "danger", text })}
                />
              </div>
            </div>
          ))}
          {sortedTasks.length > 0 && (
            <section className="z-stack" aria-label="Work">
              <h2 className="z-section-title">Work</h2>
              {sortedTasks.map((task) => (
                <article className={`z-work z-work--${taskProcess(task)}`} key={task._id}>
                  <div className="z-work__head">
                    <h3 className="z-work__title">{task.title}</h3>
                    <StatusBadge status={task.phase ?? task.status} />
                  </div>
                  <TaskProgress
                    sessionStatus={session.status}
                    task={task}
                    runs={runsFor(task._id)}
                  />
                  {(task.trustOutcome || (task.repairAttempts ?? 0) > 0) && (
                    <div className="z-row z-xsmall z-muted">
                      {task.trustOutcome && <StatusBadge status={task.trustOutcome} />}
                      {(task.repairAttempts ?? 0) > 0 && (
                        <span>Repairs {task.repairAttempts}/2</span>
                      )}
                    </div>
                  )}
                  {task.failureReason && (
                    <p className="z-small z-muted">{explainFailure(task.failureReason)}</p>
                  )}
                  {task.status === "completed" && task.phase === "completed" && (
                    <PublishTask taskId={task._id} />
                  )}
                  {runsFor(task._id).length > 0 && (
                    <div className="z-work__runs">
                      {runsFor(task._id).map((run) => (
                        <div className="z-stack" key={run._id}>
                          <AgentRow
                            role={ROLE[run.role ?? "builder"] ?? "Agent"}
                            runtime={`${runtimeLabel({ runtime: run.runtime })}${
                              run.backup ? ` · backup ${run.backup}` : ""
                            }`}
                            model={run.modelActual ?? run.modelRequested}
                            status={run.status}
                            activity={run.activityLabel}
                            elapsedMs={
                              run.startedAt !== undefined
                                ? (ACTIVE_RUN.includes(run.status)
                                    ? now
                                    : (run.completedAt ?? now)) - run.startedAt
                                : undefined
                            }
                            tokens={run.totalTokens}
                            costUsd={run.estimatedCostUsd}
                            openLabel={`Open ${ROLE[run.role ?? "builder"] ?? "agent"} details`}
                            onOpen={() => setRunParam(run._id, "replace")}
                            onStatus={
                              run.status === "needs_approval"
                                ? () => showApprovals({ runId: run._id })
                                : undefined
                            }
                            actions={
                              ACTIVE_RUN.includes(run.status) || run.status === "lost" ? (
                                <Button
                                  variant="ghost"
                                  size="small"
                                  onClick={async () => {
                                    try {
                                      await stopRun({ runId: run._id });
                                    } catch (error) {
                                      setNotice({
                                        tone: "danger",
                                        text: explainError(error, "Could not stop this agent."),
                                      });
                                    }
                                  }}
                                >
                                  {run.status === "lost" ? "Dismiss" : "Stop"}
                                </Button>
                              ) : undefined
                            }
                          />
                          <ProofImages
                            images={(proof ?? []).filter((image) => image.runId === run._id)}
                            role={ROLE[run.role ?? "builder"] ?? "agent"}
                          />
                          {STEERABLE.includes(run.status) && <SteerRun runId={run._id} />}
                          <RunFailure run={run} />
                          {run.resultSummary?.trim() && (
                            <div className="z-small">
                              <Collapsible likelyLong={likelyLongSummary(run.resultSummary)}>
                                <Markdown>{run.resultSummary}</Markdown>
                              </Collapsible>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </section>
          )}
          {session.status === "needs_input" && (
            <Notice tone="warning">
              {session.contextSummary
                ? `Work paused: ${explainFailure(session.contextSummary)}.`
                : "Work paused and needs your attention."}
            </Notice>
          )}
          {session.status === "completed" &&
            (sortedTasks.some((task) => task.phase === "completed") ? (
              <Notice tone="success">
                The checked changes are ready on your computer. Open a pull request from each task
                when you want; merging stays with you.
              </Notice>
            ) : (
              <Notice tone="info">
                This session is closed. Send a message to pick it up again.
              </Notice>
            ))}
          <SessionUsage sessionId={sessionId} ready={ready} />
        </div>
      )}
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      <div ref={end} />
      {openRun && <RunDetail runId={openRun} onClose={() => setRunParam("", "replace")} />}
    </AppShell>
  );
}

// The current time, refreshed every second while `active`.
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function AssistantMessage({
  message,
  onError,
}: {
  message: UserMessage;
  onError: (text: string) => void;
}) {
  const state = assistantReply(message);
  const meta = usageLine(message);
  const stop = useMutation(api.supervisor.stop);
  const openProposal = useMutation(api.supervisor.openProposal);
  const [requested, setRequested] = useState(false);
  const [opening, setOpening] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const now = useNow(state.kind === "thinking" && state.startedAt !== undefined);
  // The Supervisor's log arrives once it settled; a withdrawn message never ran one.
  const logged = state.kind !== "thinking" && message.planStatus !== "expired";
  return (
    <Message author="assistant" label="Zamolxis" meta={meta}>
      {state.kind === "error" ? (
        <div className="z-stack">
          <span>{state.text}</span>
          {state.failure && <FailureDetails failure={state.failure} />}
        </div>
      ) : state.kind === "stopped" ? (
        <div className="z-row z-small z-muted">
          <StatusBadge status="stopped" />
          <span>Stopped before answering.</span>
        </div>
      ) : state.kind === "thinking" ? (
        <>
          {state.reply && <Markdown>{state.reply}</Markdown>}
          <div className="z-row">
            <Thinking
              detail={thinkingDetail(
                requested ? { ...state, stopping: true } : state,
                ["plan", "delegate"].includes(message.decision ?? "")
                  ? "Preparing tasks"
                  : "Reading the repository",
                now,
              )}
            />
            {state.stoppable && (
              <>
                <span className="z-spacer" />
                <Button
                  variant="ghost"
                  size="small"
                  disabled={requested || state.stopping}
                  aria-label="Stop the Supervisor"
                  onClick={async () => {
                    setRequested(true);
                    try {
                      await stop({ textCommandId: message._id as Id<"textCommands"> });
                    } catch (error) {
                      setRequested(false);
                      onError(explainError(error, "Could not stop the Supervisor."));
                    }
                  }}
                >
                  {requested || state.stopping ? "Stopping…" : "Stop"}
                </Button>
              </>
            )}
          </div>
        </>
      ) : state.kind === "proposal" ? (
        <>
          {state.reply && <Markdown>{state.reply}</Markdown>}
          <p className="z-small z-muted">{plannedLabel(state.taskCount, false)} No work opened.</p>
          {message.proposedTasks?.length ? (
            <ol className="z-small">
              {message.proposedTasks.map((task) => (
                <li key={task.key}>
                  <strong>{task.title}</strong>
                  <div className="z-xsmall z-muted">{task.description}</div>
                </li>
              ))}
            </ol>
          ) : null}
          <Button
            size="small"
            disabled={opening}
            onClick={async () => {
              setOpening(true);
              try {
                await openProposal({ textCommandId: message._id as Id<"textCommands"> });
              } catch (error) {
                onError(explainError(error, "Could not open this work."));
                setOpening(false);
              }
            }}
          >
            {opening ? "Opening…" : "Open this work"}
          </Button>
        </>
      ) : state.kind === "delegated" ? (
        <>
          {state.reply && <Markdown>{state.reply}</Markdown>}
          <p className="z-small z-muted">{plannedLabel(state.taskCount)} Builders can now run.</p>
        </>
      ) : (
        <>
          {state.kind === "ask" && <StatusBadge status="needs_input" label="Needs your answer" />}
          <Markdown>{state.reply}</Markdown>
        </>
      )}
      {logged && (
        <Button
          variant="ghost"
          size="small"
          aria-haspopup="dialog"
          onClick={() => setShowLog(true)}
        >
          Show what I did
        </Button>
      )}
      {showLog && (
        <SupervisorLog
          textCommandId={message._id as Id<"textCommands">}
          onClose={() => setShowLog(false)}
        />
      )}
    </Message>
  );
}

/**
 * The workflow this Session's next agents use: Default or one of the product's workflows.
 * Changing it does not touch agents already running or finished.
 */
function SessionWorkflow({
  sessionId,
  productId,
  value,
}: {
  sessionId: Id<"workSessions">;
  productId: Id<"products">;
  value: string;
}) {
  const workflows = useQuery(api.workflows.list, { productId }) as
    | Array<{ _id: Id<"agentWorkflows">; name: string; roles: number }>
    | undefined;
  const setWorkflow = useMutation(api.workflows.setForSession);
  const [problem, setProblem] = useState("");
  return (
    <section className="z-stack" aria-label="Workflow">
      <Picker
        label="Workflow"
        value={value}
        options={[
          { value: "", label: "Default", description: "The product's own agent settings." },
          ...(workflows ?? []).map((item) => ({
            value: item._id,
            label: item.name,
            description: `Its own agents for ${item.roles} ${item.roles === 1 ? "role" : "roles"}; the rest from the Default.`,
          })),
        ]}
        onChange={async (next) => {
          setProblem("");
          try {
            await setWorkflow({
              workSessionId: sessionId,
              ...(next ? { workflowId: next as Id<"agentWorkflows"> } : {}),
            });
          } catch (error) {
            setProblem(explainError(error, "Could not change the workflow."));
          }
        }}
      />
      <span className="z-xsmall z-muted">
        {workflows?.length
          ? "Applies to the agents this session starts from now on."
          : "Make workflows (for example Save tokens) in Settings → Agents → this product."}
      </span>
      {problem && <Notice tone="danger">{problem}</Notice>}
    </section>
  );
}
