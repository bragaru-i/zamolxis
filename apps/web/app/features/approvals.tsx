"use client";
import { Button, Card, Notice, StatusBadge, Toast, ToastStack, type Tone } from "@zamolxis/ui";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
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
  request?: { kind?: string; summary?: string; allowForSession?: boolean };
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

/** The decision flow one request shares between its card and its toast. */
export function useApprovalDecision(approval: PendingApproval) {
  const resolve = useMutation(api.approvals.resolve);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const decide = async (decision: "approved" | "rejected", scope: "once" | "run" = "once") => {
    // Critical requests need a second, deliberate tap to approve.
    if (decision === "approved" && approval.risk === "critical" && !confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await resolve({ approvalId: approval._id, decision, scope });
    } catch (failure) {
      setError(explainError(failure, "Could not send your decision. Try again."));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  return { busy, confirming, error, decide };
}

function ApprovalButtons({
  approval,
  state,
  onOpen,
}: {
  approval: PendingApproval;
  state: ReturnType<typeof useApprovalDecision>;
  onOpen?: (id: Id<"workSessions">) => void;
}) {
  const { busy, confirming, decide } = state;
  return (
    <>
      <Button
        variant={confirming ? "danger" : "primary"}
        size="small"
        disabled={busy}
        onClick={() => decide("approved", "once")}
      >
        {confirming
          ? "Approve anyway"
          : approval.request?.allowForSession
            ? "Approve once"
            : "Approve"}
      </Button>
      {approval.request?.allowForSession && !confirming && (
        <Button
          variant="secondary"
          size="small"
          disabled={busy}
          onClick={() => decide("approved", "run")}
        >
          Approve for run
        </Button>
      )}
      <Button variant="secondary" size="small" disabled={busy} onClick={() => decide("rejected")}>
        Reject
      </Button>
      <span className="z-spacer" />
      {onOpen && (
        <Button variant="ghost" size="small" onClick={() => onOpen(approval.workSessionId)}>
          Open session
        </Button>
      )}
    </>
  );
}

const CRITICAL_WARNING =
  "This touches credentials, the network or files outside the task. Approve only if you expected it.";

export function ApprovalCard({
  approval,
  onOpen,
}: {
  approval: PendingApproval;
  onOpen?: (id: Id<"workSessions">) => void;
}) {
  const state = useApprovalDecision(approval);
  const risk = RISK[approval.risk] ?? RISK.critical;
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
      {approval.request?.allowForSession && (
        <p className="z-muted z-small">
          You can allow similar safe commands until this agent run finishes.
        </p>
      )}
      {state.confirming && <Notice tone="danger">{CRITICAL_WARNING}</Notice>}
      <div className="z-row">
        <ApprovalButtons approval={approval} state={state} {...(onOpen ? { onOpen } : {})} />
      </div>
      {state.error && <Notice tone="danger">{state.error}</Notice>}
    </Card>
  );
}

/** One pending request as a toast: the same decision as the card, wherever the owner is. */
export function ApprovalToast({
  approval,
  onOpen,
  onDismiss,
  highlighted = false,
}: {
  approval: PendingApproval;
  onOpen: (id: Id<"workSessions">) => void;
  onDismiss: () => void;
  highlighted?: boolean;
}) {
  const state = useApprovalDecision(approval);
  const risk = RISK[approval.risk] ?? RISK.critical;
  return (
    <Toast
      title={approvalTitle(approval)}
      tone={risk.tone === "neutral" ? "info" : risk.tone}
      meta={<span className={`z-badge z-tone-${risk.tone}`}>{risk.label}</span>}
      onDismiss={onDismiss}
      highlighted={highlighted}
      actions={<ApprovalButtons approval={approval} state={state} onOpen={onOpen} />}
    >
      {approval.request?.summary ?? approval.action}
      {state.confirming && <Notice tone="danger">{CRITICAL_WARNING}</Notice>}
      {state.error && <Notice tone="danger">{state.error}</Notice>}
    </Toast>
  );
}

const TOASTS_SHOWN = 3;
const HIGHLIGHT_MS = 2500;

/** Which requests to bring up: one run's, or every request of a Session. */
export interface ApprovalFocus {
  runId?: string;
  workSessionId?: string;
}
const focusListeners = new Set<(focus: ApprovalFocus) => void>();
/** Brings the matching requests' toasts back (even if dismissed), first and highlighted. */
export function showApprovals(focus: ApprovalFocus): void {
  for (const listener of focusListeners) listener(focus);
}
export function matchesFocus(approval: PendingApproval, focus: ApprovalFocus): boolean {
  return focus.runId
    ? approval.runId === focus.runId
    : approval.workSessionId === focus.workSessionId;
}

/**
 * Pending requests as toasts on every screen, the open Session and Run detail included;
 * a dismissed toast stays in the inbox and the Session, and a "Needs approval" chip
 * brings it back (`showApprovals`).
 */
export function ApprovalToasts({
  ready,
  onOpen,
}: {
  ready: boolean;
  onOpen: (id: Id<"workSessions">) => void;
}) {
  const approvals = useQuery(api.approvals.listPending, ready ? {} : "skip") as
    | PendingApproval[]
    | undefined;
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [focused, setFocused] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listener = (focus: ApprovalFocus) => {
      const ids = (approvals ?? [])
        .filter((approval) => matchesFocus(approval, focus))
        .map((approval) => approval._id as string);
      if (!ids.length) return;
      setDismissed((current) => new Set([...current].filter((id) => !ids.includes(id))));
      setFocused(new Set(ids));
      clearTimeout(timer);
      timer = setTimeout(() => setFocused(new Set()), HIGHLIGHT_MS);
    };
    focusListeners.add(listener);
    return () => {
      focusListeners.delete(listener);
      clearTimeout(timer);
    };
  }, [approvals]);
  const waiting = (approvals ?? [])
    .filter((approval) => !dismissed.has(approval._id))
    // The requests the owner asked for come first, then the oldest.
    .sort(
      (a, b) =>
        Number(focused.has(b._id)) - Number(focused.has(a._id)) || a.requestedAt - b.requestedAt,
    );
  const shown = waiting.slice(0, TOASTS_SHOWN);
  const more = waiting.length - shown.length;
  return (
    <ToastStack label="Approvals waiting">
      {shown.map((approval) => (
        <ApprovalToast
          key={approval._id}
          approval={approval}
          highlighted={focused.has(approval._id)}
          onOpen={onOpen}
          onDismiss={() => setDismissed((current) => new Set(current).add(approval._id))}
        />
      ))}
      {more > 0 && (
        <Toast title={`${more} more waiting`} tone="warning">
          Older requests are listed on Home under "Needs your approval".
        </Toast>
      )}
    </ToastStack>
  );
}

/** A status chip; "Needs approval" is a button that brings up that run's request. */
export function ApprovalStatusBadge({ status, runId }: { status: string; runId: string }) {
  if (status !== "needs_approval") return <StatusBadge status={status} />;
  return (
    <button
      type="button"
      className="z-badge z-badge--action z-tone-warning"
      onClick={() => showApprovals({ runId })}
    >
      Needs approval ›
    </button>
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
