import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import {
  validateConfig,
  validateCredentials,
  convexInvocation,
  serializeAuthVariables,
} from "./lib/google-auth-setup.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage = `Google auth setup (run separately for dev and prod):
  node scripts/google-auth-setup.mjs prepare --environment dev --deployment NAME --convex-url https://NAME.REGION.convex.cloud --app-url https://YOUR-DEV-APP --directory /absolute/private/dev-directory
  node scripts/google-auth-setup.mjs inspect --environment dev --directory /absolute/private/dev-directory
  node scripts/google-auth-setup.mjs apply --environment dev --directory /absolute/private/dev-directory
  node scripts/google-auth-setup.mjs deploy --environment dev --directory /absolute/private/dev-directory
Replace dev with prod for production. prepare/inspect are offline; apply writes auth variables; deploy uploads backend code.
Fill credentials.json privately before apply/deploy. No global login or other project settings are changed.`;

function privateFile(path) {
  if (statSync(path).mode & 0o077)
    throw new Error("Private setup files must have mode 0600 and directory mode 0700");
  return readFileSync(path, "utf8");
}
function save(directory, file, value) {
  writeFileSync(resolve(directory, file), value, { mode: 0o600, flag: "wx" });
}
function display(config, directory) {
  console.log(
    `Environment: ${config.environment}\nDeployment: ${config.deployment}\nWeb origin: ${config.appUrl}\nGoogle authorized JavaScript origin: ${config.appUrl}\nGoogle authorized redirect URI: ${config.httpActionsUrl}/api/auth/callback/google\nPrivate setup directory: ${directory}\nFrontend configuration: ${resolve(directory, "frontend.env")}\nApprove users in THIS deployment's Data → users table: accessStatus = "allowed".`,
  );
}
function runConvex(command, directory, config, credentials, input) {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve("convex/package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  const cli = resolve(dirname(packagePath), pkg.bin.convex);
  // --env-file overrides environment variables in this Convex CLI version.
  // Write only the validated deployment key into a temporary private env file.
  const temporary = mkdtempSync(resolve(directory, ".convex-cli-"));
  let result;
  try {
    const { args, env, envFileContent } = convexInvocation(
      command,
      temporary,
      config,
      credentials,
      process.env,
    );
    save(temporary, "deployment.env", envFileContent);
    result = spawnSync(process.execPath, [cli, ...args], {
      cwd: root,
      env,
      input,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 300_000,
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }

  // Never forward CLI output: provider/CLI errors can contain credential values.
  if (result.error || result.status !== 0)
    throw new Error(
      `Convex ${command[0]} failed for ${config.environment}:${config.deployment}. Check deployment-key permissions, existing variable conflicts, network and backend checks. No CLI output is printed to protect secrets.`,
    );
  console.log(`Convex ${command[0]} succeeded for ${config.environment}:${config.deployment}.`);
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      environment: { type: "string" },
      deployment: { type: "string" },
      "app-url": { type: "string" },
      "convex-url": { type: "string" },
      directory: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(usage);
    process.exit(0);
  }
  const [command] = positionals;
  if (
    positionals.length !== 1 ||
    !["prepare", "inspect", "apply", "deploy"].includes(command) ||
    !["dev", "prod"].includes(values.environment) ||
    !values.directory ||
    !isAbsolute(values.directory)
  )
    throw new Error(usage);
  const directory = resolve(values.directory);
  if (command === "prepare") {
    const config = validateConfig({
      version: 1,
      environment: values.environment,
      deployment: values.deployment,
      appUrl: values["app-url"],
      convexUrl: values["convex-url"],
    });
    // Reuse the key utility; it rejects repository paths and existing directories.
    const result = spawnSync(
      process.execPath,
      [resolve(root, "scripts/generate-auth-keys.mjs"), directory],
      { encoding: "utf8" },
    );
    if (result.status !== 0)
      throw new Error(
        "Choose a new absolute private directory outside the repository; key preparation failed",
      );
    save(directory, "config.json", `${JSON.stringify(config, null, 2)}\n`);
    save(
      directory,
      "credentials.json",
      `${JSON.stringify({ googleClientId: "", googleClientSecret: "", deployKey: "" }, null, 2)}\n`,
    );
    save(
      directory,
      "frontend.env",
      `NEXT_PUBLIC_CONVEX_URL=${config.convexUrl}\nZAMOLXIS_APP_URL=${config.appUrl}\n`,
    );
    display(config, directory);
    console.log(
      "Next: create the Google Web application client with these URLs, then privately fill credentials.json. Use a separate client, keys and directory for the other environment.",
    );
  } else {
    const actualDirectory = realpathSync(directory);
    const inside = relative(realpathSync(root), actualDirectory);
    if (!inside || (!inside.startsWith("../") && !isAbsolute(inside)))
      throw new Error("Setup directory must be outside the repository");
    if (statSync(directory).mode & 0o077) throw new Error("Private directory must have mode 0700");
    const config = validateConfig(JSON.parse(privateFile(resolve(directory, "config.json"))));
    if (config.environment !== values.environment)
      throw new Error("Requested environment does not match the prepared directory");
    if (values.deployment || values["app-url"] || values["convex-url"])
      throw new Error(
        "Only prepare accepts deployment, convex-url and app-url; inspect the saved target before applying",
      );
    display(config, directory);
    if (command !== "inspect") {
      const credentials = JSON.parse(privateFile(resolve(directory, "credentials.json")));
      validateCredentials(config, credentials);
      if (command === "apply") {
        const variables = {
          SITE_URL: config.appUrl,
          AUTH_GOOGLE_ID: credentials.googleClientId,
          AUTH_GOOGLE_SECRET: credentials.googleClientSecret,
        };
        for (const [name, file] of Object.entries({
          JWT_PRIVATE_KEY: "JWT_PRIVATE_KEY.pem",
          JWKS: "JWKS.json",
          ZAMOLXIS_DEVICE_PRIVATE_KEY: "ZAMOLXIS_DEVICE_PRIVATE_KEY.pem",
          ZAMOLXIS_DEVICE_JWKS: "ZAMOLXIS_DEVICE_JWKS.json",
        }))
          variables[name] = privateFile(resolve(directory, file)).trim();
        // Preserve JSON quotes and PEM newlines literally. One batch,
        // no --force: Convex refuses all writes if an existing value differs.
        const content = serializeAuthVariables(variables);
        runConvex(["env", "set"], directory, config, credentials, content);
      } else runConvex(["deploy"], directory, config, credentials);
    }
  }
} catch (error) {
  // JSON/URL parsing errors might include user input or a secret: keep them private.
  console.error(
    error instanceof SyntaxError || error instanceof TypeError
      ? "Invalid setup file or URL. Check the private configuration; no values were printed."
      : error.message,
  );
  process.exitCode = 1;
}
