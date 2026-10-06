"use client";
import {
  AppHeader,
  Button,
  Composer,
  Markdown,
  Message,
  Notice,
  Picker,
  ProductMark,
  SessionStatusBadge,
  Sheet,
  safeHref,
  sessionStatusLabel,
  statusLabel,
  TextInput,
  Thinking,
} from "@zamolxis/ui";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ApprovalsInbox } from "./approvals";
import { explainError } from "./errors";
import { OnboardingChecklist } from "./onboarding";
import { relativeTime } from "./time";
import { useNow } from "./workspace";

interface SessionRow {
  _id: Id<"workSessions">;
  title: string;
  status: string;
  lastActivityAt: number;
  totalTaskCount: number;
  completedTaskCount: number;
}

export function SessionList({
  ready,
  indicator,
  notices,
  onOpen,
  onSettings,
}: {
  ready: boolean;
  indicator: ReactNode;
  notices: ReactNode;
  onOpen: (id: Id<"workSessions">, runId?: Id<"agentRuns">) => void;
  onSettings: () => void;
}) {
  const now = useNow(30000);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "active" | "waiting" | "completed">("all");
  const [search, setSearch] = useState("");
  const { results, status, loadMore } = usePaginatedQuery(
    api.sessions.listMine,
    ready ? {} : "skip",
    { initialNumItems: 20 },
  );
  const sessions = results as SessionRow[];
  const visible = sessions.filter((session) => {
    const matchesSearch = session.title.toLowerCase().includes(search.trim().toLowerCase());
    const matchesFilter =
      filter === "all" ||
      (filter === "active" && ["planning", "running"].includes(session.status)) ||
      (filter === "waiting" && ["waiting", "needs_input"].includes(session.status)) ||
      (filter === "completed" && session.status === "completed");
    return matchesSearch && matchesFilter;
  });
  const navigation = (
    <div className="z-home-nav__content">
      <div className="z-row z-row--between">
        <div className="z-row">
          <ProductMark />
          <strong>Zamolxis</strong>
        </div>
        <Button
          variant="ghost"
          size="small"
          className="z-home-nav__close"
          onClick={() => setDrawerOpen(false)}
        >
          Close
        </Button>
      </div>
      <button
        type="button"
        className="z-home-link z-home-link--active"
        onClick={() => setDrawerOpen(false)}
      >
        Home
      </button>
      <div className="z-row z-row--between">
        <h2 className="z-section-title">Work Sessions</h2>
        <span className="z-xsmall z-muted">{sessions.length}</span>
      </div>
      <TextInput
        value={search}
        aria-label="Search work sessions"
        placeholder="Search sessions…"
        onChange={(event) => setSearch(event.target.value)}
      />
      <fieldset className="z-home-filters">
        <legend className="z-visually-hidden">Filter work sessions</legend>
        {(["all", "active", "waiting", "completed"] as const).map((value) => (
          <button
            type="button"
            key={value}
            className={`z-home-filter${filter === value ? " z-home-filter--active" : ""}`}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {value[0]?.toUpperCase()}
            {value.slice(1)}
          </button>
        ))}
      </fieldset>
      <div className="z-home-session-list">
        {status === "LoadingFirstPage" ? (
          <p className="z-muted z-small" role="status">
            Loading sessions…
          </p>
        ) : visible.length ? (
          visible.map((session) => (
            <button
              type="button"
              className="z-home-session"
              key={session._id}
              onClick={() => {
                setDrawerOpen(false);
                onOpen(session._id);
              }}
            >
              <span className="z-list-item__title">{session.title}</span>
              <span className="z-row z-xsmall z-muted">
                <SessionStatusBadge status={session.status} />
                {session.totalTaskCount > 0 && (
                  <span>
                    {session.completedTaskCount}/{session.totalTaskCount}
                  </span>
                )}
                <span>{relativeTime(session.lastActivityAt, now)}</span>
              </span>
            </button>
          ))
        ) : (
          <p className="z-muted z-small">
            {search
              ? `No matches in ${filter}.`
              : filter === "all"
                ? "No Work Sessions yet."
                : `No ${filter} sessions.`}
          </p>
        )}
      </div>
      {status === "CanLoadMore" && (
        <Button variant="secondary" block onClick={() => loadMore(20)}>
          Show older sessions
        </Button>
      )}
    </div>
  );
  return (
    <div className="z-home-shell">
      {drawerOpen && (
        <button
          type="button"
          className="z-home-backdrop"
          aria-label="Close sessions"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      <aside
        id="work-sessions"
        className={`z-home-nav${drawerOpen ? " z-home-nav--open" : ""}`}
        aria-label="Work Sessions"
      >
        {navigation}
      </aside>
      <div className="z-home-main">
        <AppHeader
          leading={
            <Button
              variant="ghost"
              size="small"
              className="z-home-sessions-trigger"
              aria-expanded={drawerOpen}
              aria-controls="work-sessions"
              onClick={() => setDrawerOpen(true)}
            >
              Sessions
            </Button>
          }
          title="Home"
          subtitle={indicator}
          trailing={
            <Button variant="ghost" onClick={onSettings}>
              Settings
            </Button>
          }
        />
        <main className="z-home-conversation">
          {notices}
          <OnboardingChecklist ready={ready} />
          <ApprovalsInbox ready={ready} onOpen={onOpen} />
          <OrchestratorConversation ready={ready} onOpen={onOpen} />
        </main>
        <footer className="z-home-composer">
          <OrchestratorComposer ready={ready} />
        </footer>
      </div>
    </div>
  );
}

interface Product {
  _id: Id<"products">;
  name: string;
}
interface Repository {
  _id: Id<"repositories">;
  name: string;
}

interface OrchestratorLink {
  _id: Id<"orchestratorMessageLinks">;
  targetType: string;
  targetId: string;
  label: string;
  status?: string;
  url?: string;
  workSessionId?: Id<"workSessions">;
}

// Status is a snapshot from when Zamolxis answered; the linked view is canonical.
function OrchestratorLinkButton({
  link,
  onOpen,
}: {
  link: OrchestratorLink;
  onOpen: (id: Id<"workSessions">, runId?: Id<"agentRuns">) => void;
}) {
  const status = link.status
    ? link.targetType === "session"
      ? sessionStatusLabel(link.status).label
      : link.targetType === "approval"
        ? `${link.status} risk`
        : link.targetType === "trust"
          ? link.status === "trusted"
            ? "Trusted"
            : "Not trusted"
          : statusLabel(link.status).label
    : undefined;
  const text = `${link.label}${status ? ` · ${status}` : ""}`;
  if (link.targetType === "pull_request") {
    const href = link.url ? safeHref(link.url) : undefined;
    return href ? (
      <a
        className="z-button z-button--secondary z-button--small"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
      >
        {text}
      </a>
    ) : null;
  }
  const sessionId = link.workSessionId;
  if (!sessionId) return null;
  return (
    <Button
      variant="secondary"
      size="small"
      onClick={() =>
        onOpen(
          sessionId,
          link.targetType === "run" ? (link.targetId as Id<"agentRuns">) : undefined,
        )
      }
    >
      {text}
    </Button>
  );
}

interface OrchestratorMessage {
  _id: Id<"orchestratorMessages">;
  text: string;
  reply: string;
  route: "answer" | "ask" | "propose" | "create" | "continue";
  status?: "thinking" | "answered";
  answeredBy?: "model" | "deterministic";
  proposal?: string;
  proposalSessionId?: Id<"workSessions">;
  productId?: Id<"products">;
  repositoryId?: Id<"repositories">;
  runtime?: string;
  modelActual?: string;
  totalTokens?: number;
  createdAt: number;
  links: OrchestratorLink[];
}

// After this long the Node is not waited for; the summary shown is the answer.
const THINKING_SHOWN_MS = 10 * 60_000;

function routeMeta(message: OrchestratorMessage, thinking: boolean) {
  if (thinking) return "Quick summary · a fuller answer is on its way";
  if (message.route === "create" || message.route === "continue") return "Legacy work request";
  const by =
    message.answeredBy === "model" && message.modelActual ? ` · ${message.modelActual}` : "";
  if (message.route === "ask") return `Question for you${by}`;
  if (message.route === "propose") return `Suggestion, nothing started yet${by}`;
  return `Answer${by}`;
}

function OpenProposal({
  message,
  onOpen,
}: {
  message: OrchestratorMessage;
  onOpen: (id: Id<"workSessions">) => void;
}) {
  const open = useMutation(api.orchestrator.openProposal);
  const products = useQuery(api.supervisor.products, {}) as Product[] | undefined;
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { productId, repositoryId } = message;
  const repositories = useQuery(
    api.repositories.listByProduct,
    productId ? { productId } : "skip",
  ) as Repository[] | undefined;
  if (message.proposalSessionId) return null;
  if (!productId || !repositoryId)
    return (
      <p className="z-xsmall z-muted">
        Choose a product and repository, then ask again to open this work.
      </p>
    );
  return (
    <div className="z-stack">
      {error && <Notice tone="danger">{error}</Notice>}
      <Button size="small" disabled={busy} onClick={() => setReviewing(true)}>
        Review proposal
      </Button>
      <Sheet open={reviewing} title="Review proposal" onClose={() => setReviewing(false)}>
        <div className="z-stack">
          <p className="z-small z-muted">Nothing starts until you confirm this proposal.</p>
          <div className="z-stack">
            <div>
              <strong>Request</strong>
              <Markdown>{message.text}</Markdown>
            </div>
            {message.proposal && message.proposal !== message.text && (
              <div>
                <strong>Proposed work</strong>
                <Markdown>{message.proposal}</Markdown>
              </div>
            )}
            <p className="z-small">
              <strong>Target:</strong>{" "}
              {products?.find((product) => product._id === productId)?.name ?? "Product"} /{" "}
              {repositories?.find((repository) => repository._id === repositoryId)?.name ??
                "Repository"}
            </p>
          </div>
          <div className="z-row">
            <Button variant="secondary" onClick={() => setReviewing(false)}>
              Keep editing
            </Button>
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  onOpen(await open({ messageId: message._id, productId, repositoryId }));
                } catch (failure) {
                  setError(explainError(failure, "Could not open this work. Try again."));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Starting…" : "Open Work Session and start planning"}
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}

function OrchestratorConversation({
  ready,
  onOpen,
}: {
  ready: boolean;
  onOpen: (id: Id<"workSessions">, runId?: Id<"agentRuns">) => void;
}) {
  const messages = useQuery(api.orchestrator.messages, ready ? {} : "skip") as
    | OrchestratorMessage[]
    | undefined;
  const now = Date.now();
  const thinking = (message: OrchestratorMessage) =>
    message.status === "thinking" && now - message.createdAt < THINKING_SHOWN_MS;
  return (
    <section className="z-stack" aria-label="Orchestrator conversation">
      <div className="z-row z-row--between">
        <h2 className="z-section-title">Ask Zamolxis</h2>
        <span className="z-xsmall z-muted">Ask anything · nothing starts until you say so</span>
      </div>
      {messages === undefined ? (
        <p className="z-muted" role="status">
          Loading conversation…
        </p>
      ) : messages.length ? (
        <div className="z-stack" aria-live="polite">
          {messages.map((message) => (
            <div className="z-stack" key={message._id}>
              <Message author="user" label="You">
                {message.text}
              </Message>
              <Message
                author="assistant"
                label="Zamolxis"
                meta={routeMeta(message, thinking(message))}
              >
                {thinking(message) && <Thinking label="Writing a reply…" />}
                <Markdown>{message.reply}</Markdown>
                {message.route === "propose" && message.proposal && (
                  <div className="z-stack">
                    <Markdown>{message.proposal}</Markdown>
                    <OpenProposal message={message} onOpen={(id) => onOpen(id)} />
                  </div>
                )}
                {message.links.length > 0 && (
                  <div className="z-row">
                    {message.links.map((link) => (
                      <OrchestratorLinkButton key={link._id} link={link} onOpen={onOpen} />
                    ))}
                  </div>
                )}
              </Message>
            </div>
          ))}
        </div>
      ) : (
        <p className="z-muted">
          Ask what is happening, how orchestration works, or tell Zamolxis explicitly to start work.
        </p>
      )}
    </section>
  );
}

function OrchestratorComposer({ ready }: { ready: boolean }) {
  const products = useQuery(api.supervisor.products, ready ? {} : "skip") as Product[] | undefined;
  const [productId, setProductId] = useState<Id<"products"> | "">("");
  const repositories = useQuery(
    api.repositories.listByProduct,
    ready && productId ? { productId } : "skip",
  ) as Repository[] | undefined;
  const [repositoryId, setRepositoryId] = useState<Id<"repositories"> | "">("");
  const submit = useMutation(api.orchestrator.submit);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!productId && products?.[0]) setProductId(products[0]._id);
  }, [products, productId]);
  useEffect(() => {
    setRepositoryId(repositories?.[0]?._id ?? "");
  }, [repositories]);
  const context =
    products && products.length > 1 ? (
      <Picker
        label="Product"
        hideLabel
        value={productId}
        options={products.map((product) => ({ value: product._id, label: product.name }))}
        onChange={(value) => {
          setProductId(value as Id<"products">);
          setRepositoryId("");
        }}
      />
    ) : null;
  const repositoryPicker =
    repositories && repositories.length > 1 ? (
      <Picker
        label="Repository"
        hideLabel
        value={repositoryId}
        options={repositories.map((repository) => ({
          value: repository._id,
          label: repository.name,
        }))}
        onChange={(value) => setRepositoryId(value as Id<"repositories">)}
      />
    ) : null;
  const repositoryName = repositories?.find((repository) => repository._id === repositoryId)?.name;
  return (
    <Composer
      value={text}
      onChange={(value) => {
        setText(value);
        setError("");
      }}
      busy={busy}
      disabled={!ready}
      placeholder="Ask Zamolxis…"
      submitLabel="Send"
      above={
        <>
          {error && <Notice tone="danger">{error}</Notice>}
          {(context || repositoryPicker) && (
            <div className="z-stack">
              {context}
              {repositoryPicker}
            </div>
          )}
        </>
      }
      hint={
        products && !products.length
          ? "Pair a Mac with a repository before delegating work. Sending a message does not start work."
          : repositoryName
            ? `Context: ${repositoryName} · Sending a message does not start work.`
            : "Sending a message does not start work."
      }
      onSubmit={async () => {
        setBusy(true);
        try {
          await submit({
            ...(productId ? { productId } : {}),
            ...(repositoryId ? { repositoryId } : {}),
            text,
            idempotencyKey: crypto.randomUUID(),
          });
          setText("");
        } catch (failure) {
          setError(explainError(failure, "Could not send the message. Try again."));
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}
