"use client";
import { Button, Card, ConnectionIndicator, Notice } from "@zamolxis/ui";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ApprovalToasts } from "./approvals";
import { explainError } from "./errors";
import { type Device, deviceState } from "./macs";
import { SessionView } from "./session-view";
import { SessionList } from "./sessions";
import { Settings, type SettingsPage } from "./settings";
import { useSearchParam } from "./use-location";

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
  // The open chat on Home; empty means a new, empty chat.
  const [chatId, setChatId] = useSearchParam("chat");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<SettingsPage | "">("");
  const openSettings = (page: SettingsPage | "" = "") => {
    setSettingsPage(page);
    setSettingsOpen(true);
  };
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
      ? { state: "none" as const, label: "Checking computer…" }
      : online.length
        ? { state: "online" as const, label: `Computers connected (${online.length})` }
        : active.length
          ? {
              state: "offline" as const,
              label: `No computer connected (${active.length} offline)`,
            }
          : { state: "none" as const, label: "No computer paired" };
  const indicator = (
    <button
      type="button"
      className="z-button z-button--ghost z-button--small"
      onClick={() => openSettings("macs")}
      aria-label={`${connection.label}. Open Computers settings`}
    >
      <ConnectionIndicator state={connection.state} label={connection.label} />
    </button>
  );
  const notices = (
    <>
      {problem && <Notice tone="danger">{problem}</Notice>}
      <PairingApproval ready={ready} />
      {/* Connecting a computer is the onboarding checklist's first open step (sessions screen). */}
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
          onBack={() => {
            replaceRun("");
            setSessionId("");
          }}
          onOpen={(id) => {
            replaceRun("");
            setSessionId(id, "replace");
          }}
        />
      ) : (
        <SessionList
          ready={ready}
          indicator={indicator}
          notices={notices}
          chatId={chatId}
          onOpenChat={setChatId}
          onOpen={(id, runId) => {
            setSessionId(id);
            // Read by the Session view when it mounts after this render.
            if (runId) replaceRun(runId);
          }}
          onSettings={openSettings}
        />
      )}
      <ApprovalToasts
        ready={ready}
        onOpen={(id) => {
          setSettingsOpen(false);
          replaceRun("");
          setSessionId(id);
        }}
      />
      <Settings
        open={settingsOpen}
        page={settingsPage}
        onPage={setSettingsPage}
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

function replaceRun(runId: string) {
  const url = new URL(location.href);
  if (runId) url.searchParams.set("run", runId);
  else if (!url.searchParams.has("run")) return;
  else url.searchParams.delete("run");
  history.replaceState(null, "", url);
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
    <Card label="Approve computer">
      <h2 className="z-title">Approve {pairing?.name ?? "this computer"}?</h2>
      <p className="z-muted z-small">
        Only approve the QR code you just opened from setup on your own computer. It expires after
        five minutes.
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
              text: "Computer approved. Setup on your computer is finishing and starting the Node.",
            });
          } catch (error) {
            setResult({
              tone: "danger",
              text: explainError(
                error,
                "This code expired or was already used. Rerun setup on your computer for a new QR code.",
              ),
            });
          } finally {
            setPair("", "replace");
            setBusy(false);
          }
        }}
      >
        Approve this computer
      </Button>
    </Card>
  );
}
