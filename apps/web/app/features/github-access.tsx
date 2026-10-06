import { Notice, safeHref, type Tone } from "@zamolxis/ui";
import { relativeTime } from "./time";

/** A repository's GitHub publishing access as its Mac last reported it (never a token). */
export interface GithubAccess {
  status: "ok" | "expiring" | "expired" | "invalid" | "no_push" | "missing" | "unreachable";
  login?: string;
  expiresAt?: number;
  checkedAt: number;
}
export interface GithubRepository {
  slug: string;
  tokenUrl: string;
}

export const GITHUB_TOKEN_COMMAND = "pnpm zamolxis github-token";
const DAY = 24 * 60 * 60 * 1000;

function expiry(access: GithubAccess, now: number) {
  if (access.expiresAt === undefined) return "token doesn't expire";
  const days = Math.floor((access.expiresAt - now) / DAY);
  if (days < 0) return "token has expired";
  if (days === 0) return "token expires today";
  return `token expires in ${days} day${days === 1 ? "" : "s"}`;
}

/** What publishing to GitHub looks like for one repository on one Mac, in plain words. */
export function describeGithubAccess(
  access: GithubAccess | undefined,
  now: number,
): { tone: Tone; text: string; needsToken: boolean } {
  const fix = `On your Mac, run ${GITHUB_TOKEN_COMMAND}.`;
  if (!access || access.status === "missing")
    return {
      tone: "warning",
      text: `GitHub not connected, so pull requests can't be opened yet. ${fix}`,
      needsToken: true,
    };
  const as = access.login ? `publishing as ${access.login}` : "connected";
  switch (access.status) {
    case "ok":
      return { tone: "success", text: `GitHub: ${as} · ${expiry(access, now)}`, needsToken: false };
    case "expiring":
      return {
        tone: "warning",
        text: `GitHub: ${as} · ${expiry(access, now)}. Replace it soon: ${fix}`,
        needsToken: true,
      };
    case "expired":
    case "invalid":
      return {
        tone: "danger",
        text: `GitHub no longer accepts this repository's token (expired or revoked). ${fix}`,
        needsToken: true,
      };
    case "no_push":
      return {
        tone: "danger",
        text: `The GitHub token${access.login ? ` (${access.login})` : ""} can't push to this repository. Create one that includes it with Contents and Pull requests set to Read and write. ${fix}`,
        needsToken: true,
      };
    case "unreachable":
      return {
        tone: "neutral",
        text: "Your Mac couldn't reach GitHub at its last check; it will try again.",
        needsToken: false,
      };
  }
}

/** The GitHub row of a repository in Settings → Macs → Repositories. */
export function GithubAccessRow({
  github,
  access,
  now,
}: {
  github: GithubRepository;
  access?: GithubAccess;
  now: number;
}) {
  const { tone, text, needsToken } = describeGithubAccess(access, now);
  const link = safeHref(github.tokenUrl);
  return (
    <div className="z-stack" aria-label={`GitHub access for ${github.slug}`}>
      <Notice tone={tone}>{text}</Notice>
      {access && (
        <span className="z-xsmall z-muted">Checked {relativeTime(access.checkedAt, now)}</span>
      )}
      {needsToken && link && (
        <>
          <a
            className="z-button z-button--secondary z-button--small"
            href={link}
            target="_blank"
            rel="noopener noreferrer"
          >
            Create a token on GitHub
          </a>
          <span className="z-xsmall z-muted">
            GitHub opens with the right permissions filled in. Under Repository access choose
            &quot;Only select repositories&quot; and pick {github.slug}. Then paste the token on
            your Mac when <code>{GITHUB_TOKEN_COMMAND}</code> asks for it; never paste it in this
            app. It stays on your Mac and is only used to open pull requests.
          </span>
        </>
      )}
    </div>
  );
}
