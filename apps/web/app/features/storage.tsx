"use client";
import { Button, KeyValueList, Notice, StatusBadge } from "@zamolxis/ui";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { errorCode, explainError } from "./errors";
import { relativeTime } from "./time";

/** Mirrors `workspaces:storage` in convex/workspaces.ts. */
export interface MacStorage {
  workstationId: Id<"workstations">;
  name: string;
  online: boolean;
  managed: number;
  eligible: number;
  pending: number;
  failed: number;
  truncated: boolean;
  lastCleanupAt?: number;
}
export interface StorageSummary {
  retentionDays: number;
  defaultRetentionDays: number;
  minRetentionDays: number;
  maxRetentionDays: number;
  batch: number;
  macs: MacStorage[];
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

function MacRow({
  mac,
  now,
  onMessage,
}: {
  mac: MacStorage;
  now: number;
  onMessage: (message: { tone: "success" | "danger"; text: string }) => void;
}) {
  const cleanup = useMutation(api.workspaces.cleanupNow);
  const [busy, setBusy] = useState(false);
  async function clean() {
    setBusy(true);
    try {
      const { requested } = await cleanup({ workstationId: mac.workstationId });
      onMessage({
        tone: "success",
        text: requested
          ? `Asked ${mac.name} to remove ${plural(requested, "worktree")}.`
          : "Nothing to remove right now.",
      });
    } catch (error) {
      onMessage({
        tone: "danger",
        text:
          errorCode(error) === "WORKSTATION_OFFLINE"
            ? `${mac.name} is offline. Cleanup runs when it is back.`
            : explainError(error, "Could not start cleanup."),
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="z-list-item">
      <span className="z-list-item__title">{mac.name}</span>
      {!mac.online && (
        <div className="z-row">
          <StatusBadge status="stopped" label="Offline" />
        </div>
      )}
      <KeyValueList
        label={`Worktrees on ${mac.name}`}
        items={[
          {
            key: "managed",
            label: "Managed worktrees",
            value: `${mac.managed.toLocaleString("en-US")}${mac.truncated ? "+" : ""}`,
          },
          { key: "eligible", label: "Can be removed now", value: mac.eligible },
          ...(mac.pending
            ? [{ key: "pending", label: "Removal requested", value: mac.pending }]
            : []),
          ...(mac.failed
            ? [{ key: "failed", label: "Kept after a failed removal", value: mac.failed }]
            : []),
          {
            key: "last",
            label: "Last cleanup",
            value: mac.lastCleanupAt ? relativeTime(mac.lastCleanupAt, now) : "Never",
          },
        ]}
      />
      <div className="z-row">
        <Button
          size="small"
          variant="secondary"
          disabled={busy || !mac.online || mac.eligible === 0}
          onClick={() => void clean()}
        >
          {busy ? "Cleaning up…" : "Clean up now"}
        </Button>
      </div>
    </div>
  );
}

/** Settings section: managed worktrees per Mac, retention window and on-demand cleanup. */
export function StorageSettings({ active, now }: { active: boolean; now: number }) {
  const storage = useQuery(api.workspaces.storage, active ? {} : "skip") as
    | StorageSummary
    | undefined;
  const setDays = useMutation(api.workspaces.setRetentionDays);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string }>();
  async function changeDays(days: number) {
    try {
      await setDays({ days });
      setMessage({ tone: "success", text: `Worktrees are kept ${plural(days, "day")}.` });
    } catch (error) {
      setMessage({ tone: "danger", text: explainError(error, "Could not save the setting.") });
    }
  }
  return (
    <section className="z-stack" aria-label="Storage">
      <h3 className="z-section-title">Storage</h3>
      {storage === undefined ? (
        <p className="z-muted z-small" role="status">
          Loading storage…
        </p>
      ) : (
        <>
          {storage.macs.length ? (
            <div className="z-list">
              {storage.macs.map((mac) => (
                <MacRow key={mac.workstationId} mac={mac} now={now} onMessage={setMessage} />
              ))}
            </div>
          ) : (
            <p className="z-muted z-small">No Mac paired yet.</p>
          )}
          <label className="z-field">
            Keep finished work for
            <select
              className="z-select"
              value={storage.retentionDays}
              onChange={(event) => void changeDays(Number(event.target.value))}
            >
              {Array.from(
                { length: storage.maxRetentionDays - storage.minRetentionDays + 1 },
                (_, index) => storage.minRetentionDays + index,
              ).map((days) => (
                <option key={days} value={days}>
                  {plural(days, "day")}
                  {days === storage.defaultRetentionDays ? " (default)" : ""}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      <p className="z-xsmall z-muted">
        Zamolxis removes worktrees of finished sessions every hour, at most {storage?.batch ?? 10}{" "}
        per Mac at a time. Planning worktrees go one day after the Supervisor decided. Trusted work
        that was not published, worktrees with uncommitted changes and anything still in use are
        always kept. Your own branches are never touched.
      </p>
    </section>
  );
}
