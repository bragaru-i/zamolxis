"use client";
import {
  AppHeader,
  AppShell,
  Button,
  Collapsible,
  Composer,
  Markdown,
  Message,
  Notice,
  StatusBadge,
  Thinking,
} from "@zamolxis/ui";
import { useMutation, useQuery } from "convex/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import {
  assistantReply,
  type ConversationMessage,
  likelyLongSummary,
  plannedLabel,
  startsNewSession,
  usageLine,
} from "./conversation";
import { explainError, explainFailure } from "./errors";
import { RunDetail } from "./run-detail";
import { SessionUsage } from "./usage";

interface Session {
  _id: Id<"workSessions">;
  title: string;
  status: string;
  activeRunCount?: number;
  contextSummary?: string;
}
interface UserMessage extends ConversationMessage {
  _id: string;
  text: string;
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
  status: string;
  activityLabel?: string;
  totalTokens?: number;
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
  const submit = useMutation(api.supervisor.submit);
  const cancel = useMutation(api.sessions.cancel);
  const stopRun = useMutation(api.runs.stop);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [openRun, setOpenRun] = useState<Id<"agentRuns">>();
  const [notice, setNotice] = useState<{ tone: "danger" | "info"; text: string }>();
  const end = useRef<HTMLDivElement>(null);
  const count = (messages?.length ?? 0) + (tasks?.length ?? 0) + (runs?.length ?? 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when new content arrives.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [count]);
  const ended = session ? ENDED.includes(session.status) : false;
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
          leading={
            <Button variant="ghost" onClick={onBack} aria-label="Back to sessions">
              ‹ Sessions
            </Button>
          }
          title={session?.title ?? "Session"}
          subtitle={
            <>
              {session && <StatusBadge status={session.status} />}
              {indicator}
            </>
          }
          trailing={
            session &&
            // An idle session waiting for the user has nothing to stop.
            !ended &&
            (session.status !== "waiting" || (session.activeRunCount ?? 0) > 0) && (
              <Button variant="danger" size="small" onClick={() => setConfirmStop(true)}>
                Stop
              </Button>
            )
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
      {confirmStop && (
        <div className="z-card z-stack" role="alertdialog" aria-label="Stop session">
          <p>Stop all work in this session? Running agents are interrupted on your Mac.</p>
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
      {session === undefined || messages === undefined ? (
        <p className="z-muted" role="status">
          Loading session…
        </p>
      ) : (
        <div className="z-stack" aria-live="polite">
          {messages.map((message) => (
            <div className="z-stack" key={message._id}>
              <Message author="user" label="You">
                {message.text}
              </Message>
              <AssistantMessage message={message} />
            </div>
          ))}
          {sortedTasks.length > 0 && (
            <section className="z-stack" aria-label="Work">
              <h2 className="z-section-title">Work</h2>
              {sortedTasks.map((task) => (
                <article className="z-work" key={task._id}>
                  <div className="z-work__head">
                    <h3 className="z-work__title">{task.title}</h3>
                    <StatusBadge status={task.phase ?? task.status} />
                  </div>
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
                  {runsFor(task._id).length > 0 && (
                    <div className="z-work__runs">
                      {runsFor(task._id).map((run) => (
                        <div className="z-stack" key={run._id}>
                          <div className="z-row z-small">
                            <button
                              type="button"
                              className="z-pressable"
                              aria-haspopup="dialog"
                              onClick={() => setOpenRun(run._id)}
                            >
                              <strong>{ROLE[run.role ?? "builder"] ?? "Agent"}</strong>
                              <StatusBadge status={run.status} />
                              {run.totalTokens !== undefined && (
                                <span className="z-xsmall z-muted">
                                  {run.totalTokens.toLocaleString()} tokens
                                </span>
                              )}
                              <span className="z-pressable__chevron" aria-hidden="true">
                                ›
                              </span>
                            </button>
                            <span className="z-spacer" />
                            {ACTIVE_RUN.includes(run.status) && (
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
                                Stop
                              </Button>
                            )}
                          </div>
                          {run.activityLabel && ACTIVE_RUN.includes(run.status) && (
                            <span className="z-xsmall z-muted">{run.activityLabel}</span>
                          )}
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
          {session.status === "completed" && (
            <Notice tone="success">
              Trusted changes are ready on local integration branches on your Mac. Publishing and
              merging stay with you.
            </Notice>
          )}
          <SessionUsage sessionId={sessionId} ready={ready} />
        </div>
      )}
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      <div ref={end} />
      {openRun && <RunDetail runId={openRun} onClose={() => setOpenRun(undefined)} />}
    </AppShell>
  );
}

function AssistantMessage({ message }: { message: UserMessage }) {
  const state = assistantReply(message);
  const meta = usageLine(message);
  return (
    <Message author="assistant" label="Zamolxis" meta={meta}>
      {state.kind === "error" ? (
        state.text
      ) : state.kind === "thinking" ? (
        <>
          {state.reply && <Markdown>{state.reply}</Markdown>}
          <Thinking
            detail={message.decision === "plan" ? "Preparing tasks" : "Reading the repository"}
          />
        </>
      ) : state.kind === "plan" ? (
        <>
          {state.reply && <Markdown>{state.reply}</Markdown>}
          <p className="z-small z-muted">{plannedLabel(state.taskCount)}</p>
        </>
      ) : (
        <>
          {state.kind === "ask" && <StatusBadge status="needs_input" label="Needs your answer" />}
          <Markdown>{state.reply}</Markdown>
        </>
      )}
    </Message>
  );
}
