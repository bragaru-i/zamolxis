import { execFileSync } from "node:child_process";
import {
  type GitHubAccess,
  type GitHubClient,
  type GitHubRepository,
  githubRepositoryFromRemote,
  githubSlug,
  githubTokenUrl,
  isGitHubToken,
  type RepositoryTokenStore,
} from "@zamolxis/node-core";

/** One repository on this Mac whose origin is on GitHub. */
export interface GitHubEntry {
  readonly name: string;
  readonly path: string;
  readonly repositoryId?: string;
  readonly github: GitHubRepository;
}
export interface TokenIo {
  log(message: string): void;
  confirm(message: string, defaultValue: boolean): Promise<boolean>;
  select<T extends string>(
    message: string,
    choices: Array<{ name: string; value: T }>,
    defaultValue?: T,
  ): Promise<T>;
  /** Reads a secret without echoing it. */
  password(message: string): Promise<string>;
}
export interface GitHubTokenEnvironment {
  readonly io: TokenIo;
  readonly tokens: RepositoryTokenStore;
  readonly github: Pick<GitHubClient, "checkAccess">;
  /** Opens a URL in the browser (best effort). */
  openUrl(url: string): void;
  /** False when nothing may be asked (setup --repair, no terminal). */
  readonly interactive: boolean;
  /** Tells Zamolxis the new status (best effort; the Node also re-checks on its own). */
  report?(entry: GitHubEntry, access: GitHubAccess): Promise<void>;
  now?(): number;
}

export const GITHUB_TOKEN_COMMAND = "pnpm zamolxis github-token";

export function githubEntries(
  repositories: ReadonlyArray<{
    name: string;
    path: string;
    remoteUrl: string;
    repositoryId?: string;
  }>,
): GitHubEntry[] {
  return repositories.flatMap(({ name, path, remoteUrl, repositoryId }) => {
    const github = githubRepositoryFromRemote(remoteUrl);
    return github ? [{ name, path, ...(repositoryId ? { repositoryId } : {}), github }] : [];
  });
}

const DAY = 24 * 60 * 60 * 1000;
function expiry(access: GitHubAccess, now: number) {
  if (access.expiresAt === undefined) return "token has no expiry date";
  const days = Math.max(0, Math.floor((access.expiresAt - now) / DAY));
  return days === 0
    ? "token expires today"
    : `token expires in ${days} day${days === 1 ? "" : "s"}`;
}
/** The access status in plain language. */
export function describeAccess(access: GitHubAccess, now = Date.now()): string {
  const as = access.login ? `publishing as ${access.login}` : "connected";
  switch (access.status) {
    case "ok":
      return `${as} · ${expiry(access, now)}`;
    case "expiring":
      return `${as} · ${expiry(access, now)}, replace it soon`;
    case "expired":
      return "the token has expired; add a new one";
    case "invalid":
      return "GitHub doesn't accept the token (revoked, expired or mistyped); add a new one";
    case "no_push":
      return `the token${access.login ? ` (${access.login})` : ""} can't push to this repository; it must include this repository with Contents and Pull requests set to Read and write`;
    case "missing":
      return "not connected: no token for this repository yet";
    case "unreachable":
      return "couldn't reach GitHub to check the token";
  }
}

/** The status of one repository's token, without changing anything. */
export async function checkEntry(
  entry: GitHubEntry,
  env: Pick<GitHubTokenEnvironment, "tokens" | "github" | "now">,
): Promise<GitHubAccess> {
  const token = env.tokens.read(entry.github);
  if (!token) return { status: "missing", checkedAt: (env.now ?? Date.now)() };
  return env.github.checkAccess(entry.github, token);
}

export function tokenSteps(entry: GitHubEntry): string[] {
  const slug = githubSlug(entry.github);
  return [
    `Connect ${slug} to GitHub for publishing. Zamolxis uses this token only on this Mac,`,
    "only to push trusted work to a zamolxis/… branch and open its pull request. It stays in",
    "this Mac's login Keychain; it is never sent to the Zamolxis app and agents never get it.",
    "",
    "1. GitHub opens a prefilled page for a fine-grained personal access token",
    `   (sign in as the account that should publish to ${slug}).`,
    `2. Resource owner: ${entry.github.owner}. Repository access: "Only select repositories" → ${slug}.`,
    "3. Permissions are prefilled: Contents and Pull requests, Read and write. Leave the rest.",
    "4. Choose Generate token, copy it and paste it here.",
  ];
}

async function report(entry: GitHubEntry, access: GitHubAccess, env: GitHubTokenEnvironment) {
  if (!env.report || !entry.repositoryId) return;
  try {
    await env.report(entry, access);
  } catch {
    env.io.log("  (Zamolxis will show the new status after this Mac's next check.)");
  }
}

/** Guides the owner through creating a token and stores it once GitHub accepts it. */
export async function addToken(
  entry: GitHubEntry,
  env: GitHubTokenEnvironment,
): Promise<GitHubAccess | undefined> {
  const { io } = env;
  const url = githubTokenUrl(entry.github);
  for (const line of tokenSteps(entry)) io.log(line);
  io.log("");
  io.log(url);
  try {
    env.openUrl(url);
  } catch {
    io.log("(Open the link above in your browser.)");
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = (
      await io.password("Paste the token (it is not shown; leave empty to cancel)")
    ).trim();
    if (!token) {
      io.log("No token saved.");
      return undefined;
    }
    if (!isGitHubToken(token)) {
      io.log("That doesn't look like a GitHub token; fine-grained tokens start with github_pat_.");
      continue;
    }
    const access = await env.github.checkAccess(entry.github, token);
    if (access.status === "ok" || access.status === "expiring") {
      env.tokens.write(entry.github, token);
      io.log(`✓ ${githubSlug(entry.github)}: ${describeAccess(access, env.now?.())}`);
      await report(entry, access, env);
      return access;
    }
    if (access.status === "unreachable") {
      if (
        await io.confirm("GitHub couldn't be reached to check the token. Save it anyway?", false)
      ) {
        env.tokens.write(entry.github, token);
        io.log("✓ Saved. Zamolxis checks it with GitHub once it can reach it.");
        return access;
      }
      return undefined;
    }
    io.log(`That token can't publish: ${describeAccess(access, env.now?.())}.`);
    if (!(await io.confirm("Try another token?", true))) return undefined;
  }
  io.log("No token saved.");
  return undefined;
}

export async function removeToken(entry: GitHubEntry, env: GitHubTokenEnvironment) {
  env.tokens.remove(entry.github);
  env.io.log(
    `✓ Removed the GitHub token for ${githubSlug(entry.github)} from this Mac. Revoke it on GitHub too: https://github.com/settings/personal-access-tokens`,
  );
  await report(entry, { status: "missing", checkedAt: (env.now ?? Date.now)() }, env);
}

function match(entries: GitHubEntry[], wanted: string) {
  const key = wanted.trim().toLowerCase();
  return entries.filter(
    (entry) =>
      githubSlug(entry.github).toLowerCase() === key ||
      entry.name.toLowerCase() === key ||
      entry.github.repo.toLowerCase() === key ||
      entry.path.toLowerCase() === key,
  );
}

/**
 * `pnpm zamolxis github-token [repository] [--remove]` and the GitHub step of setup:
 * shows each GitHub repository's publishing access and, when a terminal is attached,
 * offers to add or replace its token. Without a terminal it only reports and never asks.
 */
export async function manageGitHubTokens(
  repositories: ReadonlyArray<{
    name: string;
    path: string;
    remoteUrl: string;
    repositoryId?: string;
  }>,
  env: GitHubTokenEnvironment,
  options: { repository?: string; remove?: boolean; offer?: "always" | "when-needed" } = {},
): Promise<void> {
  const { io } = env;
  const entries = githubEntries(repositories);
  if (!entries.length) {
    io.log("No repository on this Mac has a GitHub origin remote; nothing to connect.");
    return;
  }
  let targets = entries;
  if (options.repository !== undefined) {
    targets = match(entries, options.repository);
    if (targets.length !== 1)
      throw new Error(
        `No single repository "${options.repository}" on this Mac. Choose one of: ${entries
          .map((entry) => githubSlug(entry.github))
          .join(", ")}`,
      );
  }
  if (options.remove) {
    if (targets.length > 1) {
      if (!env.interactive)
        throw new Error(`Name the repository: ${GITHUB_TOKEN_COMMAND} <owner/repo> --remove`);
      const slug = await io.select(
        "Remove the GitHub token of which repository?",
        targets.map((entry) => ({
          name: githubSlug(entry.github),
          value: githubSlug(entry.github),
        })),
      );
      targets = match(targets, slug);
    }
    for (const entry of targets) await removeToken(entry, env);
    return;
  }
  const statuses = new Map<GitHubEntry, GitHubAccess>();
  for (const entry of targets) {
    let access: GitHubAccess;
    try {
      access = await checkEntry(entry, env);
    } catch {
      io.log(
        `GitHub ${githubSlug(entry.github)}: the login Keychain is locked or unavailable; unlock it and try again`,
      );
      continue;
    }
    statuses.set(entry, access);
    io.log(`GitHub ${githubSlug(entry.github)}: ${describeAccess(access, env.now?.())}`);
    if (access.status !== "unreachable") await report(entry, access, env);
  }
  const needing = [...statuses].filter(
    ([, access]) => !["ok", "unreachable"].includes(access.status),
  );
  if (!env.interactive) {
    if (needing.length)
      io.log(`To add or replace a token, run ${GITHUB_TOKEN_COMMAND} in Terminal on this Mac.`);
    return;
  }
  if (options.offer === "when-needed" && !needing.length) return;
  const offered =
    options.offer === "when-needed" ? needing.map(([entry]) => entry) : [...statuses.keys()];
  if (offered.length === 1) {
    const [entry] = offered;
    if (!entry) return;
    const working = ["ok", "expiring"].includes(statuses.get(entry)?.status ?? "");
    const question = working
      ? `Replace the GitHub token for ${githubSlug(entry.github)}?`
      : `Add a GitHub token for ${githubSlug(entry.github)} now? (needed to open pull requests)`;
    if (await io.confirm(question, !working)) await addToken(entry, env);
    return;
  }
  for (;;) {
    const choice = await io.select(
      "Add or replace a GitHub token?",
      [
        ...offered.map((entry) => ({
          name: `${githubSlug(entry.github)} (${statuses.get(entry)?.status === "ok" ? "connected" : "needs a token"})`,
          value: githubSlug(entry.github),
        })),
        { name: "Done", value: "\0done" },
      ],
      "\0done",
    );
    const entry = offered.find((item) => githubSlug(item.github) === choice);
    if (!entry) return;
    const access = await addToken(entry, env);
    if (access) statuses.set(entry, access);
  }
}

/** Opens a URL with macOS `open`; the URL is a prefilled GitHub page, never a secret. */
export function openInBrowser(url: string) {
  if (process.platform !== "darwin" || !url.startsWith("https://github.com/")) return;
  execFileSync("open", [url], { stdio: "ignore", timeout: 10_000 });
}
