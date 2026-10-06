import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publishBranchName } from "@zamolxis/application";
import { git } from "@zamolxis/git";
import { RuntimeRegistry } from "@zamolxis/runtime-core";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlaneDriver, type Delivery, type ExecutionCommand } from "../control-plane/driver";
import { LocalStateStore } from "../persistence/local-state";
import { RepositoryRegistry } from "../repository/repository-registry";
import { RuntimeManager } from "../runtime/runtime-manager";
import { repositoryFixture } from "../testing/git-fixture";
import { WorkspaceManager } from "../workspace/workspace-manager";
import { type PublishRequest, type PullRequestInput, publishIntegration } from "./publish";

const cleanup: Array<() => void> = [];
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
  const opened: PullRequestInput[] = [];
  const opener = (url: string | undefined) => ({
    open: async (input: PullRequestInput) => {
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
  return { repo, remote, store, workspaces, integration, sha, request, opened, opener, remoteRef };
}

describe("publishing a trusted integration branch", () => {
  it("pushes the exact trusted commit to a Zamolxis branch and opens a pull request", async () => {
    const f = fixture();
    expect(f.request.branch).toBe(`zamolxis/fix-the-login-form-${f.sha.slice(0, 7)}`);
    const result = await publishIntegration(f.workspaces.inspect("integration"), f.request, {
      pullRequests: f.opener("https://example.invalid/team/repo/pull/7"),
      githubHosts: ["example.invalid"],
    });
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
      host: "example.invalid",
      owner: "team",
      repo: "repo",
      base: "main",
      head: f.request.branch,
    });
    // Bodies leave the Mac redacted.
    expect(f.opened[0]?.body).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    // Retrying the same publication is safe: same commit, nothing forced.
    await publishIntegration(f.workspaces.inspect("integration"), f.request, {
      pullRequests: f.opener(undefined),
      githubHosts: ["example.invalid"],
    });
    expect(f.remoteRef(f.request.branch)).toBe(f.sha);
  });

  it("returns a compare link when no signed-in pull request client is available", async () => {
    const f = fixture();
    const result = await publishIntegration(f.workspaces.inspect("integration"), f.request, {
      pullRequests: f.opener(undefined),
      githubHosts: ["example.invalid"],
    });
    expect(result.prUrl).toBeUndefined();
    expect(result.compareUrl).toBe(
      `https://example.invalid/team/repo/compare/main...${f.request.branch}`,
    );
    // A non-GitHub remote still gets the push, without links.
    const plain = await publishIntegration(f.workspaces.inspect("integration"), f.request, {
      pullRequests: f.opener("https://example.invalid/never"),
    });
    expect(plain).toEqual({ remoteBranch: f.request.branch, base: "main" });
    expect(f.opened).toHaveLength(1);
  });

  it("refuses dirty worktrees, other commits, default or foreign branches and plain worktrees", async () => {
    const f = fixture();
    const options = { pullRequests: f.opener(undefined) };
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
    const options = { pullRequests: f.opener(undefined) };
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
      publishIntegration(f.workspaces.inspect("integration"), f.request, {
        pullRequests: {
          open: async () => {
            throw new Error("gh: HTTP 422 token=ghp_secret");
          },
        },
        githubHosts: ["example.invalid"],
      }),
    ).rejects.toThrow(/^PUBLISH_PR_FAILED$/);
    await expect(
      publishIntegration(f.workspaces.inspect("integration"), f.request, {
        pullRequests: f.opener("https://attacker.invalid/pull/1"),
        githubHosts: ["example.invalid"],
      }),
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
        pullRequests: f.opener("https://example.invalid/team/repo/pull/9"),
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
  });
});
