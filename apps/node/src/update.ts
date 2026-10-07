import { execFileSync } from "node:child_process";
import { checkAndRepair, defaultEnvironment, readConfig, type SetupEnvironment } from "./setup";

const DEPLOY_WAIT_MS = 20 * 60_000;
const DEPLOY_POLL_MS = 15_000;

export interface UpdateSteps {
  log(message: string): void;
  /** Runs a command in the checkout and returns its trimmed output; throws on failure. */
  run(command: string, args: string[]): string;
  /** The commit the deployed app reports, or undefined while it cannot be read. */
  liveCommit(appUrl: string): Promise<string | undefined>;
  pause(ms: number): Promise<unknown>;
  now(): number;
  /** Restarts the Node service and waits for a heartbeat from the new process. */
  restart(): Promise<void>;
}

/**
 * Updates this computer's Node in the safe order: fast-forward the checkout to
 * origin/main, install dependencies from the lockfile, wait until the deployed backend
 * runs that commit (a Node newer than the backend fails its first heartbeat), then
 * restart the service (launchd on macOS, systemd on Linux) and confirm a heartbeat from
 * the new process. Local edits or a diverged checkout stop it before anything changes.
 */
export async function runUpdate(appUrl: string, steps: UpdateSteps): Promise<void> {
  const { log, run } = steps;
  if (run("git", ["status", "--porcelain", "--untracked-files=no"]))
    throw new Error(
      "This checkout has local changes; commit or discard them, then run update again",
    );
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== "main")
    throw new Error(
      `This checkout is on "${branch}", not main; switch to main, then run update again`,
    );
  log("Fetching the latest code…");
  run("git", ["fetch", "--quiet", "origin", "main"]);
  const before = run("git", ["rev-parse", "HEAD"]);
  try {
    run("git", ["merge", "--ff-only", "--quiet", "origin/main"]);
  } catch {
    throw new Error("This checkout has commits that are not on origin/main; update stopped");
  }
  const head = run("git", ["rev-parse", "HEAD"]);
  log(
    before === head
      ? `✓ Already on the latest code (${head.slice(0, 7)})`
      : `✓ Updated to ${head.slice(0, 7)}`,
  );
  log("Installing dependencies…");
  run("pnpm", ["install", "--frozen-lockfile"]);
  log("✓ Dependencies installed");

  log(
    `Waiting until ${appUrl} runs ${head.slice(0, 7)} (the backend deploys before the Node restarts)…`,
  );
  const deadline = steps.now() + DEPLOY_WAIT_MS;
  for (;;) {
    const live = await steps.liveCommit(appUrl);
    if (live && (live === head || contains(run, live, head))) break;
    if (steps.now() >= deadline)
      throw new Error(
        `The deployed app still runs ${live?.slice(0, 7) ?? "an unknown version"} after 20 minutes; check the deploy on GitHub Actions, then run update again`,
      );
    await steps.pause(DEPLOY_POLL_MS);
  }
  log("✓ The deployed app runs this code");
  log("Restarting the Node service…");
  await steps.restart();
}
// Whether the deployed commit already contains `head` (a later merge was deployed).
function contains(run: UpdateSteps["run"], live: string, head: string): boolean {
  if (!/^[0-9a-f]{40}$/.test(live)) return false;
  try {
    run("git", ["merge-base", "--is-ancestor", head, live]);
    return true;
  } catch {
    return false;
  }
}

export async function update(): Promise<void> {
  const env: SetupEnvironment = defaultEnvironment();
  const config = readConfig(env.configPath);
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  await runUpdate(config.appUrl, {
    log: (message) => env.io.log(message),
    run: (command, args) =>
      execFileSync(command, args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    liveCommit: async (appUrl) => {
      try {
        const response = await fetch(`${appUrl}/api/bootstrap`, {
          signal: AbortSignal.timeout(10_000),
          redirect: "error",
        });
        const body = (await response.json()) as { commit?: unknown };
        return typeof body.commit === "string" ? body.commit : undefined;
      } catch {
        return undefined;
      }
    },
    pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    restart: () => checkAndRepair(config, env, { interactive: false, restart: true }),
  });
}
