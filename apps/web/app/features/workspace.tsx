"use client";
import { useAuthActions } from "@convex-dev/auth/react";
import {
  Button,
  Card,
  ConnectionIndicator,
  Notice,
  Sheet,
  StatusBadge,
  TextInput,
} from "@zamolxis/ui";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useId, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { AgentsSettings } from "./agents";
import { DevicesSection } from "./devices";
import { errorCode, explainError } from "./errors";
import { PeopleSection } from "./people";
import { SessionView } from "./session-view";
import { SessionList } from "./sessions";
import { StorageSettings } from "./storage";
import { UsageSettings } from "./usage";
import { useSearchParam } from "./use-location";

export interface Device {
  _id: Id<"workstations">;
  name: string;
  status: string;
  lastHeartbeatAt?: number;
  runtimes: Array<{ runtime: string; status: string }>;
}

export function deviceState(device: Device, now: number) {
  if (device.status === "revoked") return "revoked" as const;
  return device.status === "online" && (device.lastHeartbeatAt ?? 0) > now - 45000
    ? ("online" as const)
    : ("offline" as const);
}

export function useNow(interval = 15000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

export function Workspace() {
  const ensure = useMutation(api.profiles.ensure);
  const [ready, setReady] = useState(false);
  const [problem, setProblem] = useState("");
  const [sessionId, setSessionId] = useSearchParam("session");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const now = useNow();
  useEffect(() => {
    void ensure({})
      .then(() => setReady(true))
      .catch(() => setProblem("Could not load your profile. Refresh to try again."));
  }, [ensure]);
  const devices = useQuery(api.workstations.listMine, ready ? {} : "skip") as Device[] | undefined;
  const active = devices?.filter((device) => device.status !== "revoked") ?? [];
  const online = active.filter((device) => deviceState(device, now) === "online");
  const connection =
    devices === undefined
      ? { state: "none" as const, label: "Checking Mac…" }
      : online.length
        ? { state: "online" as const, label: "Mac online" }
        : active.length
          ? { state: "offline" as const, label: "Mac offline" }
          : { state: "none" as const, label: "No Mac paired" };
  const indicator = (
    <button
      type="button"
      className="z-button z-button--ghost z-button--small"
      onClick={() => setSettingsOpen(true)}
      aria-label={`${connection.label}. Open settings`}
    >
      <ConnectionIndicator state={connection.state} label={connection.label} />
    </button>
  );
  const notices = (
    <>
      {problem && <Notice tone="danger">{problem}</Notice>}
      <PairingApproval ready={ready} />
      {/* Connecting a Mac is the onboarding checklist's first open step (sessions screen). */}
    </>
  );
  return (
    <>
      {sessionId ? (
        <SessionView
          key={sessionId}
          sessionId={sessionId as Id<"workSessions">}
          ready={ready}
          indicator={indicator}
          notices={notices}
          onBack={() => setSessionId("")}
          onOpen={(id) => setSessionId(id, "replace")}
        />
      ) : (
        <SessionList
          ready={ready}
          indicator={indicator}
          notices={notices}
          onOpen={(id) => setSessionId(id)}
          onSettings={() => setSettingsOpen(true)}
        />
      )}
      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        devices={devices}
        now={now}
        onOpenSession={(id) => {
          setSettingsOpen(false);
          setSessionId(id);
        }}
      />
    </>
  );
}

function PairingApproval({ ready }: { ready: boolean }) {
  const [pair, setPair] = useSearchParam("pair");
  const approve = useMutation(api.pairing.approve);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "danger"; text: string }>();
  const valid = /^[a-f0-9]{64}$/.test(pair);
  const pairing = useQuery(api.pairing.preview, ready && valid ? { approvalCode: pair } : "skip");
  if (result) return <Notice tone={result.tone}>{result.text}</Notice>;
  if (!valid) return null;
  return (
    <Card label="Approve Mac">
      <h2 className="z-title">Approve {pairing?.name ?? "this Mac"}?</h2>
      <p className="z-muted z-small">
        Only approve the QR code you just opened from setup on your own Mac. It expires after five
        minutes.
      </p>
      <Button
        block
        disabled={busy || !ready || !pairing?.pending}
        onClick={async () => {
          setBusy(true);
          try {
            await approve({ approvalCode: pair });
            setResult({
              tone: "success",
              text: "Mac approved. Setup on your Mac is finishing and starting the Node.",
            });
          } catch (error) {
            setResult({
              tone: "danger",
              text: explainError(
                error,
                "This code expired or was already used. Rerun setup on your Mac for a new QR code.",
              ),
            });
          } finally {
            setPair("", "replace");
            setBusy(false);
          }
        }}
      >
        Approve this Mac
      </Button>
    </Card>
  );
}

function Settings({
  open,
  onClose,
  devices,
  now,
  onOpenSession,
}: {
  open: boolean;
  onClose: () => void;
  devices: Device[] | undefined;
  now: number;
  onOpenSession: (id: Id<"workSessions">) => void;
}) {
  const { signOut } = useAuthActions();
  const [message, setMessage] = useState("");
  return (
    <Sheet open={open} title="Settings" onClose={onClose}>
      <section className="z-stack">
        <h3 className="z-section-title">Macs</h3>
        {devices?.length ? (
          <div className="z-list">
            {devices.map((device) => (
              <MacItem key={device._id} device={device} now={now} onMessage={setMessage} />
            ))}
          </div>
        ) : (
          <p className="z-muted z-small">
            No Mac paired yet. Run <code>pnpm zamolxis setup</code> on your Mac.
          </p>
        )}
        {message && <Notice>{message}</Notice>}
      </section>
      <AgentsSettings active={open} devices={devices} />
      <UsageSettings active={open} onOpenSession={onOpenSession} />
      <StorageSettings active={open} now={now} />
      <PeopleSection active={open} now={now} />
      <DevicesSection active={open} now={now} />
      <Button
        variant="secondary"
        block
        onClick={() => void signOut().catch(() => setMessage("Could not sign out"))}
      >
        Sign out
      </Button>
    </Sheet>
  );
}

/** Same rule as the backend: trimmed, 1..64 characters. */
export function macNameProblem(value: string): string | undefined {
  const name = value.trim();
  if (!name) return "Enter a name.";
  if (name.length > 64) return "Use at most 64 characters.";
  return undefined;
}

const MAC_ERRORS: Record<string, string> = {
  LOCATION_BUSY:
    "Work is still running in this repository on this Mac. Remove it once that work has finished.",
  INVALID_ARGUMENT: "Use a name of 1 to 64 characters.",
  INVALID_STATE: "This Mac was removed.",
};
export function explainMacError(error: unknown, fallback: string) {
  const code = errorCode(error);
  return (code && MAC_ERRORS[code]) ?? explainError(error, fallback);
}

export interface MacLocation {
  repositoryLocationId: Id<"repositoryLocations">;
  repositoryName: string;
  canonicalPath: string;
  status: string;
}

type MacMode = "idle" | "rename" | "repositories" | "revoke";

export function MacItem({
  device,
  now,
  onMessage,
  initialMode = "idle",
}: {
  device: Device;
  now: number;
  onMessage: (message: string) => void;
  initialMode?: MacMode;
}) {
  const revoke = useMutation(api.workstations.revoke);
  const rename = useMutation(api.workstations.rename);
  const [mode, setMode] = useState<MacMode>(initialMode);
  const [name, setName] = useState(device.name);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const nameId = useId();
  const state = deviceState(device, now);
  const codex = device.runtimes.find((runtime) => runtime.runtime === "codex");
  const choose = (next: MacMode) => {
    setProblem("");
    onMessage("");
    setName(device.name);
    setMode(next);
  };
  return (
    <div className="z-list-item">
      <span className="z-list-item__title">{device.name}</span>
      <div className="z-row">
        <StatusBadge
          status={state === "online" ? "completed" : state === "revoked" ? "cancelled" : "waiting"}
          label={state === "online" ? "Online" : state === "revoked" ? "Revoked" : "Offline"}
        />
        <StatusBadge
          status={codex?.status === "available" ? "completed" : "waiting"}
          label={codex?.status === "available" ? "Codex ready" : "Codex unavailable"}
        />
      </div>
      {state !== "revoked" && mode === "rename" && (
        <form
          className="z-stack"
          aria-label={`Rename ${device.name}`}
          onSubmit={async (event) => {
            event.preventDefault();
            const invalid = macNameProblem(name);
            if (invalid) return setProblem(invalid);
            setBusy(true);
            try {
              await rename({ workstationId: device._id, name: name.trim() });
              onMessage(`Renamed to ${name.trim()}.`);
              setMode("idle");
            } catch (error) {
              setProblem(explainMacError(error, "Could not rename this Mac."));
            } finally {
              setBusy(false);
            }
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
          {problem && <Notice tone="danger">{problem}</Notice>}
          <div className="z-row">
            <Button type="submit" size="small" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button variant="ghost" size="small" disabled={busy} onClick={() => choose("idle")}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {state !== "revoked" && mode === "repositories" && (
        <MacRepositories device={device} onDone={() => choose("idle")} onMessage={onMessage} />
      )}
      {state !== "revoked" && mode === "revoke" && (
        <div className="z-row">
          <Button
            variant="danger"
            size="small"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await revoke({ workstationId: device._id });
                onMessage(`${device.name} can no longer run work.`);
              } catch (error) {
                onMessage(explainError(error, "Could not revoke access."));
              } finally {
                setBusy(false);
                setMode("idle");
              }
            }}
          >
            Revoke access
          </Button>
          <Button variant="ghost" size="small" onClick={() => choose("idle")}>
            Keep
          </Button>
        </div>
      )}
      {state !== "revoked" && mode === "idle" && (
        <div className="z-row">
          <Button variant="ghost" size="small" onClick={() => choose("rename")}>
            Rename
          </Button>
          <Button variant="ghost" size="small" onClick={() => choose("repositories")}>
            Repositories
          </Button>
          <Button variant="ghost" size="small" className="z-muted" onClick={() => choose("revoke")}>
            Remove this Mac…
          </Button>
        </div>
      )}
    </div>
  );
}

function MacRepositories({
  device,
  onDone,
  onMessage,
}: {
  device: Device;
  onDone: () => void;
  onMessage: (message: string) => void;
}) {
  const locations = useQuery(api.repositories.listLocations, { workstationId: device._id }) as
    | MacLocation[]
    | undefined;
  const remove = useMutation(api.repositories.removeLocationForOwner);
  const [confirming, setConfirming] = useState<Id<"repositoryLocations">>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  return (
    <section className="z-stack" aria-label={`Repositories on ${device.name}`}>
      {locations === undefined ? (
        <p className="z-muted z-small">Loading repositories…</p>
      ) : locations.length ? (
        locations.map((location) => (
          <div className="z-stack" key={location.repositoryLocationId}>
            <span className="z-small">{location.repositoryName}</span>
            <span className="z-xsmall z-muted">{location.canonicalPath}</span>
            {confirming === location.repositoryLocationId ? (
              <div className="z-row">
                <Button
                  variant="danger"
                  size="small"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setProblem("");
                    try {
                      await remove({ repositoryLocationId: location.repositoryLocationId });
                      onMessage(
                        `${device.name} no longer receives new work for ${location.repositoryName}. Re-add it with pnpm zamolxis setup on that Mac.`,
                      );
                    } catch (error) {
                      setProblem(explainMacError(error, "Could not remove this repository."));
                    } finally {
                      setBusy(false);
                      setConfirming(undefined);
                    }
                  }}
                >
                  Stop working on it
                </Button>
                <Button
                  variant="ghost"
                  size="small"
                  disabled={busy}
                  onClick={() => setConfirming(undefined)}
                >
                  Keep
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="small"
                onClick={() => setConfirming(location.repositoryLocationId)}
              >
                Remove from this Mac…
              </Button>
            )}
          </div>
        ))
      ) : (
        <p className="z-muted z-small">
          No repositories on this Mac. Add them with <code>pnpm zamolxis setup</code>.
        </p>
      )}
      {problem && <Notice tone="danger">{problem}</Notice>}
      <Button variant="ghost" size="small" onClick={onDone}>
        Done
      </Button>
    </section>
  );
}
