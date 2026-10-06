import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GitHubAccessStatus, publishBranchName } from "@zamolxis/application";
import { git } from "@zamolxis/git";
import { RuntimeRegistry } from "@zamolxis/runtime-core";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlaneDriver, type Delivery, type ExecutionCommand } from "../control-plane/driver";
import type { GitHubClient, PullRequestRequest } from "../github/github-api";
import { PublishingCredentials } from "../github/publishing-credentials";
import { MemoryRepositoryTokenStore, type RepositoryTokenStore } from "../github/token-store";
import { LocalStateStore } from "../persistence/local-state";
import { RepositoryRegistry } from "../repository/repository-registry";
import { RuntimeManager } from "../runtime/runtime-manager";
import { repositoryFixture } from "../testing/git-fixture";
import { WorkspaceManager } from "../workspace/workspace-manager";
import { type PublishRequest, publishIntegration } from "./publish";

const cleanup: Array<() => void> = [];
const TOKEN = `github_pat_${"A1b2C3d4E5".repeat(8)}`;
const GH_TOKEN = `gho_${"Gh0Acc0unt".repeat(4)}`;
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

// The origin stays https://example.invalid/team/repo.git (the registered identity); pushes are
// rewritten to a disposable bare repository, so nothing ever reaches a real remote.
function fixture() {
  const repo = repositoryFixture();
  cleanup.push(() => rmSync(repo.root, { recursive: true, force: true }));
  const remote = join(repo.root, "remote.git");
  git(repo.root, ["init", "--bare", "-b", "main", remote]);
  git(repo.path, [
    "config",
    `url.${remote}.pushInsteadOf`,
    "https://example.invalid/team/repo.git",
  ]);
  git(repo.path, ["push", "https://example.invalid/team/repo.git", "main:main"]);
  const store = new LocalStateStore(":memory:");
  cleanup.push(() => store.close());
  const repositories = new RepositoryRegistry(store, () => true);
  repositories.register({
    repositoryLocationId: "location",
    repositoryId: "repo",
    workstationId: "node",
    path: repo.path,
    expectedIdentity: { remoteUrl: "https://example.invalid/team/repo" },
  });
  const workspaces = new WorkspaceManager(
    store,
    repositories,
    join(repo.root, "workspaces"),
    "instance",
    () => true,
  );
  const integration = workspaces.provision({
    workspaceId: "integration",
    repositoryLocationId: "location",
    baseRef: "main",
    kind: "integration",
  });
  const sha = integration.baseSha;
  const request: PublishRequest = {
    taskId: "task",
    workspaceId: "integration",
    branch: publishBranchName("Fix the login form", sha),
    base: "main",
    subjectSha: sha,
    title: "Fix the login form",
    body: "Opened by Zamolxis; merge is a human decision.\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  };
  const repository = { host: "example.invalid", owner: "team", repo: "repo" };
  const tokens = new MemoryRepositoryTokenStore();
  tokens.write(repository, TOKEN);
  const opened: PullRequestRequest[] = [];
  const checked: string[] = [];
  // A GitHub API stand-in: no network, records what publishing asked for.
  const github = (
    url = "https://example.invalid/team/repo/pull/7",
    status: GitHubAccessStatus = "ok",
  ): GitHubClient => ({
    checkAccess: async (_repository, token) => {
      checked.push(token);
      return { status, login: "publisher", checkedAt: 0 };
    },
    openPullRequest: async (input) => {
      opened.push(input);
      return url;
    },
  });
  const remoteRef = (branch: string) => {
    try {
      return git(remote, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    } catch {
      return undefined;
    }
  };
  const credentials = (
    store: RepositoryTokenStore = tokens,
    account?: { login: string; token?: string },
  ) =>
    new PublishingCredentials({
      tokens: store,
      account: ({ repositoryId }) => (repositoryId === "repo" ? account?.login : undefined),
      ghTokens: {
        read: (host, login) =>
          host === "example.invalid" && login === account?.login ? account.token : undefined,
      },
    });
  const options = (client: GitHubClient = github(), using = credentials()) => ({
    credentials: using,
    github: client,
    githubHosts: ["example.invalid"],
  });
  return {
    repo,
    remote,
    store,
    workspaces,
    integration,
    sha,
    request,
    repository,
    tokens,
    opened,
    checked,
    github,
    credentials,
    options,
    remoteRef,
  };
}

describe("publishing a trusted integration branch", () => {
  it("pushes the exact trusted commit to a Zamolxis branch and opens a pull request", async () => {
    const f = fixture();
    expect(f.request.branch).toBe(`zamolxis/fix-the-login-form-${f.sha.slice(0, 7)}`);
    // The pre-push hook sees the push as it runs: the token is in git's environment only,
    // never on its command line.
    const hooks = join(f.repo.path, ".git", "hooks");
    const seen = join(f.repo.root, "seen.txt");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      join(hooks, "pre-push"),
      `#!/bin/sh\n{ echo "env=\${ZAMOLXIS_PUBLISH_TOKEN:+set}"; ps -o args= -p $PPID; } > '${seen}'\nexit 0\n`,
    );
    chmodSync(join(hooks, "pre-push"), 0o755);
    const result = await publishIntegration(
      f.workspaces.inspect("integration"),
      f.request,
      f.options(),
    );
    const observed = readFileSync(seen, "utf8");
    expect(observed).toContain("env=set");
    expect(observed).toContain("push --porcelain https://example.invalid/team/repo.git");
    expect(observed).not.toContain(TOKEN);
    expect(observed).toContain("credential.helper=");
    expect(f.checked).toEqual([TOKEN]);
    expect(f.remoteRef(f.request.branch)).toBe(f.sha);
    expect(f.remoteRef("main")).toBe(f.sha);
    expect(result).toEqual({
      remoteBranch: f.request.branch,
      base: "main",
      prUrl: "https://example.invalid/team/repo/pull/7",
      compareUrl: `https://example.invalid/team/repo/compare/main...${f.request.branch}`,
    });
    expect(f.opened).toHaveLength(1);
    expect(f.opened[0]).toMatchObject({
      repository: f.repository,
      token: TOKEN,
      base: "main",
      head: f.request.branch,
    });
    // Bodies leave the computer redacted.
    expect(f.opened[0]?.body).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    // Retrying the same publication is safe: same commit, nothing forced, and the GitHub
    // client is asked again so it can recover an existing open, closed or merged PR.
    const again = await publishIntegration(
      f.workspaces.inspect("integration"),
      f.request,
      f.options(),
    );
    expect(again.prUrl).toBe("https://example.invalid/team/repo/pull/7");
    expect(f.remoteRef(f.request.branch)).toBe(f.sha);
  });

  it("needs this repository's own GitHub token and never falls back to another identity", async () => {
    const f = fixture();
    const workspace = f.workspaces.inspect("integration");
    const empty = f.options(undefined, f.credentials(new MemoryRepositoryTokenStore()));
    await expect(publishIntegration(workspace, f.request, empty)).rejects.toThrow(
      /^PUBLISH_GITHUB_NOT_CONNECTED$/,
    );
    for (const [status, code] of [
      ["invalid", "PUBLISH_GITHUB_TOKEN_INVALID"],
      ["expired", "PUBLISH_GITHUB_TOKEN_EXPIRED"],
      ["no_push", "PUBLISH_GITHUB_NO_PUSH"],
      ["unreachable", "PUBLISH_GITHUB_UNREACHABLE"],
    ] as const)
      await expect(
        publishIntegration(workspace, f.request, f.options(f.github(undefined, status))),
      ).rejects.toThrow(new RegExp(`^${code}$`));
    const unreadable = f.options(
      undefined,
      f.credentials({
        read: () => {
          throw new Error("KEYCHAIN_UNAVAILABLE");
        },
        write: () => undefined,
        remove: () => undefined,
      }),
    );
    await expect(publishIntegration(workspace, f.request, unreadable)).rejects.toThrow(
      "PUBLISH_GITHUB_TOKEN_UNREADABLE",
    );
    // Nothing was pushed and no pull request was opened.
    expect(f.remoteRef(f.request.branch)).toBeUndefined();
    expect(f.opened).toHaveLength(0);
    // An expiring token still publishes.
    const expiring = await publishIntegration(
      workspace,
      f.request,
      f.options(f.github(undefined, "expiring")),
    );
    expect(expiring.prUrl).toBe("https://example.invalid/team/repo/pull/7");
  });

  it("publishes with the repository's chosen gh account when it has no token of its own", async () => {
    const f = fixture();
    const workspace = f.workspaces.inspect("integration");
    const none = new MemoryRepositoryTokenStore();
    const hooks = join(f.repo.path, ".git", "hooks");
    const seen = join(f.repo.root, "seen-gh.txt");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      join(hooks, "pre-push"),
      `#!/bin/sh\n{ echo "env=\${ZAMOLXIS_PUBLISH_TOKEN:+set} user=\${ZAMOLXIS_PUBLISH_USERNAME}"; ps -o args= -p $PPID; } > '${seen}'\nexit 0\n`,
    );
    chmodSync(join(hooks, "pre-push"), 0o755);
    const result = await publishIntegration(
      workspace,
      f.request,
      f.options(undefined, f.credentials(none, { login: "publisher", token: GH_TOKEN })),
    );
    const observed = readFileSync(seen, "utf8");
    expect(observed).toContain("env=set user=publisher");
    expect(observed).not.toContain(GH_TOKEN);
    expect(f.checked).toEqual([GH_TOKEN]);
    expect(f.remoteRef(f.request.branch)).toBe(f.sha);
    expect(result.prUrl).toBe("https://example.invalid/team/repo/pull/7");
    // The pull request is opened through the same REST path, with the account's token.
    expect(f.opened[0]).toMatchObject({ repository: f.repository, token: GH_TOKEN });
    // A stored token takes precedence over the account.
    await publishIntegration(
      workspace,
      f.request,
      f.options(undefined, f.credentials(f.tokens, { login: "publisher", token: GH_TOKEN })),
    );
    expect(f.checked).toEqual([GH_TOKEN, TOKEN]);
    expect(f.opened[1]?.token).toBe(TOKEN);
  });

  it("refuses a GitHub publication when the configured repository account is unavailable", async () => {
    const f = fixture();
    const workspace = f.workspaces.inspect("integration");
    const none = new MemoryRepositoryTokenStore();
    // Not signed in to gh on this computer: no fallback to any other account.
    await expect(
      publishIntegration(
        workspace,
        f.request,
        f.options(undefined, f.credentials(none, { login: "publisher" })),
      ),
    ).rejects.toThrow(/^PUBLISH_GITHUB_AUTH_REQUIRED$/);
    // The saved credential now belongs to another login.
    await expect(
      publishIntegration(
        workspace,
        f.request,
        f.options(undefined, f.credentials(none, { login: "someone-else", token: GH_TOKEN })),
      ),
    ).rejects.toThrow(/^PUBLISH_GITHUB_AUTH_REQUIRED$/);
    // GitHub rejects the account's credential: sign in again.
    await expect(
      publishIntegration(
        workspace,
        f.request,
        f.options(
          f.github(undefined, "invalid"),
          f.credentials(none, { login: "publisher", token: GH_TOKEN }),
        ),
      ),
    ).rejects.toThrow(/^PUBLISH_GITHUB_AUTH_REQUIRED$/);
    // The account cannot push this repository.
    await expect(
      publishIntegration(
        workspace,
        f.request,
        f.options(
          f.github(undefined, "no_push"),
          f.credentials(none, { login: "publisher", token: GH_TOKEN }),
        ),
      ),
    ).rejects.toThrow(/^PUBLISH_GITHUB_NO_PUSH$/);
    expect(f.remoteRef(f.request.branch)).toBeUndefined();
    expect(f.opened).toHaveLength(0);
  });

  it("pushes a non-GitHub remote with the repository's own credentials, without links", async () => {
    const f = fixture();
    const plain = await publishIntegration(f.workspaces.inspect("integration"), f.request, {
      credentials: f.credentials(new MemoryRepositoryTokenStore()),
      github: f.github(),
    });
    expect(plain).toEqual({ remoteBranch: f.request.branch, base: "main" });
    expect(f.remoteRef(f.request.branch)).toBe(f.sha);
    expect(f.opened).toHaveLength(0);
    expect(f.checked).toHaveLength(0);
  });

  it("refuses dirty worktrees, other commits, default or foreign branches and plain worktrees", async () => {
    const f = fixture();
    const options = f.options();
    const workspace = f.workspaces.inspect("integration");
    await expect(
      publishIntegration(workspace, { ...f.request, subjectSha: "f".repeat(40) }, options),
    ).rejects.toThrow("PUBLISH_SHA_MISMATCH");
    await expect(
      publishIntegration(workspace, { ...f.request, branch: "main" }, options),
    ).rejects.toThrow("PUBLISH_DEFAULT_BRANCH");
    await expect(
      publishIntegration(workspace, { ...f.request, branch: "feature/human-work" }, options),
    ).rejects.toThrow("PUBLISH_INVALID_BRANCH");
    await expect(
      publishIntegration(workspace, { ...f.request, branch: "zamolxis/other-0000000" }, options),
    ).rejects.toThrow("PUBLISH_INVALID_BRANCH");
    // Without a known default branch there is nothing safe to target.
    const { base: _, ...unknownBase } = f.request;
    await expect(publishIntegration(workspace, unknownBase, options)).rejects.toThrow(
      "PUBLISH_BASE_UNKNOWN",
    );
    await expect(
      publishIntegration({ ...workspace, kind: "worktree" }, f.request, options),
    ).rejects.toThrow("PUBLISH_NOT_INTEGRATION");
    writeFileSync(join(f.integration.path, "source.txt"), "uncommitted\n");
    await expect(
      publishIntegration(f.workspaces.inspect("integration"), f.request, options),
    ).rejects.toThrow("PUBLISH_DIRTY");
    expect(f.remoteRef(f.request.branch)).toBeUndefined();
  });

  it("never forces over a diverged remote branch and respects pre-push hooks", async () => {
    const f = fixture();
    const options = f.options();
    // Someone else's commit already sits on the branch name: a push must not replace it.
    git(f.repo.path, ["checkout", "-q", "-b", "elsewhere"]);
    writeFileSync(join(f.repo.path, "other.txt"), "other\n");
    git(f.repo.path, ["add", "."]);
    git(f.repo.path, ["commit", "-q", "-m", "other"]);
    const other = git(f.repo.path, ["rev-parse", "HEAD"]);
    git(f.repo.path, [
      "push",
      "-q",
      "https://example.invalid/team/repo.git",
      `${other}:refs/heads/${f.request.branch}`,
    ]);
    git(f.repo.path, ["checkout", "-q", "main"]);
    await expect(
      publishIntegration(f.workspaces.inspect("integration"), f.request, options),
    ).rejects.toThrow("PUBLISH_PUSH_FAILED");
    expect(f.remoteRef(f.request.branch)).toBe(other);
    // The repository's own hooks run: a rejecting pre-push hook stops the publication.
    const hooks = join(f.repo.path, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-push"), "#!/bin/sh\necho 'token=secret-value' >&2\nexit 1\n");
    chmodSync(join(hooks, "pre-push"), 0o755);
    const fresh = { ...f.request, branch: publishBranchName("Another", f.sha) };
    const failure = await publishIntegration(
      f.workspaces.inspect("integration"),
      fresh,
      options,
    ).catch((error: Error) => error);
    expect((failure as Error).message).toBe("PUBLISH_PUSH_FAILED");
    expect(f.remoteRef(fresh.branch)).toBeUndefined();
  });

  it("fails visibly when the pull request cannot be opened", async () => {
    const f = fixture();
    await expect(
      publishIntegration(
        f.workspaces.inspect("integration"),
        f.request,
        f.options({
          ...f.github(),
          openPullRequest: async () => {
            throw new Error("HTTP 422 token=ghp_secret");
          },
        }),
      ),
    ).rejects.toThrow(/^PUBLISH_PR_FAILED$/);
    await expect(
      publishIntegration(
        f.workspaces.inspect("integration"),
        f.request,
        f.options(f.github("https://attacker.invalid/pull/1")),
      ),
    ).rejects.toThrow("PUBLISH_PR_FAILED");
  });

  it("runs as a control-plane command and reports the result or a coded failure", async () => {
    const f = fixture();
    const runtimes = new RuntimeRegistry();
    const manager = new RuntimeManager(
      f.store,
      f.workspaces,
      runtimes,
      "node" as never,
      () => true,
    );
    const deliveries: Delivery[] = [];
    const driver = new ControlPlaneDriver(
      f.store,
      f.workspaces,
      runtimes,
      manager,
      {
        listPending: async () => [],
        claim: async () => {},
        acknowledge: async () => {},
        reconcile: async () => {},
        deliver: async (delivery) => {
          deliveries.push(delivery);
        },
      },
      "node",
      {
        githubCredentials: f.credentials(),
        github: f.github("https://example.invalid/team/repo/pull/9"),
        githubHosts: ["example.invalid"],
      },
    );
    const command = (id: string, payload: PublishRequest): ExecutionCommand => ({
      commandId: id,
      idempotencyKey: id,
      workstationId: "node",
      type: "integration.publish",
      payload,
    });
    await driver.execute(command("publish-1", f.request));
    expect(deliveries).toEqual([
      {
        kind: "integration.published",
        commandId: "publish-1",
        taskId: "task",
        subjectSha: f.sha,
        remoteBranch: f.request.branch,
        base: "main",
        prUrl: "https://example.invalid/team/repo/pull/9",
        compareUrl: `https://example.invalid/team/repo/compare/main...${f.request.branch}`,
      },
      { kind: "command.complete", commandId: "publish-1" },
    ]);
    deliveries.length = 0;
    await driver.execute(command("publish-2", { ...f.request, subjectSha: "e".repeat(40) }));
    expect(deliveries).toEqual([
      { kind: "command.failed", commandId: "publish-2", code: "PUBLISH_SHA_MISMATCH" },
    ]);
    // A driver without tokens reports the missing token instead of using another identity.
    deliveries.length = 0;
    const tokenless = new ControlPlaneDriver(
      f.store,
      f.workspaces,
      runtimes,
      manager,
      {
        listPending: async () => [],
        claim: async () => {},
        acknowledge: async () => {},
        reconcile: async () => {},
        deliver: async (delivery) => {
          deliveries.push(delivery);
        },
      },
      "node",
      { github: f.github(), githubHosts: ["example.invalid"] },
    );
    await tokenless.execute(command("publish-3", f.request));
    expect(deliveries).toEqual([
      { kind: "command.failed", commandId: "publish-3", code: "PUBLISH_GITHUB_NOT_CONNECTED" },
    ]);
  });
});
