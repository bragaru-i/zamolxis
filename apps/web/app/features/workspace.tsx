"use client";
import { useAuthActions } from "@convex-dev/auth/react";
import { Button, Card, ConnectionIndicator, Notice, Sheet, StatusBadge } from "@zamolxis/ui";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { DevicesSection } from "./devices";
import { explainError } from "./errors";
import { PeopleSection } from "./people";
import { SessionView } from "./session-view";
import { SessionList } from "./sessions";
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
      {devices !== undefined && !active.length && (
        <Card label="Connect your Mac">
          <h2 className="z-title">Connect your Mac</h2>
          <p className="z-muted">
            Run <code>pnpm zamolxis setup</code> on your Mac, then scan the QR code with this phone.
          </p>
        </Card>
      )}
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
}: {
  open: boolean;
  onClose: () => void;
  devices: Device[] | undefined;
  now: number;
}) {
  const { signOut } = useAuthActions();
  const revoke = useMutation(api.workstations.revoke);
  const [confirming, setConfirming] = useState<Id<"workstations">>();
  const [message, setMessage] = useState("");
  return (
    <Sheet open={open} title="Settings" onClose={onClose}>
      <section className="z-stack">
        <h3 className="z-section-title">Macs</h3>
        {devices?.length ? (
          <div className="z-list">
            {devices.map((device) => {
              const state = deviceState(device, now);
              const codex = device.runtimes.find((runtime) => runtime.runtime === "codex");
              return (
                <div className="z-list-item" key={device._id}>
                  <span className="z-list-item__title">{device.name}</span>
                  <div className="z-row">
                    <StatusBadge
                      status={
                        state === "online"
                          ? "completed"
                          : state === "revoked"
                            ? "cancelled"
                            : "waiting"
                      }
                      label={
                        state === "online" ? "Online" : state === "revoked" ? "Revoked" : "Offline"
                      }
                    />
                    <StatusBadge
                      status={codex?.status === "available" ? "completed" : "waiting"}
                      label={codex?.status === "available" ? "Codex ready" : "Codex unavailable"}
                    />
                  </div>
                  {state !== "revoked" &&
                    (confirming === device._id ? (
                      <div className="z-row">
                        <Button
                          variant="danger"
                          size="small"
                          onClick={async () => {
                            try {
                              await revoke({ workstationId: device._id });
                              setMessage(`${device.name} can no longer run work.`);
                            } catch (error) {
                              setMessage(explainError(error, "Could not revoke access."));
                            } finally {
                              setConfirming(undefined);
                            }
                          }}
                        >
                          Revoke access
                        </Button>
                        <Button
                          variant="ghost"
                          size="small"
                          onClick={() => setConfirming(undefined)}
                        >
                          Keep
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="ghost"
                        size="small"
                        className="z-muted"
                        onClick={() => setConfirming(device._id)}
                      >
                        Remove this Mac…
                      </Button>
                    ))}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="z-muted z-small">
            No Mac paired yet. Run <code>pnpm zamolxis setup</code> on your Mac.
          </p>
        )}
        {message && <Notice>{message}</Notice>}
      </section>
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
