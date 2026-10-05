"use client";
import {
  AppHeader,
  AppShell,
  Button,
  Composer,
  Notice,
  ProductMark,
  StatusBadge,
} from "@zamolxis/ui";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { explainError } from "./errors";
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
  onOpen: (id: Id<"workSessions">) => void;
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
      footer={<NewSession ready={ready} onCreated={onOpen} />}
    >
      {notices}
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
          <p className="z-muted">No sessions yet. Describe what you want to build below.</p>
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

function NewSession({
  ready,
  onCreated,
}: {
  ready: boolean;
  onCreated: (id: Id<"workSessions">) => void;
}) {
  const products = useQuery(api.supervisor.products, ready ? {} : "skip") as Product[] | undefined;
  const [productId, setProductId] = useState<Id<"products"> | "">("");
  const repositories = useQuery(
    api.repositories.listByProduct,
    ready && productId ? { productId } : "skip",
  ) as Repository[] | undefined;
  const [repositoryId, setRepositoryId] = useState<Id<"repositories"> | "">("");
  const submit = useMutation(api.supervisor.submit);
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
        onChange={(event) => setProductId(event.target.value as Id<"products">)}
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
      disabled={!ready || !repositoryId}
      placeholder="What should we work on?"
      submitLabel="Start"
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
          ? "Pair a Mac with a repository to start a session."
          : repositoryName
            ? `New session in ${repositoryName}`
            : undefined
      }
      onSubmit={async () => {
        if (!productId || !repositoryId) return;
        setBusy(true);
        try {
          const id = await submit({
            productId,
            repositoryId,
            text,
            idempotencyKey: crypto.randomUUID(),
          });
          setText("");
          onCreated(id);
        } catch (failure) {
          setError(explainError(failure, "Could not start the session. Try again."));
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}
