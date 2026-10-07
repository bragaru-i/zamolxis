import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";
import { type AgentRole, withoutGitHubTokens } from "@zamolxis/runtime-core";

const PIN_TIMEOUT = 300_000;
const INSTALL_TIMEOUT = 600_000;
// An exact pnpm version, optionally followed by Corepack's integrity suffix.
const PNPM_PIN = /^pnpm@(\d+\.\d+\.\d+)(\+[A-Za-z0-9.]+)?$/;

export type Execute = (
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
) => Promise<boolean>;

const execute: Execute = (executable, args, options) =>
  new Promise((resolve) =>
    execFile(executable, args, { ...options, maxBuffer: 4 * 1024 * 1024 }, (error) =>
      resolve(!error),
    ),
  );

function pinnedPnpm(cwd: string): string | undefined {
  try {
    const path = join(cwd, "package.json");
    if (lstatSync(path).isSymbolicLink()) return undefined;
    const pin = JSON.parse(readFileSync(path, "utf8")).packageManager;
    return typeof pin === "string" ? pin.match(PNPM_PIN)?.[1] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Prepares a worktree once, outside the agent sandbox, so the agent never needs the network
 * or an approval for ordinary work. Agents run offline: a pnpm that switches to the
 * repository's pinned version verifies that version against the registry on every call and
 * fails, and a fresh worktree has no dependencies. The Node therefore keeps each pinned
 * pnpm under `toolsDir` (returned as a directory to put first on the agent's PATH) and, for
 * roles that build, installs the dependencies from the repository's lockfile. Failures are
 * not fatal: the agent then runs as before and may ask.
 */
export class WorkspaceToolchain {
  constructor(
    private readonly toolsDir: string,
    private readonly run: Execute = execute,
  ) {}

  async prepare(cwd: string, role: AgentRole | undefined): Promise<string[]> {
    const version = pinnedPnpm(cwd);
    const bin = version ? await this.#pnpm(version) : undefined;
    const paths = bin ? [bin] : [];
    if (role === "builder" || role === "repair" || role === undefined)
      await this.#install(cwd, paths);
    return paths;
  }

  // The pinned pnpm, installed once per version with npm and moved into place atomically.
  async #pnpm(version: string): Promise<string | undefined> {
    const home = join(this.toolsDir, `pnpm@${version}`);
    const bin = join(home, "node_modules", ".bin");
    if (existsSync(join(bin, "pnpm"))) return bin;
    const staging = `${home}.${process.pid}.${Date.now()}`;
    mkdirSync(staging, { recursive: true });
    try {
      const installed = await this.run(
        "npm",
        ["install", "--prefix", staging, `pnpm@${version}`, "--no-save", "--no-audit", "--no-fund"],
        { cwd: staging, env: withoutGitHubTokens(), timeout: PIN_TIMEOUT },
      );
      if (!installed || !existsSync(join(staging, "node_modules", ".bin", "pnpm")))
        return undefined;
      // Another run may have finished first; either copy is the same version.
      if (!existsSync(home)) renameSync(staging, home);
      return existsSync(join(bin, "pnpm")) ? bin : undefined;
    } catch {
      return existsSync(join(bin, "pnpm")) ? bin : undefined;
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  // Lockfile-exact dependencies for a worktree that has none yet.
  async #install(cwd: string, paths: string[]): Promise<void> {
    if (existsSync(join(cwd, "node_modules"))) return;
    const env = withoutGitHubTokens({
      ...process.env,
      PATH: [...paths, process.env.PATH ?? ""].join(delimiter),
    });
    if (existsSync(join(cwd, "pnpm-lock.yaml")))
      await this.run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], {
        cwd,
        env,
        timeout: INSTALL_TIMEOUT,
      });
    else if (existsSync(join(cwd, "package-lock.json")))
      await this.run("npm", ["ci"], { cwd, env, timeout: INSTALL_TIMEOUT });
  }
}
