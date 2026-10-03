import assert from "node:assert/strict";
import { generateKeyPairSync, createSign, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { runFakeLoopOnce } from "../apps/node/src/fake-loop";
import { watchSession } from "../apps/node/src/debug-session";
import { LocalStateStore } from "../packages/node-core/src/persistence/local-state";

// Explicit development-only smoke fixture. No production endpoints, persisted signing keys, or admin impersonation.
const deploymentUrl = process.env.CONVEX_URL ?? "http://127.0.0.1:3210";
assert.equal(
  new URL(deploymentUrl).hostname,
  "127.0.0.1",
  "Smoke test requires a loopback development backend",
);
const config = JSON.parse(readFileSync(".convex/local/default/config.json", "utf8"));
assert.equal(
  Number(new URL(deploymentUrl).port),
  config.ports.cloud,
  "Smoke URL must match this project’s local backend",
);
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const kid = randomUUID();
const jwk = { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" };
let issuer = "";
const server = createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/.well-known/openid-configuration")
    response.end(
      JSON.stringify({
        issuer,
        jwks_uri: `${issuer}/jwks`,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      }),
    );
  else if (request.url === "/jwks") response.end(JSON.stringify({ keys: [jwk] }));
  else {
    response.statusCode = 404;
    response.end("{}");
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
issuer = `http://127.0.0.1:${address.port}`;
const audience = "zamolxis-development-smoke";
const authNames = ["ZAMOLXIS_AUTH_ISSUER", "ZAMOLXIS_AUTH_AUDIENCE"];
const savedEnvironment: Array<{ name: string; value: string | null }> = [];
async function updateEnvironment(changes: Array<{ name: string; value: string | null }>) {
  const response = await fetch(`${deploymentUrl}/api/update_environment_variables`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Convex ${config.adminKey}` },
    body: JSON.stringify({ changes }),
  });
  assert(response.ok, `Development environment update failed: ${response.status}`);
}
for (const name of authNames) {
  const response = await fetch(`${deploymentUrl}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Convex ${config.adminKey}` },
    body: JSON.stringify({
      path: "_system/cli/queryEnvironmentVariables:get",
      format: "convex_encoded_json",
      args: [{ name }],
    }),
  });
  assert(response.ok, "Could not read development authentication configuration");
  const result = await response.json();
  assert.equal(result.status, "success");
  savedEnvironment.push({ name, value: result.value?.value ?? null });
}

function token(subject: string, claims: Record<string, unknown> = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })).toString(
    "base64url",
  );
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(
    JSON.stringify({
      iss: issuer,
      aud: audience,
      sub: subject,
      iat: now,
      exp: now + 600,
      ...claims,
    }),
  ).toString("base64url");
  const input = `${header}.${body}`;
  const signature = createSign("RSA-SHA256").update(input).sign(privateKey, "base64url");
  const result = `${input}.${signature}`;

  return result;
}
function client(jwt?: string) {
  const result = new ConvexHttpClient(deploymentUrl);
  if (jwt) result.setAuth(jwt);
  return result;
}
async function mutation(
  client: ConvexHttpClient,
  name: string,
  args: Record<string, unknown> = {},
) {
  return client.mutation(makeFunctionReference<"mutation">(name), args);
}
async function query(client: ConvexHttpClient, name: string, args: Record<string, unknown> = {}) {
  return client.query(makeFunctionReference<"query">(name), args);
}
async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 90; i++) {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label}: ${String(last)}`);
}
async function rejected(action: () => Promise<unknown>, label: string) {
  let failed = false;
  try {
    await action();
  } catch {
    failed = true;
  }
  assert(failed, label);
}
const runRoot = join(process.cwd(), "../live-smoke", randomUUID());
mkdirSync(runRoot, { recursive: true });
let closeViewer: undefined | (() => Promise<void>);
const originalLog = console.log;
const viewerMessages: string[] = [];
try {
  await updateEnvironment([
    { name: authNames[0]!, value: issuer },
    { name: authNames[1]!, value: audience },
  ]);
  const suffix = randomUUID();
  const userSubject = `smoke-user-${suffix}`;
  const deviceSubject = `smoke-device-${suffix}`;
  const ownerSubject = `${issuer}|${userSubject}`;
  const userToken = token(userSubject);
  const user = client(userToken);
  const deviceToken = token(deviceSubject, { ownerSubject });
  const device = client(deviceToken);
  await waitFor(
    () => mutation(user, "profiles:ensure", { displayName: "Live smoke" }),
    (value) => typeof value === "string",
    "Deploy/authenticate profile",
  );
  await rejected(() => mutation(client(), "profiles:ensure"), "Unauthenticated user accepted");
  const badSignature = userToken.slice(0, -10) + "AAAAAAAAAA";
  await rejected(
    () => mutation(client(badSignature), "profiles:ensure"),
    "Invalid signature accepted",
  );
  await rejected(
    () => mutation(client(token("wrong-audience", { aud: "different" })), "profiles:ensure"),
    "Wrong audience accepted",
  );
  const workstationId = await mutation(user, "workstations:register", {
    name: "Live smoke Node",
    nodeAuthSubject: `${issuer}|${deviceSubject}`,
  });
  await rejected(
    () =>
      query(client(token(deviceSubject, { ownerSubject: "incorrect-owner" })), "node:listPending", {
        workstationId,
      }),
    "Wrong device owner accepted",
  );
  const repositoryPath = join(runRoot, "canonical");
  const managedRoot = join(runRoot, "managed");
  mkdirSync(repositoryPath);
  mkdirSync(managedRoot);
  const git = (args: string[]) =>
    execFileSync("git", ["-C", repositoryPath, ...args], { encoding: "utf8" }).trim();
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Smoke"]);
  git(["config", "user.email", "smoke@example.invalid"]);
  writeFileSync(join(repositoryPath, "source.txt"), "base\n");
  git(["add", "."]);
  git(["commit", "-m", "base"]);
  git(["remote", "add", "origin", "https://example.invalid/zamolxis/smoke.git"]);
  const canonicalHead = git(["rev-parse", "HEAD"]);
  const canonicalStatus = git(["status", "--porcelain"]);
  const repositoryId = await mutation(user, "repositories:create", {
    name: "Live smoke repository",
    remoteUrl: "https://example.invalid/zamolxis/smoke.git",
  });
  const options = {
    deploymentUrl,
    deviceToken,
    workstationId,
    repositoryId,
    repositoryPath,
    repositoryRemote: "https://example.invalid/zamolxis/smoke.git",
    managedRoot,
  };
  await runFakeLoopOnce(options);
  const repositoryLocationId = await mutation(device, "node:registerLocation", {
    workstationId,
    repositoryId,
    canonicalPath: repositoryPath,
    gitCommonDir: join(repositoryPath, ".git"),
    headSha: canonicalHead,
  });
  const workSessionId = await mutation(user, "sessions:create", {
    title: "Live smoke Session",
    goal: "Execute a fake task",
    repositoryIds: [repositoryId],
  });
  const taskId = await mutation(user, "tasks:create", {
    workSessionId,
    title: "Live smoke task",
    description: "Execute the deterministic fake runtime",
    kind: "implementation",
    priority: 1,
    runtimePolicy: { mode: "forced", runtime: "fake" },
  });
  console.log = (...args: unknown[]) => {
    viewerMessages.push(args.map(String).join(" "));
    originalLog(...args);
  };
  closeViewer = watchSession(deploymentUrl, userToken, workSessionId);
  const workspaceId = await mutation(user, "workspaces:request", {
    taskId,
    repositoryLocationId,
    baseRef: "main",
  });
  await runFakeLoopOnce(options);
  const runId = await mutation(user, "runs:request", { taskId, workspaceId, runtime: "fake" });
  await runFakeLoopOnce(options);
  await runFakeLoopOnce(options);
  const run = await query(user, "runs:get", { runId });
  const session = await query(user, "sessions:get", { workSessionId });
  const events = await query(user, "events:listByRun", {
    runId,
    paginationOpts: { numItems: 100, cursor: null },
  });
  const workspaces = await query(user, "workspaces:listBySession", { workSessionId });
  assert.equal(run.status, "completed");
  assert.equal(run.finalHeadSha, canonicalHead);
  assert.equal(session.status, "completed");
  assert.equal(session.completedTaskCount, 1);
  assert.equal(session.activeRunCount, 0);
  assert.equal(events.page.length, 3);
  assert.notEqual(workspaces[0].localPath, repositoryPath);
  assert.equal(workspaces[0].ownerRunId, undefined);
  const store = new LocalStateStore(join(managedRoot, "node-state.sqlite"));
  try {
    assert.equal(store.listPendingEvents().length, 0);
    assert.equal(store.getWorkspaceLease(workspaceId), undefined);
  } finally {
    store.close();
  }
  assert.equal(git(["rev-parse", "HEAD"]), canonicalHead);
  assert.equal(git(["status", "--porcelain"]), canonicalStatus);
  await waitFor(
    async () => viewerMessages.some((message) => message.includes("Live smoke Session: completed")),
    Boolean,
    "Reactive viewer update",
  );
  const other = client(token(`other-${suffix}`));
  await mutation(other, "profiles:ensure");
  await rejected(
    () => query(other, "sessions:get", { workSessionId }),
    "Cross-owner Session accepted",
  );
  await mutation(user, "workstations:revoke", { workstationId });
  await rejected(
    () => query(device, "node:listPending", { workstationId }),
    "Revoked device accepted",
  );
  const result = {
    deployment: "local development",
    signedJwtVerified: true,
    invalidSignatureRejected: true,
    wrongAudienceRejected: true,
    wrongDeviceOwnerRejected: true,
    crossOwnerRejected: true,
    revokedDeviceRejected: true,
    canonicalUnchanged: true,
    sessionStatus: session.status,
    runStatus: run.status,
    eventCount: events.page.length,
    reactiveViewerVerified: true,
    runId,
    workSessionId,
  };
  writeFileSync("../live-smoke-result.json", JSON.stringify(result, null, 2) + "\n");
  originalLog(JSON.stringify(result));
} finally {
  console.log = originalLog;
  await closeViewer?.();
  // Convex requires variables referenced by auth.config to remain present.
  // Empty values disable the temporary provider when the variables were originally unset.
  await updateEnvironment(
    savedEnvironment.map((entry) => ({ ...entry, value: entry.value ?? "" })),
  );
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(runRoot, { recursive: true, force: true });
}
