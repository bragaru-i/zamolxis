"use client";
import { Button, Notice, StatusBadge } from "@zamolxis/ui";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { errorCode, explainError } from "./errors";
import { relativeTime } from "./time";

type Access = "pending" | "allowed" | "blocked";
export interface Person {
  userId: Id<"users">;
  email: string | null;
  name: string | null;
  accessStatus: Access;
  isAdmin: boolean;
  isSelf: boolean;
  createdAt: number;
  lastSignInAt: number | null;
}
type Action = "approve" | "block" | "makeAdmin" | "removeAdmin";

const STATE: Record<Access, { status: string; label: string }> = {
  pending: { status: "waiting", label: "Waiting for approval" },
  allowed: { status: "completed", label: "Has access" },
  blocked: { status: "failed", label: "Blocked" },
};

const CONFIRM: Record<Action, { button: string; text: (who: string) => string }> = {
  approve: {
    button: "Approve",
    text: (who) => `Give ${who} access to Zamolxis? They will only see their own work.`,
  },
  block: {
    button: "Block",
    text: (who) =>
      `Block ${who}? They are signed out on every device and their computers stop working. Their data is kept.`,
  },
  makeAdmin: {
    button: "Make admin",
    text: (who) => `Let ${who} approve and block people?`,
  },
  removeAdmin: {
    button: "Remove admin",
    text: (who) => `Stop ${who} from approving and blocking people?`,
  },
};

const ERRORS: Record<string, string> = {
  LAST_ADMIN: "At least one administrator must keep access.",
  INVALID_STATE: "That change isn't possible for this person.",
};

export function actionsFor(person: Person): Action[] {
  if (person.isSelf) return [];
  if (person.accessStatus === "pending") return ["approve", "block"];
  if (person.accessStatus === "blocked") return ["approve"];
  return [person.isAdmin ? "removeAdmin" : "makeAdmin", "block"];
}

export function PeopleSection({ active, now }: { active: boolean; now: number }) {
  const role = useQuery(api.admin.viewerRole, active ? {} : "skip");
  const people = useQuery(api.admin.listUsers, active && role?.isAdmin ? {} : "skip") as
    | Person[]
    | undefined;
  const setAccess = useMutation(api.admin.setAccess);
  const setAdmin = useMutation(api.admin.setAdmin);
  const [confirming, setConfirming] = useState<{ userId: Id<"users">; action: Action }>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string }>();
  if (!role?.isAdmin) return null;
  const waiting = people?.filter((person) => person.accessStatus === "pending").length ?? 0;

  async function run(person: Person, action: Action) {
    const who = person.email ?? "this person";
    setBusy(true);
    try {
      if (action === "approve") await setAccess({ userId: person.userId, accessStatus: "allowed" });
      else if (action === "block")
        await setAccess({ userId: person.userId, accessStatus: "blocked" });
      else await setAdmin({ userId: person.userId, admin: action === "makeAdmin" });
      const done: Record<Action, string> = {
        approve: `${who} now has access.`,
        block: `${who} is blocked and signed out.`,
        makeAdmin: `${who} is now an administrator.`,
        removeAdmin: `${who} is no longer an administrator.`,
      };
      setMessage({ tone: "success", text: done[action] });
    } catch (error) {
      const code = errorCode(error);
      setMessage({
        tone: "danger",
        text: (code && ERRORS[code]) ?? explainError(error, "Could not change access."),
      });
    } finally {
      setBusy(false);
      setConfirming(undefined);
    }
  }

  return (
    <section className="z-stack" aria-label="People">
      <h3 className="z-section-title">People</h3>
      <p className="z-muted z-small">
        {waiting
          ? `${waiting} ${waiting === 1 ? "person is" : "people are"} waiting for approval.`
          : "New people appear here after they sign in with Google."}
      </p>
      {people === undefined ? (
        <p className="z-muted z-small">Loading people…</p>
      ) : (
        <div className="z-list">
          {people.map((person) => {
            const who = person.email ?? "this person";
            const state = STATE[person.accessStatus];
            const pending = confirming?.userId === person.userId ? confirming.action : undefined;
            return (
              <div className="z-list-item" key={person.userId}>
                <span className="z-list-item__title">
                  {person.name ?? person.email ?? "Unnamed account"}
                  {person.isSelf && " (you)"}
                </span>
                {person.name && person.email && (
                  <span className="z-muted z-small">{person.email}</span>
                )}
                <div className="z-row">
                  <StatusBadge status={state.status} label={state.label} />
                  {person.isAdmin && <StatusBadge status="ready" label="Admin" />}
                </div>
                <span className="z-muted z-xsmall">
                  Joined {relativeTime(person.createdAt, now)}
                  {person.lastSignInAt !== null &&
                    ` · last signed in ${relativeTime(person.lastSignInAt, now)}`}
                </span>
                {pending ? (
                  <div className="z-stack">
                    <p className="z-small">{CONFIRM[pending].text(who)}</p>
                    <div className="z-row">
                      <Button
                        size="small"
                        variant={pending === "block" ? "danger" : "primary"}
                        disabled={busy}
                        onClick={() => void run(person, pending)}
                      >
                        {CONFIRM[pending].button}
                      </Button>
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setConfirming(undefined)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  actionsFor(person).length > 0 && (
                    <div className="z-row">
                      {actionsFor(person).map((action) => (
                        <Button
                          key={action}
                          size="small"
                          variant={action === "approve" ? "primary" : "ghost"}
                          onClick={() => {
                            setMessage(undefined);
                            setConfirming({ userId: person.userId, action });
                          }}
                        >
                          {action === "approve" && person.accessStatus === "blocked"
                            ? "Restore access…"
                            : `${CONFIRM[action].button}…`}
                        </Button>
                      ))}
                    </div>
                  )
                )}
              </div>
            );
          })}
        </div>
      )}
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
    </section>
  );
}
