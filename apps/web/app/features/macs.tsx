"use client";
import { Button, Notice, StatusBadge, TextInput } from "@zamolxis/ui";
import { useMutation, useQuery } from "convex/react";
import { useId, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { errorCode, explainError } from "./errors";
import { type GithubAccess, GithubAccessRow, type GithubRepository } from "./github-access";

export interface Device {
  _id: Id<"workstations">;
  name: string;
  status: string;
  lastHeartbeatAt?: number;
  /** Node.js `process.platform` as the Node last reported it. */
  platform?: string;
  /** The commit the Node runs from, as it last reported it ("<sha>" or "<sha>+dirty"). */
  nodeVersion?: string;
  runtimes: Array<{ runtime: string; status: string }>;
}
/** "macOS · Node 1a2b3c4d5e6f": what kind of computer and which Node code it runs. */
export function deviceDetail(device: Pick<Device, "platform" | "nodeVersion">): string | undefined {
  const parts = [platformLabel(device.platform), device.nodeVersion && `Node ${device.nodeVersion}`];
  return parts.filter(Boolean).join(" · ") || undefined;
}

const PLATFORM_LABELS: Record<string, string> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};
/** The kind of computer, in the words its owner uses; nothing for an unknown platform. */
export function platformLabel(platform: string | undefined): string | undefined {
  return platform ? (PLATFORM_LABELS[platform] ?? platform) : undefined;
}

export function deviceState(device: Device, now: number) {
  if (device.status === "revoked") return "revoked" as const;
  return device.status === "online" && (device.lastHeartbeatAt ?? 0) > now - 45000
    ? ("online" as const)
    : ("offline" as const);
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
    "Work is still running in this repository on this computer. Remove it once that work has finished.",
  INVALID_ARGUMENT: "Use a name of 1 to 64 characters.",
  INVALID_STATE: "This computer was removed.",
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
  // GitHub repositories only: where to create the token, and what the computer last reported.
  github?: GithubRepository;
  githubAccess?: GithubAccess;
}

const RUNTIME_NAMES: Record<string, string> = { codex: "Codex", claude: "Claude Code" };

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
  const available = device.runtimes
    .filter((candidate) => candidate.status === "available")
    .map((candidate) => RUNTIME_NAMES[candidate.runtime] ?? candidate.runtime)
    .sort();
  const runtime = available.length > 0;
  const runtimeName = available.join(" and ");
  const choose = (next: MacMode) => {
    setProblem("");
    onMessage("");
    setName(device.name);
    setMode(next);
  };
  return (
    <div className="z-list-item">
      <span className="z-list-item__title">{device.name}</span>
      {deviceDetail(device) && <span className="z-xsmall z-muted">{deviceDetail(device)}</span>}
      <div className="z-row">
        <StatusBadge
          status={state === "online" ? "completed" : state === "revoked" ? "cancelled" : "waiting"}
          label={state === "online" ? "Online" : state === "revoked" ? "Revoked" : "Offline"}
        />
        <StatusBadge
          status={runtime ? "completed" : "waiting"}
          label={runtimeName ? `${runtimeName} ready` : "No agent runtime"}
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
              setProblem(explainMacError(error, "Could not rename this computer."));
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
        <MacRepositories
          device={device}
          now={now}
          onDone={() => choose("idle")}
          onMessage={onMessage}
        />
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
            Remove this computer…
          </Button>
        </div>
      )}
    </div>
  );
}

function MacRepositories({
  device,
  now,
  onDone,
  onMessage,
}: {
  device: Device;
  now: number;
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
            {location.github && (
              <GithubAccessRow
                github={location.github}
                {...(location.githubAccess ? { access: location.githubAccess } : {})}
                now={now}
              />
            )}
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
                        `${device.name} no longer receives new work for ${location.repositoryName}. Re-add it with pnpm zamolxis setup on that computer.`,
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
                Remove from this computer…
              </Button>
            )}
          </div>
        ))
      ) : (
        <p className="z-muted z-small">
          No repositories on this computer. Add them with <code>pnpm zamolxis setup</code>.
        </p>
      )}
      {problem && <Notice tone="danger">{problem}</Notice>}
      <Button variant="ghost" size="small" onClick={onDone}>
        Done
      </Button>
    </section>
  );
}
