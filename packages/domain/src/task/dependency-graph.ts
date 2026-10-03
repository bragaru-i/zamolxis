import { DomainError } from "../shared/domain-error";
import type { TaskState } from "./task";

export interface TaskDependency {
  readonly taskId: string;
  readonly dependsOnTaskId: string;
  readonly requiresSuccess: boolean;
}

export function assertAcyclic(taskIds: readonly string[], dependencies: readonly TaskDependency[]): void {
  const edges = new Map<string, string[]>();
  for (const id of taskIds) edges.set(id, []);
  for (const edge of dependencies) edges.get(edge.dependsOnTaskId)?.push(edge.taskId);

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new DomainError("DEPENDENCY_CYCLE", "Task dependency cycle detected");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of edges.get(id) ?? []) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of taskIds) visit(id);
}

export function getReadyTaskIds(tasks: readonly TaskState[], dependencies: readonly TaskDependency[]): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks
    .filter((task) => task.status === "planned" || task.status === "blocked")
    .filter((task) =>
      dependencies
        .filter((edge) => edge.taskId === task.id)
        .every((edge) => {
          const dependency = byId.get(edge.dependsOnTaskId);
          return edge.requiresSuccess ? dependency?.status === "completed" : dependency?.status === "completed" || dependency?.status === "failed";
        }),
    )
    .map((task) => task.id);
}
