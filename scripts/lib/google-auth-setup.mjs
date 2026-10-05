export function validateConfig(config) {
  if (config?.version !== 1 || !["dev", "prod"].includes(config.environment))
    throw new Error("Environment must be explicitly dev or prod");
  if (typeof config.deployment !== "string" || !/^[a-z][a-z0-9-]+$/.test(config.deployment))
    throw new Error("Use the deployment name from the selected Convex deployment URL");
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
  return { ...config, appUrl: url.origin };
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
