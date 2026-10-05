// Pure decisions for scripts/deploy.mjs, kept separate so they can be unit-tested.

export const NODE_SERVICE_LABEL = "app.zamolxis.node";

export function parseDeployArgs(argv) {
  const options = {
    directory: process.env.ZAMOLXIS_PROD_SETUP_DIR ?? "",
    pull: false,
    yes: false,
    check: true,
    convex: true,
    web: true,
    node: true,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--directory") {
      options.directory = argv[++index] ?? "";
    } else if (argument === "--pull") options.pull = true;
    else if (argument === "--yes") options.yes = true;
    else if (argument === "--skip-check") options.check = false;
    else if (argument === "--skip-convex") options.convex = false;
    else if (argument === "--skip-web") options.web = false;
    else if (argument === "--skip-node") options.node = false;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown option ${argument}`);
  }
  if (!options.help && (options.convex || options.web) && !options.directory)
    throw new Error(
      "Pass --directory /absolute/private/prod-directory (or set ZAMOLXIS_PROD_SETUP_DIR); it is the directory created by google-auth-setup prepare --environment prod",
    );
  return options;
}

// Deploy only the exact commit on origin/main, from a clean checkout.
export function gitProblem({ branch, head, remoteHead, dirty }) {
  if (branch !== "main") return `Check out main first (current branch: ${branch || "detached"})`;
  if (dirty)
    return "Commit or stash local changes first; deploys must match a pushed commit exactly";
  if (head !== remoteHead)
    return "Local main differs from origin/main; rerun with --pull to fast-forward, or push your commits first";
  return undefined;
}

export function vercelArgs(commit) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("A full commit SHA is required");
  // --build-env stamps the build; --env exposes the commit to /api/bootstrap at runtime.
  return [
    "deploy",
    "--prod",
    "--yes",
    "--build-env",
    `ZAMOLXIS_COMMIT=${commit}`,
    "--env",
    `ZAMOLXIS_COMMIT=${commit}`,
  ];
}

// Only restart the launchd service when it runs this checkout's daemon.
export function nodeServiceRunsFrom(plist, root) {
  return plist.includes(`${root}/apps/node/src/daemon.ts`);
}

export function deployedCommitMatches(bootstrap, commit) {
  return Boolean(bootstrap) && bootstrap.version === 1 && bootstrap.commit === commit;
}
