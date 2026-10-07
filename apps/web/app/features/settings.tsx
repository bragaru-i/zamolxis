"use client";
import { useAuthActions } from "@convex-dev/auth/react";
import { Button, compactCount, Notice, Sheet, useWide } from "@zamolxis/ui";
import { useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { WorkflowRow } from "./agents";
import { DevicesSection } from "./devices";
import { type Device, deviceState, MacItem } from "./macs";
import { PeopleSection } from "./people";
import { ProductsSection } from "./products";
import { plural, StorageSettings, type StorageSummary } from "./storage";
import { UsageSettings, type UsageSummary } from "./usage";
import { costOf, MyAgentsSettings, type SavedAgent, WorkflowsSettings } from "./workflow-settings";

export type SettingsPage = "workflows" | "agents" | "macs" | "usage" | "storage" | "access";

/** Settings in the order the owner needs them most. */
export const SETTINGS_PAGES: Array<{ page: SettingsPage; title: string; help: string }> = [
  { page: "workflows", title: "Workflows", help: "Which agent does each job." },
  { page: "agents", title: "My agents", help: "Your agents: one to three models each." },
  {
    page: "macs",
    title: "Computers & projects",
    help: "Where work runs and which workflow each computer uses.",
  },
  { page: "usage", title: "Usage", help: "Tokens your agents used." },
  { page: "storage", title: "Storage", help: "How long finished work stays on your computer." },
  {
    page: "access",
    title: "People & devices",
    help: "Who can use Zamolxis and where you are signed in.",
  },
];

export interface SummaryInputs {
  workflows?: Pick<WorkflowRow, "_id" | "name">[];
  agents?: Pick<SavedAgent, "chain" | "checksOnly">[];
  devices?: Device[];
  usage?: UsageSummary;
  storage?: StorageSummary;
  now: number;
}

/** One line of current state per page, so the menu says what is set before it is opened. */
export function pageSummary(page: SettingsPage, data: SummaryInputs): string | undefined {
  switch (page) {
    case "workflows": {
      if (!data.workflows || !data.devices) return undefined;
      const count = data.workflows.length
        ? plural(data.workflows.length, "workflow")
        : "Only the Default so far";
      const [first] = data.devices.filter((device) => device.status !== "revoked");
      if (!first) return count;
      const used =
        data.workflows.find((workflow) => workflow._id === first.defaultWorkflowId)?.name ??
        "Default";
      return `${count} · ${first.name} uses ${used}`;
    }
    case "agents": {
      if (!data.agents) return undefined;
      const free = data.agents.filter(
        (agent) => costOf(agent.chain, agent.checksOnly) === "free",
      ).length;
      return `${plural(data.agents.length, "agent")}${free ? ` · ${free} run free` : ""}`;
    }
    case "macs": {
      if (!data.devices) return undefined;
      const active = data.devices.filter((device) => device.status !== "revoked");
      if (!active.length) return "No computer paired yet";
      const online = active.filter((device) => deviceState(device, data.now) === "online");
      const [only] = active;
      if (active.length === 1 && only)
        return `${only.name} · ${online.length ? "online" : "offline"}`;
      return `${active.length} computers · ${online.length} online`;
    }
    case "usage": {
      if (!data.usage) return undefined;
      if (data.usage.total.items === 0) return "No agent work in the last 7 days";
      if (!data.usage.total.reported)
        return `${plural(data.usage.sessionCount, "session")} in the last 7 days`;
      return `${compactCount(data.usage.total.totalTokens)} tokens in the last 7 days`;
    }
    case "storage": {
      if (!data.storage) return undefined;
      const ready = data.storage.macs.reduce((sum, mac) => sum + mac.eligible, 0);
      return `Keeps finished work ${plural(data.storage.retentionDays, "day")}${ready ? ` · ${ready} ready to clean up` : ""}`;
    }
    default:
      return undefined;
  }
}

export function Settings({
  open,
  page,
  onPage,
  onClose,
  devices,
  now,
  onOpenSession,
}: {
  open: boolean;
  /** Empty shows the menu on phones; wide screens then show Workflows next to the menu. */
  page: SettingsPage | "";
  onPage: (page: SettingsPage | "") => void;
  onClose: () => void;
  devices: Device[] | undefined;
  now: number;
  onOpenSession: (id: Id<"workSessions">) => void;
}) {
  const wide = useWide();
  const shown: SettingsPage | "" = page || (wide ? "workflows" : "");
  const menuVisible = wide || !page;
  const title = SETTINGS_PAGES.find((item) => item.page === shown)?.title;
  return (
    <Sheet
      open={open}
      title={!wide && title ? title : "Settings"}
      size={wide ? "xl" : "lg"}
      onClose={onClose}
      {...(!wide && page ? { onBack: () => onPage(""), backLabel: "Settings" } : {})}
    >
      <div className={`z-settings${wide ? " z-settings--wide" : ""}`}>
        {menuVisible && (
          <SettingsMenu
            active={open && menuVisible}
            current={wide ? shown : ""}
            devices={devices}
            now={now}
            onPage={onPage}
          />
        )}
        {shown && (
          <div className="z-settings__page">
            {wide && title && <h3 className="z-settings__page-title">{title}</h3>}
            <SettingsContent
              page={shown}
              active={open}
              devices={devices}
              now={now}
              onOpenSession={onOpenSession}
            />
          </div>
        )}
      </div>
    </Sheet>
  );
}

function SettingsMenu({
  active,
  current,
  devices,
  now,
  onPage,
}: {
  active: boolean;
  current: SettingsPage | "";
  devices: Device[] | undefined;
  now: number;
  onPage: (page: SettingsPage) => void;
}) {
  const { signOut } = useAuthActions();
  const [problem, setProblem] = useState("");
  const workflows = useQuery(api.workflows.list, active ? {} : "skip") as WorkflowRow[] | undefined;
  const agents = useQuery(api.agents.list, active ? {} : "skip") as SavedAgent[] | undefined;
  const usage = useQuery(api.usage.summary, active ? { period: "7d" } : "skip") as
    | UsageSummary
    | undefined;
  const storage = useQuery(api.workspaces.storage, active ? {} : "skip") as
    | StorageSummary
    | undefined;
  const data = {
    now,
    ...(workflows ? { workflows } : {}),
    ...(agents ? { agents } : {}),
    ...(devices ? { devices } : {}),
    ...(usage ? { usage } : {}),
    ...(storage ? { storage } : {}),
  };
  return (
    <nav className="z-settings__menu" aria-label="Settings sections">
      <div className="z-settings__sections">
        {SETTINGS_PAGES.map((item) => (
        <button
          type="button"
          key={item.page}
          className={`z-settings-row${current === item.page ? " z-settings-row--active" : ""}`}
          aria-current={current === item.page ? "page" : undefined}
          onClick={() => onPage(item.page)}
        >
          <span className="z-settings-row__text">
            <span className="z-settings-row__title">{item.title}</span>
            <span className="z-settings-row__summary">
              {pageSummary(item.page, data) ?? item.help}
            </span>
          </span>
          <span className="z-settings-row__chevron" aria-hidden="true">
            ›
          </span>
        </button>
        ))}
      </div>
      <Button
        variant="ghost"
        block
        className="z-settings__signout"
        onClick={() => void signOut().catch(() => setProblem("Could not sign out. Try again."))}
      >
        Sign out
      </Button>
      {problem && <Notice tone="danger">{problem}</Notice>}
    </nav>
  );
}

function SettingsContent({
  page,
  active,
  devices,
  now,
  onOpenSession,
}: {
  page: SettingsPage;
  active: boolean;
  devices: Device[] | undefined;
  now: number;
  onOpenSession: (id: Id<"workSessions">) => void;
}) {
  switch (page) {
    case "workflows":
      return <WorkflowsSettings active={active} devices={devices} />;
    case "agents":
      return <MyAgentsSettings active={active} devices={devices} />;
    case "macs":
      return <MacsSettings devices={devices} now={now} />;
    case "usage":
      return <UsageSettings active={active} onOpenSession={onOpenSession} showTitle={false} />;
    case "storage":
      return <StorageSettings active={active} now={now} showTitle={false} />;
    case "access":
      return (
        <>
          <PeopleSection active={active} now={now} />
          <DevicesSection active={active} now={now} />
        </>
      );
  }
}

function MacsSettings({ devices, now }: { devices: Device[] | undefined; now: number }) {
  const [message, setMessage] = useState("");
  return (
    <section className="z-stack" aria-label="Computers">
      <p className="z-small z-muted">
        Where work runs. Each computer uses one workflow for all its projects; work started on a
        computer stays there.
      </p>
      {devices === undefined ? (
        <p className="z-muted z-small" role="status">
          Loading computers…
        </p>
      ) : devices.length ? (
        <div className="z-list">
          {devices.map((device) => (
            <MacItem key={device._id} device={device} now={now} onMessage={setMessage} />
          ))}
        </div>
      ) : (
        <p className="z-muted z-small">
          No computer paired yet. Run <code>pnpm zamolxis setup</code> on your computer.
        </p>
      )}
      {message && <Notice>{message}</Notice>}
      <ProductsSection />
    </section>
  );
}
