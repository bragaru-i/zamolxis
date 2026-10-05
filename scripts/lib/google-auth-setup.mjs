export function validateConfig(config) {
  if (config?.version !== 1 || !["dev", "prod"].includes(config.environment))
    throw new Error("Environment must be explicitly dev or prod");
  if (typeof config.deployment !== "string" || !/^[a-z][a-z0-9-]+$/.test(config.deployment))
    throw new Error("Use the deployment name from the selected Convex deployment URL");
  const convex = new URL(config.convexUrl ?? `https://${config.deployment}.convex.cloud`);
  if (
    convex.protocol !== "https:" ||
    convex.pathname !== "/" ||
    convex.search ||
    convex.hash ||
    convex.username ||
    convex.password ||
    convex.port ||
    !new RegExp(`^${config.deployment}(\\.[a-z0-9-]+)?\\.convex\\.cloud$`).test(convex.hostname)
  )
    throw new Error(
      "Convex URL must be the selected deployment's HTTPS .convex.cloud URL, including its region when present",
    );
  const url = new URL(config.appUrl);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("App URL must be a canonical HTTPS origin (development also needs HTTPS)");
  return {
    ...config,
    appUrl: url.origin,
    convexUrl: convex.origin,
    httpActionsUrl: convex.origin.replace(/\.cloud$/, ".site"),
  };
}
export function validateCredentials(config, credentials) {
  const prefix = `${config.environment}:${config.deployment}|`;
  if (
    typeof credentials.deployKey !== "string" ||
    !credentials.deployKey.startsWith(prefix) ||
    credentials.deployKey.length <= prefix.length ||
    /\s/.test(credentials.deployKey)
  )
    throw new Error(
      "Use a deployment-scoped key whose environment and deployment match config.json; project, preview and legacy keys are rejected",
    );
  if (
    typeof credentials.googleClientId !== "string" ||
    !/^[a-zA-Z0-9.-]+\.apps\.googleusercontent\.com$/.test(credentials.googleClientId) ||
    typeof credentials.googleClientSecret !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(credentials.googleClientSecret)
  )
    throw new Error("Fill the Google client ID and secret in credentials.json");
}
export function convexInvocation(command, directory, config, credentials, inheritedEnv) {
  validateCredentials(config, credentials);
  const env = Object.fromEntries(
    Object.entries(inheritedEnv).filter(
      ([name]) => !name.startsWith("CONVEX_") && !name.startsWith("ZAMOLXIS_"),
    ),
  );
  env.CONVEX_DEPLOY_KEY = credentials.deployKey;
  return {
    args: [...command, "--env-file", `${directory}/deployment.env`],
    env,
    envFileContent: `CONVEX_DEPLOY_KEY=${credentials.deployKey}\n`,
  };
}

// Convex parses batch input with dotenv, which does not unescape JSON quotes.
// Literal single-quoted values preserve JSON and real PEM newlines exactly.
export function serializeAuthVariables(variables) {
  return Object.entries(variables)
    .map(([name, value]) => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(name) || typeof value !== "string" || value.includes("'"))
        throw new Error("Invalid authentication environment variable format");
      return `${name}='${value}'`;
    })
    .join("\n");
}
