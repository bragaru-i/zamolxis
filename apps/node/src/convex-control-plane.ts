import type {
  ControlPlaneTransport,
  ConversationMessage,
  Delivery,
  ExecutionCommand,
  SupervisorProgress,
  SupervisorSelection,
} from "@zamolxis/node-core";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import type { Value } from "convex/values";
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_COMMAND");
  return value as Record<string, unknown>;
}
function field(value: Record<string, unknown>, name: string, max = 128): string {
  const result = value[name];
  if (typeof result !== "string" || !result.length || result.length > max)
    throw new Error("INVALID_COMMAND");
  return result;
}
function parseSupervisorSelection(value: unknown): SupervisorSelection {
  const selection = object(value);
  return {
    runtime: field(selection, "runtime"),
    ...(selection.model !== undefined ? { model: field(selection, "model", 256) } : {}),
    ...(selection.reasoningEffort !== undefined
      ? { reasoningEffort: field(selection, "reasoningEffort", 64) }
      : {}),
  };
}
// Prior messages are context for the Supervisor: keep the latest 20, each bounded.
function parseConversation(value: unknown): ConversationMessage[] {
  if (!Array.isArray(value)) throw new Error("INVALID_COMMAND");
  return value.slice(-20).flatMap((entry): ConversationMessage[] => {
    const message = object(entry);
    if (
      (message.role !== "user" && message.role !== "supervisor") ||
      typeof message.text !== "string"
    )
      throw new Error("INVALID_COMMAND");
    const text = message.text.slice(0, 4000);
    return text.trim() ? [{ role: message.role, text }] : [];
  });
}
export function parseExecutionCommand(value: unknown): ExecutionCommand {
  const command = object(value);
  const payload = object(command.payload);
  const common = {
    commandId: field(command, "_id"),
    workstationId: field(command, "workstationId"),
    idempotencyKey: field(command, "idempotencyKey", 512),
  };
  if (command.type === "workspace.provision") {
    const workspaceId = field(payload, "workspaceId");
    if (command.targetType !== "workspace" || command.targetId !== workspaceId)
      throw new Error("INVALID_COMMAND_TARGET");
    return {
      ...common,
      type: "workspace.provision",
      payload: {
        workspaceId,
        repositoryLocationId: field(payload, "repositoryLocationId"),
        repositoryId: field(payload, "repositoryId"),
        baseRef: field(payload, "baseRef", 1024),
        ...(payload.kind === "integration" ? { kind: "integration" as const } : {}),
        ...(Array.isArray(payload.mergeShas)
          ? { mergeShas: payload.mergeShas.map((sha) => field({ sha }, "sha", 64)) }
          : {}),
      },
    };
  }
  if (command.type === "runtime.start") {
    if (
      payload.role !== undefined &&
      payload.role !== "builder" &&
      payload.role !== "verifier" &&
      payload.role !== "repair"
    )
      throw new Error("INVALID_COMMAND_ROLE");
    const runId = field(payload, "runId");
    if (command.targetType !== "run" || command.targetId !== runId)
      throw new Error("INVALID_COMMAND_TARGET");
    return {
      ...common,
      type: "runtime.start",
      payload: {
        runId,
        workspaceId: field(payload, "workspaceId"),
        runtime: field(payload, "runtime"),
        role:
          payload.role === "verifier"
            ? "verifier"
            : payload.role === "repair"
              ? "repair"
              : "builder",
        ...(Array.isArray(payload.verificationScripts)
          ? {
              verificationScripts: payload.verificationScripts.map((script) =>
                field({ script }, "script", 64),
              ),
            }
          : {}),
        ...(Array.isArray(payload.requiredModalities)
          ? {
              requiredModalities: payload.requiredModalities.map((modality) =>
                field({ modality }, "modality", 64),
              ),
            }
          : {}),
        instruction: field(payload, "instruction", 32768),
        ...(payload.model !== undefined ? { model: field(payload, "model", 256) } : {}),
        ...(payload.reasoningEffort !== undefined
          ? { reasoningEffort: field(payload, "reasoningEffort", 64) }
          : {}),
      },
    };
  }
  if (command.type === "repository.plan") {
    const textCommandId = field(payload, "textCommandId");
    if (command.targetType !== "textCommand" || command.targetId !== textCommandId)
      throw new Error("INVALID_COMMAND_TARGET");
    return {
      ...common,
      type: "repository.plan",
      payload: {
        textCommandId,
        workspaceId: field(payload, "workspaceId"),
        text: field(payload, "text", 16000),
        ...(payload.supervisor !== undefined
          ? { supervisor: parseSupervisorSelection(payload.supervisor) }
          : {}),
        ...(payload.conversation !== undefined
          ? { conversation: parseConversation(payload.conversation) }
          : {}),
      },
    };
  }
  if (command.type === "integration.prepare") {
    const taskId = field(payload, "taskId");
    if (command.targetType !== "task" || command.targetId !== taskId)
      throw new Error("INVALID_COMMAND_TARGET");
    return {
      ...common,
      type: "integration.prepare",
      payload: {
        taskId,
        workspaceId: field(payload, "workspaceId"),
        subjectSha: field(payload, "subjectSha"),
        trustDecisionId: field(payload, "trustDecisionId"),
      },
    };
  }
  if (command.type === "integration.publish") {
    const taskId = field(payload, "taskId");
    if (command.targetType !== "task" || command.targetId !== taskId)
      throw new Error("INVALID_COMMAND_TARGET");
    return {
      ...common,
      type: "integration.publish",
      payload: {
        taskId,
        workspaceId: field(payload, "workspaceId"),
        branch: field(payload, "branch", 256),
        ...(payload.base !== undefined ? { base: field(payload, "base", 256) } : {}),
        subjectSha: field(payload, "subjectSha"),
        title: field(payload, "title", 512),
        body: field(payload, "body", 65536),
      },
    };
  }
  if (command.type === "runtime.stop" || command.type === "runtime.send") {
    const runId = field(payload, "runId");
    if (command.targetType !== "run" || command.targetId !== runId)
      throw new Error("INVALID_COMMAND_TARGET");
    return command.type === "runtime.stop"
      ? { ...common, type: "runtime.stop", payload: { runId } }
      : {
          ...common,
          type: "runtime.send",
          payload: { runId, message: field(payload, "message", 16000) },
        };
  }
  if (command.type === "runtime.approval") {
    const runId = field(payload, "runId");
    if (command.targetType !== "run" || command.targetId !== runId)
      throw new Error("INVALID_COMMAND_TARGET");
    if (payload.decision !== "approve" && payload.decision !== "reject")
      throw new Error("INVALID_COMMAND");
    return {
      ...common,
      type: "runtime.approval",
      payload: { runId, approvalId: field(payload, "approvalId", 256), decision: payload.decision },
    };
  }
  if (command.type === "supervisor.stop") {
    const textCommandId = field(payload, "textCommandId");
    if (command.targetType !== "textCommand" || command.targetId !== textCommandId)
      throw new Error("INVALID_COMMAND_TARGET");
    return { ...common, type: "supervisor.stop", payload: { textCommandId } };
  }
  if (command.type === "workspace.cleanup") {
    const workspaceId = field(payload, "workspaceId");
    if (command.targetType !== "workspace" || command.targetId !== workspaceId)
      throw new Error("INVALID_COMMAND_TARGET");
    return { ...common, type: "workspace.cleanup", payload: { workspaceId } };
  }
  throw new Error("UNSUPPORTED_EXECUTION_COMMAND");
}
// One malformed or unknown command must not stop the Node from processing the rest.
export function parsePendingCommand(value: unknown): ExecutionCommand | undefined {
  try {
    return parseExecutionCommand(value);
  } catch (error) {
    try {
      const command = object(value);
      const message = error instanceof Error ? error.message : "";
      return {
        commandId: field(command, "_id"),
        workstationId: field(command, "workstationId"),
        idempotencyKey: field(command, "idempotencyKey", 512),
        type: "invalid",
        payload: { code: /^[A-Z_]{1,64}$/.test(message) ? message : "INVALID_COMMAND" },
      };
    } catch {
      return undefined;
    }
  }
}
export interface ControlPlaneClient {
  mutation(
    reference: FunctionReference<"mutation", "public", Record<string, Value>, unknown>,
    args: Record<string, Value>,
  ): Promise<unknown>;
  query(
    reference: FunctionReference<"query", "public", Record<string, Value>, unknown>,
    args: Record<string, Value>,
  ): Promise<unknown>;
}
export class ConvexControlPlaneTransport implements ControlPlaneTransport {
  constructor(
    private readonly client: ControlPlaneClient,
    private readonly workstationId: string,
    private readonly instanceId: string,
  ) {}
  async mutation(name: string, args: Record<string, Value>): Promise<unknown> {
    return this.client.mutation(
      makeFunctionReference<"mutation", Record<string, Value>, unknown>(`node:${name}`),
      { workstationId: this.workstationId, ...args },
    );
  }
  async listPending(): Promise<ExecutionCommand[]> {
    const result = await this.client.query(
      makeFunctionReference<"query", Record<string, Value>, unknown>("node:listPending"),
      { workstationId: this.workstationId },
    );
    if (!Array.isArray(result)) throw new Error("INVALID_COMMAND_RESPONSE");
    return result
      .map(parsePendingCommand)
      .filter((command): command is ExecutionCommand => command !== undefined);
  }
  async claim(commandId: string): Promise<void> {
    await this.mutation("claim", { commandId, instanceId: this.instanceId });
  }
  async acknowledge(commandId: string): Promise<void> {
    await this.mutation("acknowledge", { commandId, instanceId: this.instanceId });
  }
  async reconcile(runId: string, observation: "active" | "missing" = "missing"): Promise<void> {
    await this.mutation("reconcile", { runId, observation });
  }
  async reportProgress(progress: SupervisorProgress): Promise<void> {
    await this.client.mutation(
      makeFunctionReference<"mutation", Record<string, Value>, unknown>(
        "supervisor:reportProgress",
      ),
      {
        workstationId: this.workstationId,
        textCommandId: progress.textCommandId,
        ...(progress.activity ? { activity: progress.activity } : {}),
        ...(progress.usage && Object.keys(progress.usage).length
          ? { usage: { ...progress.usage } }
          : {}),
      },
    );
  }
  async deliver(delivery: Delivery): Promise<void> {
    if (delivery.kind === "command.failed") {
      await this.mutation("failCommand", {
        commandId: delivery.commandId,
        code: delivery.code,
        instanceId: this.instanceId,
      });
    } else if (delivery.kind === "repository.plan") {
      const { kind: _, usage, ...args } = delivery;
      await this.client.mutation(
        makeFunctionReference<"mutation", Record<string, Value>, unknown>("supervisor:acceptPlan"),
        {
          workstationId: this.workstationId,
          ...args,
          tasks: delivery.tasks.map((task) => ({ ...task })),
          ...(usage && Object.keys(usage).length ? { usage: { ...usage } } : {}),
        },
      );
    } else if (delivery.kind === "integration.ready") {
      const { kind: _, ...args } = delivery;
      await this.mutation("completeIntegration", args);
    } else if (delivery.kind === "integration.published") {
      const { kind: _, ...args } = delivery;
      await this.client.mutation(
        makeFunctionReference<"mutation", Record<string, Value>, unknown>(
          "integration:completePublish",
        ),
        { workstationId: this.workstationId, ...args },
      );
    } else if (delivery.kind === "workspace.ready") {
      const { kind: _, ...args } = delivery;
      await this.mutation("markReady", args);
    } else if (delivery.kind === "run.events") {
      const events = delivery.events.map((event) => ({
        eventId: event.eventId,
        sequence: event.sequence,
        type: event.type,
        occurredAt: event.occurredAt,
        payload:
          event.type === "files.changed"
            ? { paths: [...event.payload.paths] }
            : { ...event.payload },
      }));
      const result = await this.mutation("ingestBatch", { runId: delivery.runId, events });
      if (
        !Array.isArray(result) ||
        result.length !== events.length ||
        result.some((id, index) => id !== events[index]?.eventId)
      )
        throw new Error("INVALID_EVENT_ACKNOWLEDGEMENT");
    } else if (delivery.kind === "run.complete") {
      const { kind: _, evidence, ...args } = delivery;
      await this.mutation("completeRun", {
        ...args,
        ...(evidence ? { evidence: evidence.map((record) => ({ ...record })) } : {}),
      });
    } else {
      // An observed ready workspace/native session proves startup happened, including across instance changes.
      await this.mutation("recoverCompletedCommand", {
        commandId: delivery.commandId,
        instanceId: this.instanceId,
      });
    }
  }
}
