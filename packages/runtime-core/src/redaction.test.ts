import { describe, expect, it } from "vitest";
import { boundText, redactSecrets, SUMMARY_LIMIT, safeSummary, secretName } from "./redaction";

const SECRET = "s3cr3t-Value-9f8e7d";

describe("redactSecrets", () => {
  it.each([
    ["GITHUB_TOKEN=ghx_abc123 pnpm publish", "GITHUB_TOKEN=*** pnpm publish"],
    ["export API_KEY='abc def'", "export API_KEY='***'"],
    ['PGPASSWORD="hunter2" psql -h db', 'PGPASSWORD="***" psql -h db'],
    ["env AWS_SECRET_ACCESS_KEY=xyz aws s3 ls", "env AWS_SECRET_ACCESS_KEY=*** aws s3 ls"],
    ["SESSION_ID=42 node app.js", "SESSION_ID=*** node app.js"],
    ["cli --token abcdef", "cli --token ***"],
    ["cli --token=abcdef --verbose", "cli --token=*** --verbose"],
    ["cli --api-key 'k e y'", "cli --api-key '***'"],
    ["login --password hunter2", "login --password ***"],
    ["tool --client-secret=xyz", "tool --client-secret=***"],
    ["db --auth abc", "db --auth ***"],
    ["curl --cookie sid=1 https://x", "curl --cookie *** https://x"],
    ["curl -u admin:hunter2 https://x", "curl -u *** https://x"],
    [
      'curl -H "Authorization: Bearer abc.def.ghi" https://api.example.com',
      'curl -H "Authorization: ***" https://api.example.com',
    ],
    ["curl -H 'Cookie: a=1; b=2' https://x", "curl -H 'Cookie: ***' https://x"],
    ["curl -H 'X-Api-Key: abc' https://x", "curl -H 'X-Api-Key: ***' https://x"],
    ["send Bearer abcdefghijkl", "send Bearer ***"],
    ["git clone https://user:pa55@github.com/o/r.git", "git clone https://***@github.com/o/r.git"],
    ["psql postgres://app:pw@localhost/db", "psql postgres://***@localhost/db"],
    [
      "open https://x.test/cb?code=1&access_token=abc",
      "open https://x.test/cb?code=1&access_token=***",
    ],
    ['echo \'{"token": "abc", "name": "x"}\'', 'echo \'{"token": "***", "name": "x"}\''],
    ["password: hunter2", "password: ***"],
    ["use ghp_abcdefghijklmnopqrstuvwxyz0123", "use ***"],
    ["key sk-proj-abcdefghijklmnopqrstuv", "key ***"],
    ["id AKIAABCDEFGHIJKLMNOP", "id ***"],
    ["slack xoxb-1234567890-abcdef", "slack ***"],
    ["hash 0123456789abcdef0123456789abcdef", "hash ***"],
    ["blob aGVsbG8gd29ybGQgdGhpcyBpcyBhIHNlY3JldCB2YWx1ZQ9Z==", "blob ***"],
  ])("redacts %s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it("redacts private key blocks and JWTs", () => {
    const key =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB\n-----END OPENSSH PRIVATE KEY-----";
    expect(redactSecrets(`cat <<EOF\n${key}\nEOF`)).toBe("cat <<EOF\n***\nEOF");
    expect(
      redactSecrets("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N"),
    ).toBe("jwt ***");
  });

  it.each([
    "pnpm test",
    "git status",
    "rg foo src",
    "pnpm vitest run packages/runtime-codex/src/codex-runtime.test.ts",
    "git log --author=alice --oneline -5",
    "git diff HEAD~1 -- apps/web/app/features/run-detail-model.ts",
    "sed -n 1,200p docs/runtime-adapter-contract.md",
    "rg -n 'keyboard|monkey' src",
    "ls -la node_modules/@zamolxis/runtime-core-redaction-helpers",
    "pnpm --filter @zamolxis/web test -- --run",
    "node -e \"console.log('hello world')\"",
    "git commit -m 'feat: show what agents actually did'",
    "curl https://example.com/api/v1/items?page=2",
    "grep -rn sessionStorage apps/web/app",
  ])("leaves ordinary commands unchanged: %s", (command) => {
    expect(redactSecrets(command)).toBe(command);
  });

  it("never leaves the secret value anywhere in mixed text", () => {
    const text = [
      `TOKEN=${SECRET}`,
      `--password ${SECRET}`,
      `Authorization: Bearer ${SECRET}`,
      `https://me:${SECRET}@host/x`,
      `"secret": "${SECRET}"`,
    ].join(" && ");
    expect(redactSecrets(text)).not.toContain(SECRET);
  });
});

describe("secretName", () => {
  it("matches secret-looking names but not similar words", () => {
    for (const name of ["GITHUB_TOKEN", "--api-key", "apiKey", "PGPASSWORD", "--auth", "session"])
      expect(secretName(name)).toBe(true);
    for (const name of ["--author", "keyboard", "monkey", "--sessions-dir", "PATH", "--filter"])
      expect(secretName(name)).toBe(false);
  });
});

describe("bounds", () => {
  it("bounds and flattens summaries", () => {
    expect(boundText("  abc  ", 10)).toBe("abc");
    expect(boundText("abcdef", 4)).toBe("abc…");
    const long = safeSummary(`echo ${"word ".repeat(400)}`);
    expect(long.length).toBe(SUMMARY_LIMIT);
    expect(long.endsWith("…")).toBe(true);
    expect(safeSummary("a\n\n  b\tc")).toBe("a b c");
    expect(safeSummary(`TOKEN=${SECRET}\necho`)).toBe("TOKEN=*** echo");
  });
});
