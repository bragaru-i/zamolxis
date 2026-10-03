export type TaskStatus = "planned" | "blocked" | "ready" | "running" | "waiting" | "completed" | "failed" | "cancelled";

export interface TaskState {
  readonly id: string;
  readonly status: TaskStatus;
}
