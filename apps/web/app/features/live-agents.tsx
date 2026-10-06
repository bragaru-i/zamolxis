"use client";
import { AgentRow, Button } from "@zamolxis/ui";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { explainError } from "./errors";
import { runtimeLabel } from "./run-detail-model";
import { useNow } from "./workspace";

/** Mirrors `runs.listActive`. */
export interface LiveAgent {
  kind: "run" | "supervisor";
  _id: string;
  workSessionId: Id<"workSessions">;
  sessionTitle: string;
  taskTitle?: string;
  role: string;
  runtime?: string;
  status: string;
  modelRequested?: string;
  modelActual?: string;
  totalTokens?: number;
  costUsd?: number;
  activityLabel?: string;
  startedAt: number;
  lastActivityAt: number;
}

const ROLE: Record<string, string> = {
  supervisor: "Supervisor",
  builder: "Builder",
  verifier: "Verifier",
  repair: "Repair",
};
const STOPPABLE = new Set(["queued", "starting", "running", "waiting", "needs_approval"]);

/** The model an agent works with: the one it reported, else the one it was asked to use. */
export function agentModel(agent: Pick<LiveAgent, "modelActual" | "modelRequested">) {
  return agent.modelActual ?? agent.modelRequested;
}

/**
 * Agents working right now across all Sessions, each with its model, activity, elapsed time
 * and usage so far. Tapping one opens its Session (and Run detail for a run).
 */
export function LiveAgents({
  ready,
  onOpen,
}: {
  ready: boolean;
  onOpen: (id: Id<"workSessions">, runId?: Id<"agentRuns">) => void;
}) {
  const agents = useQuery(api.runs.listActive, ready ? {} : "skip") as LiveAgent[] | undefined;
  const now = useNow(1000);
  const stop = useMutation(api.runs.stop);
  const [problem, setProblem] = useState("");
  if (!agents?.length) return null;
  const sessions = new Set(agents.map((agent) => agent.workSessionId)).size;
  return (
    <section className="z-stack" aria-label="Working now">
      <div className="z-row z-row--between">
        <h2 className="z-section-title">Working now</h2>
        <span className="z-xsmall z-muted">
          {agents.length} {agents.length === 1 ? "agent" : "agents"} ·{" "}
          {sessions === 1 ? "1 session" : `${sessions} sessions`}
        </span>
      </div>
      <div className="z-agents">
        {agents.map((agent) => (
          <AgentRow
            key={agent._id}
            role={ROLE[agent.role] ?? "Agent"}
            runtime={agent.runtime ? runtimeLabel({ runtime: agent.runtime }) : undefined}
            model={agentModel(agent)}
            status={agent.status}
            activity={agent.activityLabel}
            elapsedMs={now - agent.startedAt}
            tokens={agent.totalTokens}
            costUsd={agent.costUsd}
            context={
              agent.taskTitle ? `${agent.taskTitle} · ${agent.sessionTitle}` : agent.sessionTitle
            }
            openLabel={`Open ${ROLE[agent.role] ?? "agent"} in ${agent.sessionTitle}`}
            onOpen={() =>
              onOpen(
                agent.workSessionId,
                agent.kind === "run" ? (agent._id as Id<"agentRuns">) : undefined,
              )
            }
            actions={
              agent.kind === "run" && STOPPABLE.has(agent.status) ? (
                <Button
                  variant="ghost"
                  size="small"
                  onClick={async () => {
                    setProblem("");
                    try {
                      await stop({ runId: agent._id as Id<"agentRuns"> });
                    } catch (error) {
                      setProblem(explainError(error, "Could not stop this agent."));
                    }
                  }}
                >
                  Stop
                </Button>
              ) : undefined
            }
          />
        ))}
      </div>
      {problem && (
        <p className="z-notice z-tone-danger" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
