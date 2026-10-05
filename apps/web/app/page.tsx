"use client";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import "./style.css";
export default function HomePage() {
  if (!process.env.NEXT_PUBLIC_CONVEX_URL)
    return (
      <main>
        <h1>Zamolxis</h1>
        <p>
          Control plane is not configured. Configure the public deployment before pairing a Mac.
        </p>
      </main>
    );
  return <Dashboard />;
}
function Dashboard() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const [pair, setPair] = useState("");
  const [message, setMessage] = useState("");
  const ensure = useMutation(api.profiles.ensure);
  const approve = useMutation(api.pairing.approve);
  const revoke = useMutation(api.workstations.revoke);
  const [ready, setReady] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  const pairing = useQuery(
    api.pairing.preview,
    ready && /^[a-f0-9]{64}$/.test(pair) ? { approvalCode: pair } : "skip",
  );
  useEffect(() => {
    setPair(new URL(location.href).searchParams.get("pair") ?? "");
  }, []);
  useEffect(() => {
    if (isAuthenticated)
      void ensure({})
        .then(() => setReady(true))
        .catch(() => setMessage("Could not initialize profile"));
  }, [isAuthenticated, ensure]);
  const devices = useQuery(api.workstations.listMine, ready ? {} : "skip");
  const products = useQuery(api.supervisor.products, ready ? {} : "skip");
  const [productId, setProductId] = useState<Id<"products"> | "">("");
  const repositories = useQuery(
    api.repositories.listByProduct,
    ready && productId ? { productId } : "skip",
  );
  const [repositoryId, setRepositoryId] = useState<Id<"repositories"> | "">("");
  const [sessionId, setSessionId] = useState<Id<"workSessions"> | "">("");
  const session = useQuery(
    api.sessions.get,
    ready && sessionId ? { workSessionId: sessionId } : "skip",
  );
  const runs = useQuery(
    api.runs.listBySession,
    ready && sessionId ? { workSessionId: sessionId } : "skip",
  );
  const tasks = useQuery(
    api.tasks.listBySession,
    ready && sessionId ? { workSessionId: sessionId } : "skip",
  );
  const submit = useMutation(api.supervisor.submit);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!productId && products?.[0]) setProductId(products[0]._id);
  }, [products, productId]);
  useEffect(() => {
    setRepositoryId(repositories?.[0]?._id ?? "");
  }, [repositories]);
  return (
    <main>
      <header>
        <span className="mark">Z</span>
        <div>
          <h1>Zamolxis</h1>
          <p>Your Mac. Your projects.</p>
        </div>
      </header>
      {isLoading ? (
        <p role="status">Connecting…</p>
      ) : !isAuthenticated ? (
        <section>
          <h2>Connect your Mac</h2>
          <p>Sign in to approve pairing and run your first command.</p>
          <a
            className="button"
            href={`/api/auth/login?returnTo=${encodeURIComponent(pair ? `/?pair=${pair}` : "/")}`}
          >
            Sign in
          </a>
        </section>
      ) : (
        <>
          {pair && (
            <section>
              <h2>Approve {pairing?.name ?? "Mac pairing"}</h2>
              <p>
                Only approve the QR code you just opened from setup on your own Mac. The code
                expires after five minutes.
              </p>
              <button
                type="button"
                disabled={busy || !ready || !pairing?.pending}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await approve({ approvalCode: pair });
                    setPair("");
                    history.replaceState(null, "", "/");
                    setMessage("Mac approved. Setup is configuring products and starting Node.");
                  } catch {
                    setMessage(
                      "Pairing expired, already used, or device issuer is not configured. Rerun setup.",
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Approve this Mac
              </button>
            </section>
          )}
          <section>
            <h2>Nodes</h2>
            {devices?.length ? (
              devices.map((device) => (
                <div className="row" key={device._id}>
                  <strong>{device.name}</strong>
                  <span>
                    Codex:{" "}
                    {device.runtimes.find((runtime) => runtime.runtime === "codex")?.status ??
                      "unavailable"}
                  </span>
                  {device.status !== "revoked" && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={async () => {
                        try {
                          await revoke({ workstationId: device._id });
                          setMessage("Node access revoked");
                        } catch {
                          setMessage("Could not revoke Node access");
                        }
                      }}
                    >
                      Revoke access
                    </button>
                  )}
                  <span>
                    {device.status === "online" && (device.lastHeartbeatAt ?? 0) > now - 45000
                      ? "Online"
                      : device.status === "revoked"
                        ? "Revoked"
                        : "Waiting for heartbeat"}
                  </span>
                </div>
              ))
            ) : (
              <p>
                Run <code>pnpm zamolxis setup</code> on your Mac and scan the QR code.
              </p>
            )}
          </section>
          <section>
            <h2>New command</h2>
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                if (!productId || !repositoryId) return;
                setBusy(true);
                try {
                  const id = await submit({
                    productId,
                    repositoryId,
                    text,
                    idempotencyKey: crypto.randomUUID(),
                    ...(sessionId ? { sessionId } : {}),
                  });
                  setSessionId(id);
                  setText("");
                  setMessage("Command queued for your Mac");
                } catch {
                  setMessage("Cannot submit: check Node, runtime and selected product/session");
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                Product
                <select
                  value={productId}
                  onChange={(event) => {
                    setProductId(event.target.value as Id<"products">);
                    setSessionId("");
                  }}
                >
                  <option value="">Select product</option>
                  {products?.map((product) => (
                    <option key={product._id} value={product._id}>
                      {product.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Repository
                <select
                  value={repositoryId}
                  onChange={(event) => {
                    setRepositoryId(event.target.value as Id<"repositories">);
                    setSessionId("");
                  }}
                >
                  {repositories?.map((repository) => (
                    <option key={repository._id} value={repository._id}>
                      {repository.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                What should we work on?
                <textarea
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  maxLength={16000}
                  rows={5}
                  placeholder="Describe the outcome you need…"
                />
              </label>
              <button type="submit" disabled={busy || !ready || !repositoryId || !text.trim()}>
                Run command
              </button>
            </form>
          </section>
          {session && (
            <section>
              <h2>{session.title}</h2>
              <p>
                Session: {session.status} · {session.completedTaskCount}/{session.totalTaskCount}{" "}
                tasks · {session.activeRunCount} active runs
              </p>
              {runs?.map((run) => (
                <div className="row" key={run._id}>
                  <span>
                    {run.role ?? "builder"} · {run.runtime}
                  </span>
                  <strong>{run.status}</strong>
                </div>
              ))}
              {tasks?.map((task) => (
                <div className="row" key={task._id}>
                  <strong>{task.title}</strong>
                  <span>{(task.phase ?? task.status).replaceAll("_", " ")}</span>
                  {task.candidateRunId && (
                    <span>Candidate recorded · repairs {task.repairAttempts ?? 0}/2</span>
                  )}
                  {task.trustOutcome && <span>Latest trust: {task.trustOutcome}</span>}
                  {task.failureReason && <p role="status">{task.failureReason}</p>}
                </div>
              ))}
              {session.status === "completed" && (
                <p>
                  Trusted integration branches are prepared locally. Publishing and protected-main
                  merge remain human actions.
                </p>
              )}
              <button type="button" className="secondary" onClick={() => setSessionId("")}>
                Start a new session
              </button>
            </section>
          )}
        </>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
    </main>
  );
}
