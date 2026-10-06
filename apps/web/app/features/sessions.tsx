"use client";
import {
  AppHeader,
  AppShell,
  Button,
  Composer,
  Markdown,
  Message,
  Notice,
  ProductMark,
  StatusBadge,
  safeHref,
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
  const { results, status, loadMore } = usePaginatedQuery(
    api.sessions.listMine,
    ready ? {} : "skip",
    { initialNumItems: 20 },
  );
  const sessions = results as SessionRow[];
  return (
    <AppShell
      header={
        <AppHeader
          leading={<ProductMark />}
          title="Zamolxis"
          subtitle={indicator}
          trailing={
            <Button variant="ghost" onClick={onSettings}>
              Settings
            </Button>
          }
        />
      }
      footer={<OrchestratorComposer ready={ready} />}
    >
      {notices}
      <OnboardingChecklist ready={ready} />
      <ApprovalsInbox ready={ready} onOpen={onOpen} />
      <OrchestratorConversation ready={ready} onOpen={onOpen} />
      <section className="z-stack" aria-label="Sessions">
        <h2 className="z-section-title">Sessions</h2>
        {status === "LoadingFirstPage" ? (
          <p className="z-muted" role="status">
            Loading sessions…
          </p>
        ) : sessions.length ? (
          <div className="z-list">
            {sessions.map((session) => (
              <button
                type="button"
                className="z-list-item"
                key={session._id}
                onClick={() => onOpen(session._id)}
              >
                <span className="z-list-item__title">{session.title}</span>
                <span className="z-row z-xsmall z-muted">
                  <StatusBadge status={session.status} />
                  {session.totalTaskCount > 0 && (
                    <span>
                      {session.completedTaskCount}/{session.totalTaskCount} tasks
                    </span>
                  )}
                  <span>{relativeTime(session.lastActivityAt, now)}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="z-muted">
            No work sessions yet. Ask Zamolxis a question, or explicitly tell it to start work.
          </p>
        )}
        {status === "CanLoadMore" && (
          <Button variant="secondary" block onClick={() => loadMore(20)}>
            Show older sessions
          </Button>
        )}
      </section>
    </AppShell>
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
  const text = `${link.label}${link.status ? ` · ${link.status}` : ""}`;
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
  if (thinking) return "Summary from current state · the Orchestrator is writing a reply";
  if (message.route === "create") return "Opened linked work";
  if (message.route === "continue") return "Continued linked work";
  const by =
    message.answeredBy === "model"
      ? ` · ${message.modelActual ?? message.runtime ?? "model"}${message.totalTokens ? ` · ${message.totalTokens.toLocaleString()} tokens` : ""}`
      : "";
  if (message.route === "ask") return `Asked you a question${by}`;
  if (message.route === "propose") return `Proposed work, nothing started${by}`;
  return `Answered without opening work${by}`;
}

function OpenProposal({
  message,
  onOpen,
}: {
  message: OrchestratorMessage;
  onOpen: (id: Id<"workSessions">) => void;
}) {
  const open = useMutation(api.orchestrator.openProposal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { productId, repositoryId } = message;
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
      <Button
        size="small"
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
        Open this work
      </Button>
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
        <h2 className="z-section-title">Orchestrator</h2>
        <span className="z-xsmall z-muted">
          Questions stay here · explicit work opens a session
        </span>
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
      <select
        className="z-select"
        aria-label="Product"
        value={productId}
        onChange={(event) => {
          setProductId(event.target.value as Id<"products">);
          setRepositoryId("");
        }}
      >
        {products.map((product) => (
          <option key={product._id} value={product._id}>
            {product.name}
          </option>
        ))}
      </select>
    ) : null;
  const repositoryPicker =
    repositories && repositories.length > 1 ? (
      <select
        className="z-select"
        aria-label="Repository"
        value={repositoryId}
        onChange={(event) => setRepositoryId(event.target.value as Id<"repositories">)}
      >
        {repositories.map((repository) => (
          <option key={repository._id} value={repository._id}>
            {repository.name}
          </option>
        ))}
      </select>
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
      placeholder="Ask Zamolxis, or tell it to start work…"
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
          ? "Pair a Mac with a repository before delegating work. Questions still stay here."
          : repositoryName
            ? `Context: ${repositoryName}`
            : undefined
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
