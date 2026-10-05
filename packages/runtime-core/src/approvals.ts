import { APPROVAL_ID_LIMIT, APPROVAL_SUMMARY_LIMIT, type ApprovalRisk } from "@zamolxis/contracts";

/** Stable approval identity: the run plus the runtime's own request id. */
export function approvalIdFor(runId: string, requestId: string | number): string {
  const id = `${runId}:${String(requestId)}`;
  if (id.length > APPROVAL_ID_LIMIT) throw new Error("APPROVAL_ID_TOO_LONG");
  return id;
}

/** Human readable text bounded to APPROVAL_SUMMARY_LIMIT characters. */
export function approvalSummary(parts: readonly (string | undefined | null)[]): string {
  const text = parts
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim())
    .join("\n");
  if (!text) return "The agent requested an operation without details";
  return text.length > APPROVAL_SUMMARY_LIMIT
    ? `${text.slice(0, APPROVAL_SUMMARY_LIMIT - 1)}…`
    : text;
}

const ORDER: readonly ApprovalRisk[] = ["low", "medium", "high", "critical"];
export function maxRisk(...risks: readonly ApprovalRisk[]): ApprovalRisk {
  return risks.reduce<ApprovalRisk>(
    (worst, risk) => (ORDER.indexOf(risk) > ORDER.indexOf(worst) ? risk : worst),
    "low",
  );
}

// Credentials, secrets and privilege escalation: never below critical.
const CREDENTIAL =
  /(\bsudo\b|\bdoas\b|\bsu\s|\bsecurity\s+(find|add|delete|dump|unlock)|keychain|\bssh-add\b|\bgpg\b|\.ssh\b|\.aws\b|\.netrc|\.npmrc|\.pypirc|\.docker\/config|auth\.json|\.env\b|credential|passw|secret|token|\bgh\s+auth\b|\bop\s+(read|signin)|\bvault\b|id_rsa|id_ed25519|private[-_ ]?key)/i;
// Anything reaching the network, publishing or installing.
const NETWORK =
  /(\bcurl\b|\bwget\b|\bssh\b|\bscp\b|\bsftp\b|\brsync\b|\bnc\b|\bnetcat\b|\btelnet\b|\bftp\b|\bgit\s+(push|pull|fetch|clone|remote|submodule|ls-remote)|\b(npm|pnpm|yarn|bun)\s+(i|install|add|publish|dlx|update|upgrade|create)\b|\bnpx\b|\bbunx\b|\bpip3?\s+install\b|\buv\s+(pip|add|sync|tool)\b|\bbrew\b|\bapt(-get)?\b|\bgem\s+install\b|\bcargo\s+(install|publish|add)\b|\bgo\s+(get|install)\b|\bdocker\b|\bhttps?:\/\/|\bgh\b|\bvercel\b|\bconvex\s+(deploy|run|env)\b)/i;
// Deletion, overwriting outside the tree or history rewriting.
const DESTRUCTIVE =
  /(\brm\b|\brmdir\b|\bunlink\b|\bshred\b|\btruncate\b|\s-delete\b|\bgit\s+(clean|reset|checkout\s+--|restore|rebase|branch\s+-[dD]|stash\s+(drop|clear)|push\s+(-f|--force)|update-ref|filter-branch)|\bmv\b|\bdd\b|\bchmod\b|\bchown\b|\bkill(all)?\b|\blaunchctl\b|\bcrontab\b)/i;
// Absolute paths, home paths or parent traversal are outside the workspace until proven otherwise.
const OUTSIDE = /(^|[\s'"=:])(\/(?!dev\/null\b)|~|\.\.(\/|$))/;
// Commands that only read the workspace (no pipes, redirects or substitutions).
const READ_ONLY =
  /^\s*(ls|cat|head|tail|wc|grep|rg|pwd|echo|nl|stat|file|tree|git\s+(status|diff|log|show|rev-parse))\b[^|;&><`$\n]*$/;

export interface CommandRiskInput {
  readonly command: string;
  readonly cwd?: string;
  readonly workspace: string;
  // The runtime reports that the operation needs network access.
  readonly network?: boolean;
}
/**
 * Conservative risk classification for display. It never authorizes anything: every
 * classified operation still requires an explicit human decision.
 */
export function classifyCommandRisk(input: CommandRiskInput): ApprovalRisk {
  const command = input.command;
  if (CREDENTIAL.test(command)) return "critical";
  if (input.cwd && !insideWorkspace(input.cwd, input.workspace)) return "critical";
  const risks: ApprovalRisk[] = ["medium"];
  if (input.network || NETWORK.test(command)) risks.push("high");
  if (DESTRUCTIVE.test(command)) risks.push("high");
  if (OUTSIDE.test(command.split(input.workspace).join("."))) risks.push("high");
  const worst = maxRisk(...risks);
  return worst === "medium" && READ_ONLY.test(command) ? "low" : worst;
}

/** True when an absolute path is the workspace or lies inside it. */
export function insideWorkspace(path: string, workspace: string): boolean {
  const root = workspace.endsWith("/") ? workspace.slice(0, -1) : workspace;
  if (path === root) return true;
  if (!path.startsWith(`${root}/`)) return false;
  return !path
    .slice(root.length + 1)
    .split("/")
    .includes("..");
}
