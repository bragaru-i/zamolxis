import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
export function watchSession(
  deploymentUrl: string,
  userToken: string,
  workSessionId: string,
): () => Promise<void> {
  const client = new ConvexClient(deploymentUrl);
  client.setAuth(async () => userToken);
  const session = client.onUpdate(
    makeFunctionReference<"query", { workSessionId: string }, Record<string, Value>>(
      "sessions:get",
    ),
    { workSessionId },
    (snapshot) => {
      console.log(
        `${snapshot.title}: ${snapshot.status} · ${snapshot.completedTaskCount}/${snapshot.totalTaskCount} tasks · ${snapshot.activeRunCount} active runs`,
      );
    },
  );
  const runs = client.onUpdate(
    makeFunctionReference<
      "query",
      { workSessionId: string; limit: number },
      Record<string, Value>[]
    >("runs:listBySession"),
    { workSessionId, limit: 20 },
    (snapshots) => {
      for (const run of snapshots)
        console.log(
          `Run ${run._id}: ${run.status}${run.activityLabel ? ` · ${run.activityLabel}` : ""}`,
        );
    },
  );
  return async () => {
    session();
    runs();
    await client.close();
  };
}
