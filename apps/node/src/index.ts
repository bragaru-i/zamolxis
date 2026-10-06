import { createNodeInfo } from "@zamolxis/node-core";
import { watchSession } from "./debug-session";
import { runFakeLoopOnce } from "./fake-loop";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
if (process.argv.includes("--fake-loop-once")) {
  await runFakeLoopOnce({
    deploymentUrl: required("CONVEX_URL"),
    deviceToken: required("ZAMOLXIS_DEVICE_TOKEN"),
    workstationId: required("ZAMOLXIS_WORKSTATION_ID"),
    repositoryId: required("ZAMOLXIS_REPOSITORY_ID"),
    repositoryPath: required("ZAMOLXIS_REPOSITORY_PATH"),
    repositoryRemote: required("ZAMOLXIS_REPOSITORY_REMOTE"),
    managedRoot: required("ZAMOLXIS_MANAGED_ROOT"),
  });
  console.log("Fake loop processed available commands and durable deliveries");
} else if (process.argv.includes("--watch-session")) {
  const close = watchSession(
    required("CONVEX_URL"),
    required("ZAMOLXIS_USER_TOKEN"),
    required("ZAMOLXIS_SESSION_ID"),
  );
  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });
} else {
  const info = createNodeInfo();
  console.log(`Zamolxis Node ${info.version} scaffold ready`);
}
