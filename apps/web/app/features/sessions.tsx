"use client";
import {
  AppHeader,
  Button,
  Chip,
  Composer,
  IconButton,
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
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ApprovalsInbox } from "./approvals";
import { explainError, explainFailure } from "./errors";
import { agentName, FailureDetails } from "./failure";
import { LiveAgents } from "./live-agents";
import { OnboardingChecklist } from "./onboarding";
import type { SettingsPage } from "./settings";
import { groupByRecency, relativeTime } from "./time";
import { useNow } from "./workspace";

interface ChatRow {
  _id: Id<"orchestratorConversations">;
  title: string;
  lastActivityAt: number;
  createdAt: number;
}

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
  chatId,
  onOpenChat,
  onOpen,
  onSettings,
}: {
  ready: boolean;
  indicator: ReactNode;
  notices: ReactNode;
  /** The open chat; empty means a new, empty chat. */
  chatId: string;
  onOpenChat: (id: string, mode?: "push" | "replace") => void;
  onOpen: (id: Id<"workSessions">, runId?: Id<"agentRuns">) => void;
  onSettings: (page?: SettingsPage) => void;
}) {
  const now = useNow(30000);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "active" | "waiting" | "completed">("all");
  const [search, setSearch] = useState("");
  const [chatMenu, setChatMenu] = useState<ChatRow>();
  const chats = useQuery(api.orchestrator.conversations, ready ? {} : "skip") as
    | ChatRow[]
    | undefined;
  const { results, status, loadMore } = usePaginatedQuery(
    api.sessions.listMine,
    ready ? {} : "skip",
    { initialNumItems: 20 },
  );
  const sessions = results as SessionRow[];
  const needle = search.trim().toLowerCase();
  // Both lists are grouped by day, so they are kept newest first here as well.
  const byActivity = <T extends { lastActivityAt: number }>(rows: T[]) =>
    [...rows].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  const visibleChats = byActivity(chats ?? []).filter((chat) =>
    chat.title.toLowerCase().includes(needle),
  );
  const visible = byActivity(sessions).filter((session) => {
    const matchesSearch = session.title.toLowerCase().includes(needle);
    const matchesFilter =
      filter === "all" ||
      (filter === "active" && ["planning", "running"].includes(session.status)) ||
      (filter === "waiting" && ["waiting", "needs_input"].includes(session.status)) ||
      (filter === "completed" && session.status === "completed");
    return matchesSearch && matchesFilter;
  });
  const openChat = chats?.find((chat) => chat._id === chatId);
  const navigation = (
    <div className="z-home-nav__content">
      <div className="z-home-nav__top">
        <div className="z-row z-row--between">
          <div className="z-row">
            <ProductMark />
            <strong>Zamolxis</strong>
          </div>
          <IconButton
            icon="close"
            label="Close menu"
            className="z-home-nav__close"
            onClick={() => setDrawerOpen(false)}
          />
        </div>
        <button
          type="button"
          className={`z-home-link${chatId ? "" : " z-home-link--active"}`}
          aria-current={chatId ? undefined : "page"}
          onClick={() => {
            setDrawerOpen(false);
            onOpenChat("");
          }}
        >
          + New chat
        </button>
        <div className="z-home-nav__connection">{indicator}</div>
      </div>
      <div className="z-home-nav__scroll">
        <TextInput
          value={search}
          aria-label="Search chats and work sessions"
          placeholder="Search…"
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="z-row z-row--between">
          <h2 className="z-section-title">Chats</h2>
          <span className="z-xsmall z-muted">{chats?.length ?? ""}</span>
        </div>
        <section className="z-home-session-list" aria-label="Chats">
          {chats === undefined ? (
            <p className="z-muted z-small" role="status">
              Loading chats…
            </p>
          ) : visibleChats.length ? (
            groupByRecency(visibleChats, (chat) => chat.lastActivityAt, now).map((group) => (
              <div className="z-home-session-list" key={group.label}>
                <p className="z-home-group">{group.label}</p>
                {group.items.map((chat) => (
                  <div className="z-home-chat" key={chat._id}>
                    <button
                      type="button"
                      className={`z-home-session${chat._id === chatId ? " z-home-session--active" : ""}`}
                      aria-current={chat._id === chatId ? "page" : undefined}
                      onClick={() => {
                        setDrawerOpen(false);
                        onOpenChat(chat._id);
                      }}
                    >
                      <span className="z-home-session__title">{chat.title}</span>
                      <span className="z-xsmall z-muted">
                        {relativeTime(chat.lastActivityAt, now)}
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="small"
                      className="z-home-chat__menu"
                      aria-label={`Options for chat ${chat.title}`}
                      onClick={() => setChatMenu(chat)}
                    >
                      …
                    </Button>
                  </div>
                ))}
              </div>
            ))
          ) : (
            <p className="z-muted z-small">
              {search ? "No chats match." : "No chats yet. Your first message starts one."}
            </p>
          )}
        </section>
        <div className="z-row z-row--between">
          <h2 className="z-section-title">Work Sessions</h2>
          <span className="z-xsmall z-muted">{sessions.length}</span>
        </div>
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
        <section className="z-home-session-list" aria-label="Work Sessions">
          {status === "LoadingFirstPage" ? (
            <p className="z-muted z-small" role="status">
              Loading sessions…
            </p>
          ) : visible.length ? (
            groupByRecency(visible, (session) => session.lastActivityAt, now).map((group) => (
              <div className="z-home-session-list" key={group.label}>
                <p className="z-home-group">{group.label}</p>
                {group.items.map((session) => (
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
                ))}
              </div>
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
        </section>
        {status === "CanLoadMore" && (
          <Button variant="secondary" block onClick={() => loadMore(20)}>
            Show older sessions
          </Button>
        )}
      </div>
      <div className="z-home-nav__links">
        <button
          type="button"
          className="z-home-link"
          onClick={() => {
            setDrawerOpen(false);
            onSettings("usage");
          }}
        >
          Usage
        </button>
        <button
          type="button"
          className="z-home-link"
          onClick={() => {
            setDrawerOpen(false);
            onSettings();
          }}
        >
          Settings
        </button>
      </div>
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
            <IconButton
              icon="menu"
              label="Open chats and sessions"
              className="z-home-sessions-trigger"
              aria-expanded={drawerOpen}
              aria-controls="work-sessions"
              onClick={() => setDrawerOpen(true)}
            />
          }
          title={chatId ? (openChat?.title ?? "Chat") : "New chat"}
          trailing={<IconButton icon="settings" label="Settings" onClick={() => onSettings()} />}
        />
        <main className="z-home-conversation">
          {notices}
          <OnboardingChecklist ready={ready} />
          <ApprovalsInbox ready={ready} onOpen={onOpen} />
          <LiveAgents ready={ready} onOpen={onOpen} />
          <OrchestratorConversation
            key={chatId}
            ready={ready}
            conversationId={chatId ? (chatId as Id<"orchestratorConversations">) : undefined}
            hasChats={(chats?.length ?? 0) > 0}
            onOpen={onOpen}
          />
        </main>
        <footer className="z-home-composer">
          <OrchestratorComposer
            ready={ready}
            conversationId={chatId ? (chatId as Id<"orchestratorConversations">) : undefined}
            onStarted={(id) => onOpenChat(id, "replace")}
          />
        </footer>
      </div>
      <ChatOptions
        chat={chatMenu}
        onClose={() => setChatMenu(undefined)}
        onDeleted={(id) => {
          if (id === chatId) onOpenChat("", "replace");
        }}
      />
    </div>
  );
}

const CHAT_TITLE_LIMIT = 80;

/** Rename or delete one chat. Deleting hides it; nothing running is affected. */
function ChatOptions({
  chat,
  onClose,
  onDeleted,
}: {
  chat: ChatRow | undefined;
  onClose: () => void;
  onDeleted: (id: Id<"orchestratorConversations">) => void;
}) {
  const rename = useMutation(api.orchestrator.renameConversation);
  const archive = useMutation(api.orchestrator.archiveConversation);
  const [title, setTitle] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Each opened chat starts from its own title.
  const [seen, setSeen] = useState<string>();
  if (chat && chat._id !== seen) {
    setSeen(chat._id);
    setTitle(chat.title);
    setConfirming(false);
    setError("");
  }
  if (!chat && seen !== undefined) setSeen(undefined);
  const trimmed = title.replace(/\s+/g, " ").trim();
  return (
    <Sheet open={chat !== undefined} title="Chat options" onClose={onClose}>
      {chat && (
        <div className="z-stack">
          <form
            className="z-stack"
            aria-label="Rename chat"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!trimmed || trimmed.length > CHAT_TITLE_LIMIT)
                return setError(`Use a name of 1 to ${CHAT_TITLE_LIMIT} characters.`);
              setBusy(true);
              setError("");
              try {
                await rename({ conversationId: chat._id, title: trimmed });
                onClose();
              } catch (failure) {
                setError(explainError(failure, "Could not rename this chat."));
              } finally {
                setBusy(false);
              }
            }}
          >
            <TextInput
              value={title}
              aria-label="Chat name"
              maxLength={CHAT_TITLE_LIMIT}
              onChange={(event) => setTitle(event.target.value)}
            />
            <Button type="submit" block disabled={busy || trimmed === chat.title}>
              {busy ? "Saving…" : "Rename"}
            </Button>
          </form>
          {error && <Notice tone="danger">{error}</Notice>}
          {confirming ? (
            <div className="z-stack">
              <p className="z-small z-muted">
                The chat disappears from your list. Work Sessions it opened keep running.
              </p>
              <div className="z-row">
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      await archive({ conversationId: chat._id });
                      onDeleted(chat._id);
                      onClose();
                    } catch (failure) {
                      setError(explainError(failure, "Could not delete this chat."));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Delete chat
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
                  Keep
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="secondary" block disabled={busy} onClick={() => setConfirming(true)}>
              Delete chat…
            </Button>
          )}
        </div>
      )}
    </Sheet>
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
  if (link.targetType === "pull_request") {
    const href = link.url ? safeHref(link.url) : undefined;
    return href ? <Chip label={link.label} status={status} href={href} /> : null;
  }
  const sessionId = link.workSessionId;
  if (!sessionId) return null;
  return (
    <Chip
      label={link.label}
      status={status}
      onClick={() =>
        onOpen(
          sessionId,
          link.targetType === "run" ? (link.targetId as Id<"agentRuns">) : undefined,
        )
      }
    />
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
  /** The model's reply failed and the quick summary stands in; `failure` says why. */
  modelError?: string;
  failure?: {
    agent: string;
    runtime: string;
    model?: string;
    modelActual?: string;
    reason?: string;
    at: number;
  };
  createdAt: number;
  links: OrchestratorLink[];
}

/** A computer that has the repository, as `repositories.computers` reports it. */
interface Computer {
  workstationId: Id<"workstations">;
  name: string;
  platform?: string;
  online: boolean;
  runtimes: string[];
}
const RUNTIME_NAMES: Record<string, string> = { codex: "Codex", claude: "Claude" };
/** "Online · Codex, Claude" / "Offline"; the agents it has are what matters for the choice. */
export function computerDescription(computer: Pick<Computer, "online" | "runtimes">): string {
  const agents = computer.runtimes.map((runtime) => RUNTIME_NAMES[runtime] ?? runtime);
  return [computer.online ? "Online" : "Offline", agents.length ? agents.join(", ") : "no agent"]
    .filter(Boolean)
    .join(" · ");
}

// After this long the Node is not waited for; the summary shown is the answer.
const THINKING_SHOWN_MS = 10 * 60_000;

function routeMeta(message: OrchestratorMessage, thinking: boolean) {
  if (thinking) return "Quick summary · a fuller answer is on its way";
  if (message.route === "create" || message.route === "continue") return "Legacy work request";
  if (message.modelError) return "Quick summary · the AI model failed";
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
  // "Run on": offered only when more than one computer has the repository.
  const computers = useQuery(
    api.repositories.computers,
    repositoryId ? { repositoryId } : "skip",
  ) as Computer[] | undefined;
  const [workstationId, setWorkstationId] = useState<Id<"workstations"> | "">("");
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
            {computers && computers.length > 1 && (
              <Picker
                label="Run on"
                value={workstationId}
                options={[
                  {
                    value: "",
                    label: "Any online computer",
                    description: "Zamolxis picks the first computer that is online with the agent.",
                  },
                  ...computers.map((computer) => ({
                    value: computer.workstationId,
                    label: computer.name,
                    description: computerDescription(computer),
                  })),
                ]}
                onChange={(value) => setWorkstationId(value as Id<"workstations"> | "")}
              />
            )}
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
                  onOpen(
                    await open({
                      messageId: message._id,
                      productId,
                      repositoryId,
                      ...(workstationId ? { workstationId } : {}),
                    }),
                  );
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
  conversationId,
  hasChats,
  onOpen,
}: {
  ready: boolean;
  conversationId: Id<"orchestratorConversations"> | undefined;
  hasChats: boolean;
  onOpen: (id: Id<"workSessions">, runId?: Id<"agentRuns">) => void;
}) {
  // A new chat has no messages to load; the list stays empty until the first one is sent.
  const loaded = useQuery(
    api.orchestrator.messages,
    ready && conversationId ? { conversationId } : "skip",
  ) as OrchestratorMessage[] | undefined;
  const messages = conversationId ? loaded : [];
  const now = Date.now();
  const thinking = (message: OrchestratorMessage) =>
    message.status === "thinking" && now - message.createdAt < THINKING_SHOWN_MS;
  // A newly sent message scrolls into view; the first render stays at the top.
  const end = useRef<HTMLDivElement>(null);
  const seen = useRef<number | undefined>(undefined);
  const count = messages?.length;
  useEffect(() => {
    if (count === undefined) return;
    if (seen.current !== undefined && count > seen.current)
      end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    seen.current = count;
  }, [count]);
  return (
    <section className="z-stack" aria-label="Orchestrator conversation">
      <div className="z-row z-row--between">
        <h2 className="z-section-title">{conversationId ? "Ask Zamolxis" : "New chat"}</h2>
        <span className="z-xsmall z-muted">Ask anything · nothing starts until you say so</span>
      </div>
      {messages === undefined ? (
        <p className="z-muted" role="status">
          Loading conversation…
        </p>
      ) : messages.length ? (
        <div className="z-chat-timeline" aria-live="polite">
          {messages.map((message) => (
            <div className="z-chat-timeline__item" key={message._id}>
              <span className="z-chat-timeline__marker" aria-hidden="true" />
              <div className="z-chat-timeline__exchange">
                <Message author="user" label="You" meta={relativeTime(message.createdAt, now)}>
                  {message.text}
                </Message>
                <Message
                  author="assistant"
                  label="Zamolxis"
                  meta={routeMeta(message, thinking(message))}
                >
                  {thinking(message) && <Thinking label="Writing a reply…" />}
                  <Markdown>{message.reply}</Markdown>
                  {message.modelError && (
                    <div className="z-stack">
                      <span className="z-small">
                        The AI model couldn't answer ({explainFailure(message.modelError)}), so this
                        is only a quick summary. Send your message again to retry.
                      </span>
                      {message.failure && (
                        <FailureDetails
                          failure={{ ...message.failure, who: agentName(message.failure.agent) }}
                        />
                      )}
                    </div>
                  )}
                  {message.route === "propose" && message.proposal && (
                    <div className="z-stack">
                      <Markdown>{message.proposal}</Markdown>
                      <OpenProposal message={message} onOpen={(id) => onOpen(id)} />
                    </div>
                  )}
                  {message.links.length > 0 && (
                    <div className="z-row z-links">
                      {message.links.map((link) => (
                        <OrchestratorLinkButton key={link._id} link={link} onOpen={onOpen} />
                      ))}
                    </div>
                  )}
                </Message>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="z-muted">
          Ask what is happening, how orchestration works, or tell Zamolxis explicitly to start work.
          {hasChats ? " Earlier chats are in the sidebar." : ""}
        </p>
      )}
      <div ref={end} />
    </section>
  );
}

function OrchestratorComposer({
  ready,
  conversationId,
  onStarted,
}: {
  ready: boolean;
  conversationId: Id<"orchestratorConversations"> | undefined;
  /** The first message of a new chat created it; Home now shows that chat. */
  onStarted: (id: Id<"orchestratorConversations">) => void;
}) {
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
          ? "Pair a computer with a repository before delegating work. Sending a message does not start work."
          : repositoryName
            ? `Context: ${repositoryName} · Sending a message does not start work.`
            : "Sending a message does not start work."
      }
      onSubmit={async () => {
        setBusy(true);
        try {
          const result = await submit({
            ...(productId ? { productId } : {}),
            ...(repositoryId ? { repositoryId } : {}),
            ...(conversationId ? { conversationId } : {}),
            text,
            idempotencyKey: crypto.randomUUID(),
          });
          setText("");
          if (!conversationId) onStarted(result.conversationId);
        } catch (failure) {
          setError(explainError(failure, "Could not send the message. Try again."));
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}
