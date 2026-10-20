// Which production backend the owner's tools talk to, as a temporary env file for the
// Convex CLI. Production runs on the self-hosted server on the owner's Mac when its
// admin file exists (~/zamolxis-server/admin.env, or ZAMOLXIS_SERVER_DIR); otherwise the
// cloud deployment's deploy key from the private prod setup directory. Values are never
// printed: callers pass every output through `hide`.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const serverDirectory =
  process.env.ZAMOLXIS_SERVER_DIR ?? join(homedir(), "zamolxis-server");

/** KEY=value lines; quotes around a value are removed. */
function readEnvFile(path) {
  const values = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) values[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

export function productionEnv() {
  const adminFile = join(serverDirectory, "admin.env");
  let target;
  let lines;
  let secrets;
  if (existsSync(adminFile)) {
    const values = readEnvFile(adminFile);
    const url = values.CONVEX_SELF_HOSTED_URL;
    const key = values.CONVEX_SELF_HOSTED_ADMIN_KEY;
    if (!url || !key)
      throw new Error(`${adminFile} lacks CONVEX_SELF_HOSTED_URL or CONVEX_SELF_HOSTED_ADMIN_KEY`);
    target = "self-hosted";
    lines = [`CONVEX_SELF_HOSTED_URL=${url}`, `CONVEX_SELF_HOSTED_ADMIN_KEY=${key}`];
    secrets = [key];
  } else {
    const directory =
      process.env.ZAMOLXIS_PROD_SETUP_DIR ??
      join(homedir(), "Library", "Application Support", "Zamolxis", "prod-setup");
    const key = JSON.parse(readFileSync(join(directory, "credentials.json"), "utf8")).deployKey;
    if (typeof key !== "string" || !key.startsWith("prod:"))
      throw new Error("No production deploy key in the private prod setup directory");
    target = "cloud";
    lines = [`CONVEX_DEPLOY_KEY=${key}`];
    secrets = [key];
  }
  const temporary = mkdtempSync(join(tmpdir(), "zamolxis-prod-"));
  const envFile = join(temporary, "deployment.env");
  writeFileSync(envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
  // The Convex CLI would otherwise prefer CONVEX_* variables from the caller's shell.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("CONVEX_")),
  );
  return {
    target,
    envFile,
    env,
    hide: (text) =>
      secrets.reduce((result, secret) => result.replaceAll(secret, "<key>"), String(text)),
    clean: () => rmSync(temporary, { recursive: true, force: true }),
  };
}
