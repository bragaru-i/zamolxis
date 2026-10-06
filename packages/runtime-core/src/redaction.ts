// Secret redaction for text that leaves a runtime adapter (activity summaries, command
// lines, approval and completion text). Conservative: a false positive hides a harmless
// value, a false negative uploads a credential.

export const REDACTED = "***";
/** Default bound for one activity summary. */
export const SUMMARY_LIMIT = 500;

// Name fragments that mark a secret anywhere inside a name (PGPASSWORD, ghToken).
const SECRET_FRAGMENT =
  /(token|secret|passw|passphrase|credential|cookie|api[-_]?key|private[-_]?key|access[-_]?key)/i;
// Short words that mark a secret only as a whole name segment (--key, AUTH, session_id),
// so --author, keyboard or monkey stay visible.
const SECRET_SEGMENT = new Set(["key", "auth", "session", "pwd", "pass", "sid", "jwt", "otp"]);

/** True when an assignment, flag or field name looks like it holds a secret. */
export function secretName(name: string): boolean {
  const bare = name.replace(/^-+/, "");
  if (SECRET_FRAGMENT.test(bare)) return true;
  return bare
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .some((segment) => SECRET_SEGMENT.has(segment.toLowerCase()));
}

// A shell-ish value: quoted, or a run of non-space characters.
const VALUE = String.raw`("[^"]*"|'[^']*'|[^\s"'\`;&|)]+)`;
const NAME = "[A-Za-z_][A-Za-z0-9_.-]*";

const PRIVATE_KEY =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g;
// Authorization/Cookie style headers: everything up to the end of the quoted header.
const HEADER =
  /\b(proxy-authorization|authorization|set-cookie|cookie|x-[a-z0-9-]*(?:token|key|secret|auth)[a-z0-9-]*)(\s*:\s*)([^"'\n]+)/gi;
const BEARER = /\b(bearer|basic|token)(\s+)([A-Za-z0-9._~+/=-]{8,})/gi;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:'"]+)(:[^\s/@'"]*)?@/gi;
// NAME=value (env assignments, --flag=value, key=value query parameters).
const ASSIGNMENT = new RegExp(String.raw`(^|[\s"'?&;(,{])(-{0,2}${NAME})(=)${VALUE}`, "g");
// --flag value / -flag value (long or single-dash names only, never bundled short flags).
const FLAG = new RegExp(String.raw`(^|\s)(--?[A-Za-z][A-Za-z0-9_.-]+)(\s+)(?!-)${VALUE}`, "g");
// curl -u user:password
const USER_FLAG = /(^|\s)(-u|--user)(\s+|=)("[^"]*:[^"]*"|'[^']*:[^']*'|\S+:\S+)/g;
// "name": "value" / name: value (JSON, YAML).
const FIELD = new RegExp(String.raw`(["']?)(${NAME})\1(\s*:\s*)("[^"]*"|'[^']*'|[^\s,}"']+)`, "g");
// Well-known token shapes, regardless of context.
const KNOWN_TOKEN =
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g;
// Long base64/hex-looking runs; checked for entropy below so paths and words survive.
const LONG_RUN = /[A-Za-z0-9+/_=-]{32,}/g;

function highEntropy(run: string): boolean {
  const bare = run.replace(/=+$/, "");
  if (/^[0-9a-f]{32,}$/i.test(bare)) return true;
  // A path or kebab/snake identifier: judge its longest part instead of the whole run.
  const longest = bare
    .split(/[/_-]/)
    .reduce((best, part) => (part.length > best.length ? part : best), "");
  if (longest.length < 20) return false;
  const digits = (longest.match(/[0-9]/g) ?? []).length;
  const upper = (longest.match(/[A-Z]/g) ?? []).length;
  const lower = (longest.match(/[a-z]/g) ?? []).length;
  const kinds = [digits, upper, lower].filter((count) => count >= 2).length;
  if (kinds < 3 && !(kinds === 2 && digits >= 4)) return false;
  return new Set(longest).size >= Math.min(16, longest.length / 2);
}

function quoted(value: string): string {
  const quote = value[0];
  return quote === '"' || quote === "'" ? `${quote}${REDACTED}${quote}` : REDACTED;
}

export interface RedactOptions {
  /**
   * Keeps a long run that would otherwise be hidden, e.g. a commit SHA proven to exist in
   * the run's repository. Never consulted for the named secret shapes above.
   */
  readonly keep?: (run: string) => boolean;
}

/** Replaces secret values in free text (command lines, summaries) with `***`. */
export function redactSecrets(text: string, options: RedactOptions = {}): string {
  return text
    .replace(PRIVATE_KEY, REDACTED)
    .replace(HEADER, (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`)
    .replace(BEARER, (_match, scheme: string, space: string) => `${scheme}${space}${REDACTED}`)
    .replace(URL_CREDENTIALS, (_match, scheme: string) => `${scheme}${REDACTED}@`)
    .replace(
      USER_FLAG,
      (_match, lead: string, flag: string, separator: string, value: string) =>
        `${lead}${flag}${separator}${quoted(value)}`,
    )
    .replace(ASSIGNMENT, (match, lead: string, name: string, equals: string, value: string) =>
      secretName(name) ? `${lead}${name}${equals}${quoted(value)}` : match,
    )
    .replace(FLAG, (match, lead: string, flag: string, space: string, value: string) =>
      secretName(flag) && value !== REDACTED ? `${lead}${flag}${space}${quoted(value)}` : match,
    )
    .replace(FIELD, (match, quote: string, name: string, separator: string, value: string) =>
      secretName(name) &&
      value !== REDACTED &&
      !value.startsWith(`"${REDACTED}`) &&
      !value.startsWith(`'${REDACTED}`)
        ? `${quote}${name}${quote}${separator}${quoted(value)}`
        : match,
    )
    .replace(KNOWN_TOKEN, REDACTED)
    .replace(LONG_RUN, (run) => (highEntropy(run) && !options.keep?.(run) ? REDACTED : run));
}

/** Trims and bounds text to `limit` characters, marking a cut with an ellipsis. */
export function boundText(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, Math.max(0, limit - 1))}…` : trimmed;
}

/** One-line, redacted, bounded summary suitable for a normalized event. */
export function safeSummary(text: string, limit = SUMMARY_LIMIT): string {
  return boundText(redactSecrets(text).replace(/\s+/g, " "), limit);
}
