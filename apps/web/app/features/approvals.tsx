"use client";
import { Button, Card, Notice, type Tone } from "@zamolxis/ui";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { explainError } from "./errors";

type Risk = "low" | "medium" | "high" | "critical";
export interface PendingApproval {
  _id: Id<"approvals">;
  workSessionId: Id<"workSessions">;
  runId?: Id<"agentRuns">;
  action: string;
  risk: Risk;
  request?: { kind?: string; summary?: string };
  requestedAt: number;
}

// Risk is always spelled out; colour only reinforces it.
export const RISK: Record<Risk, { tone: Tone; label: string }> = {
  low: { tone: "neutral", label: "Low risk" },
  medium: { tone: "warning", label: "Medium risk" },
  high: { tone: "danger", label: "High risk" },
  critical: { tone: "danger", label: "Critical risk" },
};
const ASK: Record<string, string> = {
  command: "Agent wants to run",
  fileChange: "Agent wants to change files",
  tool: "Agent wants to use a tool",
};
export function approvalTitle(approval: PendingApproval): string {
  return ASK[approval.request?.kind ?? approval.action] ?? "Agent asks for permission";
}

export function ApprovalCard({
  approval,
  onOpen,
}: {
  approval: PendingApproval;
  onOpen?: (id: Id<"workSessions">) => void;
}) {
  const resolve = useMutation(api.approvals.resolve);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const risk = RISK[approval.risk] ?? RISK.critical;
  const decide = async (decision: "approved" | "rejected") => {
    // Critical requests need a second, deliberate tap to approve.
    if (decision === "approved" && approval.risk === "critical" && !confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await resolve({ approvalId: approval._id, decision });
    } catch (failure) {
      setError(explainError(failure, "Could not send your decision. Try again."));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  return (
    <Card label={approvalTitle(approval)}>
      <div className="z-row z-small">
        <strong>{approvalTitle(approval)}</strong>
        <span className="z-spacer" />
        <span className={`z-badge z-tone-${risk.tone}`}>{risk.label}</span>
      </div>
      <p className="z-small" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {approval.request?.summary ?? approval.action}
      </p>
      {confirming && (
        <Notice tone="danger">
          This touches credentials, the network or files outside the task. Approve only if you
          expected it.
        </Notice>
      )}
      <div className="z-row">
        <Button
          variant={confirming ? "danger" : "primary"}
          size="small"
          disabled={busy}
          onClick={() => decide("approved")}
        >
          {confirming ? "Approve anyway" : "Approve"}
        </Button>
        <Button variant="secondary" size="small" disabled={busy} onClick={() => decide("rejected")}>
          Reject
        </Button>
        <span className="z-spacer" />
        {onOpen && (
          <Button variant="ghost" size="small" onClick={() => onOpen(approval.workSessionId)}>
            Open session
          </Button>
        )}
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
    </Card>
  );
}

/** Pending requests in one session, shown above its conversation. */
export function SessionApprovals({
  sessionId,
  ready,
}: {
  sessionId: Id<"workSessions">;
  ready: boolean;
}) {
  const approvals = useQuery(
    api.approvals.listPendingBySession,
    ready ? { workSessionId: sessionId } : "skip",
  ) as PendingApproval[] | undefined;
  if (!approvals?.length) return null;
  return (
    <section className="z-stack" aria-label="Approvals">
      {approvals.map((approval) => (
        <ApprovalCard key={approval._id} approval={approval} />
      ))}
    </section>
  );
}

/** Every pending request across sessions, at the top of the sessions list. */
export function ApprovalsInbox({
  ready,
  onOpen,
}: {
  ready: boolean;
  onOpen: (id: Id<"workSessions">) => void;
}) {
  const approvals = useQuery(api.approvals.listPending, ready ? {} : "skip") as
    | PendingApproval[]
    | undefined;
  if (!approvals?.length) return null;
  const shown = [...approvals].sort((a, b) => a.requestedAt - b.requestedAt).slice(0, 3);
  return (
    <section className="z-stack" aria-label="Needs your approval">
      <Notice tone="warning">
        {approvals.length === 1
          ? "An agent is waiting for your approval."
          : `${approvals.length} agent requests are waiting for your approval.`}
      </Notice>
      {shown.map((approval) => (
        <ApprovalCard key={approval._id} approval={approval} onOpen={onOpen} />
      ))}
    </section>
  );
}
