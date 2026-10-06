import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import {
  type CapabilityPolicy,
  contextForRole,
  resolveCapabilities,
  selectCapability,
} from "@zamolxis/application";
import type {
  CapabilityDefinition,
  CapabilityTrace,
  RepositoryContext,
  RepositoryRole,
  RepositorySkill,
  RepositorySource,
} from "@zamolxis/contracts";
import { repositoryFiles } from "@zamolxis/git";
import type { WorkspaceManager } from "../workspace/workspace-manager";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
const skillPattern = /^(?:\.agents|\.codex|\.claude)\/skills\/([a-zA-Z0-9_-]+)\/SKILL\.md$/;
function isInstruction(path: string): boolean {
  return (
    /(^|\/)(AGENTS|CLAUDE)\.md$/.test(path) ||
    path === ".github/copilot-instructions.md" ||
    ["README.md", "package.json", "pnpm-workspace.yaml"].includes(path) ||
    /^docs\/(?:architecture|backend)\/.*\.md$/.test(path)
  );
}
function skillName(content: string, directoryName: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  const name = frontmatter?.match(/^name:\s*["']?([a-zA-Z0-9_-]+)["']?\s*$/m)?.[1] ?? directoryName;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("INVALID_SKILL_NAME");
  return name;
}

export class RepositoryDiscovery {
  constructor(private readonly workspaces: WorkspaceManager) {}

  discover(workspaceId: string, defaults: readonly CapabilityDefinition[] = []): RepositoryContext {
    const workspace = this.workspaces.inspect(workspaceId);
    const sources = repositoryFiles(workspace.path).filter(
      (path) => isInstruction(path) || skillPattern.test(path),
    );
    if (sources.length > 128) throw new Error("REPOSITORY_CONTEXT_TOO_LARGE");
    const instructions: RepositorySource[] = [];
    const skills: RepositorySkill[] = [];
    let totalBytes = 0;
    for (const path of sources) {
      const absolute = join(workspace.path, path);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (stat.isSymbolicLink()) throw new Error(`UNSAFE_REPOSITORY_SOURCE:${path}`);
      const resolved = realpathSync.native(absolute);
      // Do not follow skill/instruction symlinks, including directory symlinks.
      if (
        relative(workspace.path, resolved).split(sep).join("/") !== path ||
        lstatSync(absolute).isSymbolicLink()
      ) {
        throw new Error(`UNSAFE_REPOSITORY_SOURCE:${path}`);
      }
      totalBytes += stat.size;
      if (!stat.isFile() || stat.size > 256 * 1024 || totalBytes > 1024 * 1024)
        throw new Error("REPOSITORY_CONTEXT_TOO_LARGE");
      const content = readFileSync(absolute, "utf8");
      const skill = skillPattern.exec(path);
      const source: RepositorySource = {
        path,
        scope: skill || path === ".github/copilot-instructions.md" ? "." : dirname(path),
        content,
        digest: digest(content),
      };
      if (skill) skills.push({ ...source, capability: skillName(content, skill[1] ?? "") });
      else instructions.push(source);
    }
    const finalWorkspace = this.workspaces.inspect(workspaceId);
    if (workspace.headSha !== finalWorkspace.headSha)
      throw new Error("REPOSITORY_SNAPSHOT_CHANGED");
    const snapshotDigest = digest(
      JSON.stringify({
        gitSha: workspace.headSha,
        sources: [...instructions, ...skills]
          .map(({ path, digest }) => ({ path, digest }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      }),
    );
    return resolveCapabilities(
      {
        repositoryId: workspace.repositoryId,
        workspaceId,
        gitSha: workspace.headSha ?? workspace.baseSha,
        snapshotDigest,
        instructions,
        skills,
        discoveredSources: [...instructions, ...skills].map((source) => source.path).sort(),
        conventions: instructions,
        resolvedCapabilities: {},
      },
      defaults,
    );
  }

  assertCurrent(context: RepositoryContext): void {
    const fresh = this.discover(context.workspaceId);
    if (
      fresh.repositoryId !== context.repositoryId ||
      fresh.gitSha !== context.gitSha ||
      fresh.snapshotDigest !== context.snapshotDigest
    ) {
      throw new Error("STALE_REPOSITORY_CONTEXT");
    }
  }

  prepareRole(
    workspaceId: string,
    role: RepositoryRole,
    defaults: readonly CapabilityDefinition[] = [],
  ) {
    return contextForRole(this.discover(workspaceId, defaults), role);
  }

  select(
    context: RepositoryContext,
    capability: string,
    role: RepositoryRole,
    policy: CapabilityPolicy,
    recordTrace: (entry: CapabilityTrace) => void,
  ) {
    this.assertCurrent(context);
    return selectCapability(context, capability, role, policy, recordTrace);
  }
}
