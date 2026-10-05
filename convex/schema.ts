import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const workstationStatus = v.union(
  v.literal("online"),
  v.literal("offline"),
  v.literal("degraded"),
  v.literal("revoked"),
);
export const sessionStatus = v.union(
  v.literal("planning"),
  v.literal("running"),
  v.literal("waiting"),
  v.literal("needs_input"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled"),
);
export const taskStatus = v.union(
  v.literal("planned"),
  v.literal("blocked"),
  v.literal("ready"),
  v.literal("running"),
  v.literal("waiting"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled"),
);
const workspaceKind = v.union(
  v.literal("canonical"),
  v.literal("worktree"),
  v.literal("integration"),
);
export const workspaceStatus = v.union(
  v.literal("requested"),
  v.literal("provisioning"),
  v.literal("ready"),
  v.literal("in_use"),
  v.literal("dirty"),
  v.literal("integrating"),
  v.literal("completed"),
  v.literal("cleanup_pending"),
  v.literal("removed"),
  v.literal("error"),
);
export const runStatus = v.union(
  v.literal("queued"),
  v.literal("starting"),
  v.literal("running"),
  v.literal("waiting"),
  v.literal("needs_approval"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("stopping"),
  v.literal("stopped"),
  v.literal("lost"),
);
const commandStatus = v.union(
  v.literal("pending"),
  v.literal("claimed"),
  v.literal("acknowledged"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("expired"),
);

export default defineSchema({
  textCommands: defineTable({
    ownerId: v.id("users"),
    idempotencyKey: v.string(),
    text: v.string(),
    productId: v.id("products"),
    repositoryId: v.id("repositories"),
    workSessionId: v.id("workSessions"),
    requestedSessionId: v.optional(v.id("workSessions")),
  }).index("by_owner_key", ["ownerId", "idempotencyKey"]),
  pairingRequests: defineTable({
    approvalHash: v.string(),
    pollHash: v.string(),
    name: v.string(),
    expiresAt: v.number(),
    status: v.union(v.literal("pending"), v.literal("approved"), v.literal("consumed")),
    workstationId: v.optional(v.id("workstations")),
    ownerSubject: v.optional(v.string()),
  }).index("by_approval_hash", ["approvalHash"]),
  deviceCredentials: defineTable({
    workstationId: v.id("workstations"),
    secretHash: v.string(),
    createdAt: v.number(),
  })
    .index("by_secret_hash", ["secretHash"])
    .index("by_workstation", ["workstationId"]),
  users: defineTable({
    authSubject: v.string(),
    displayName: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_auth_subject", ["authSubject"]),

  workstations: defineTable({
    ownerId: v.id("users"),
    name: v.string(),
    status: workstationStatus,
    nodeAuthSubject: v.optional(v.string()),
    nodeVersion: v.optional(v.string()),
    nodeInstanceId: v.optional(v.string()),
    platform: v.optional(v.string()),
    architecture: v.optional(v.string()),
    capabilityRevision: v.optional(v.string()),
    lastHeartbeatAt: v.optional(v.number()),
    registeredAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_owner", ["ownerId"])
    .index("by_owner_status", ["ownerId", "status"])
    .index("by_status_heartbeat", ["status", "lastHeartbeatAt"])
    .index("by_node_subject", ["nodeAuthSubject"]),

  runtimeInstallations: defineTable({
    workstationId: v.id("workstations"),
    runtime: v.string(),
    version: v.optional(v.string()),
    status: v.union(v.literal("available"), v.literal("unavailable"), v.literal("degraded")),
    capabilities: v.array(v.string()),
    detectedAt: v.number(),
    metadata: v.optional(v.any()),
  })
    .index("by_workstation", ["workstationId"])
    .index("by_workstation_runtime", ["workstationId", "runtime"]),

  products: defineTable({
    ownerId: v.id("users"),
    name: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
    archivedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner", ["ownerId"])
    .index("by_owner_slug", ["ownerId", "slug"]),

  repositories: defineTable({
    ownerId: v.id("users"),
    productId: v.optional(v.id("products")),
    name: v.string(),
    remoteUrl: v.optional(v.string()),
    provider: v.optional(v.string()),
    externalRepositoryId: v.optional(v.string()),
    defaultBranch: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner", ["ownerId"])
    .index("by_product", ["productId"])
    .index("by_owner_remote", ["ownerId", "remoteUrl"]),

  repositoryLocations: defineTable({
    repositoryId: v.id("repositories"),
    workstationId: v.id("workstations"),
    canonicalPath: v.string(),
    gitCommonDir: v.optional(v.string()),
    defaultBranch: v.optional(v.string()),
    lastKnownHead: v.optional(v.string()),
    status: v.union(
      v.literal("available"),
      v.literal("missing"),
      v.literal("invalid"),
      v.literal("busy"),
    ),
    verifiedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_repository", ["repositoryId"])
    .index("by_workstation", ["workstationId"])
    .index("by_repository_workstation", ["repositoryId", "workstationId"]),

  workSessions: defineTable({
    ownerId: v.id("users"),
    productId: v.optional(v.id("products")),
    title: v.string(),
    goal: v.string(),
    status: sessionStatus,
    contextSummary: v.optional(v.string()),
    currentPlanSummary: v.optional(v.string()),
    activeRunCount: v.number(),
    completedTaskCount: v.number(),
    totalTaskCount: v.number(),
    needsInputCount: v.number(),
    lastActivityAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_owner_activity", ["ownerId", "lastActivityAt"])
    .index("by_owner_status_activity", ["ownerId", "status", "lastActivityAt"])
    .index("by_product_activity", ["productId", "lastActivityAt"]),

  sessionRepositories: defineTable({
    workSessionId: v.id("workSessions"),
    repositoryId: v.id("repositories"),
    role: v.union(v.literal("primary"), v.literal("dependency"), v.literal("secondary")),
  })
    .index("by_session", ["workSessionId"])
    .index("by_repository", ["repositoryId"])
    .index("by_session_repository", ["workSessionId", "repositoryId"]),

  tasks: defineTable({
    workSessionId: v.id("workSessions"),
    title: v.string(),
    description: v.string(),
    kind: v.string(),
    status: taskStatus,
    runtimePolicyMode: v.union(v.literal("auto"), v.literal("preferred"), v.literal("forced")),
    runtimePolicyRuntime: v.optional(v.string()),
    priority: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    candidateRunId: v.optional(v.id("agentRuns")),
    verificationRunId: v.optional(v.id("verificationRuns")),
    trustDecisionId: v.optional(v.id("trustDecisions")),
  })
    .index("by_session", ["workSessionId"])
    .index("by_session_status", ["workSessionId", "status"])
    .index("by_session_priority", ["workSessionId", "priority"]),

  taskDependencies: defineTable({
    workSessionId: v.id("workSessions"),
    taskId: v.id("tasks"),
    dependsOnTaskId: v.id("tasks"),
    type: v.union(v.literal("completion"), v.literal("success")),
  })
    .index("by_task", ["taskId"])
    .index("by_dependency", ["dependsOnTaskId"])
    .index("by_session", ["workSessionId"]),

  workspaces: defineTable({
    workSessionId: v.id("workSessions"),
    taskId: v.optional(v.id("tasks")),
    repositoryId: v.id("repositories"),
    repositoryLocationId: v.id("repositoryLocations"),
    workstationId: v.id("workstations"),
    kind: workspaceKind,
    status: workspaceStatus,
    localPath: v.optional(v.string()),
    baseRef: v.string(),
    baseSha: v.optional(v.string()),
    branchName: v.optional(v.string()),
    currentHeadSha: v.optional(v.string()),
    ownerRunId: v.optional(v.id("agentRuns")),
    leaseNodeInstanceId: v.optional(v.string()),
    leaseAcquiredAt: v.optional(v.number()),
    leaseRenewedAt: v.optional(v.number()),
    dirty: v.boolean(),
    changedFileCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    removedAt: v.optional(v.number()),
    errorCode: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  })
    .index("by_session", ["workSessionId"])
    .index("by_task", ["taskId"])
    .index("by_workstation_status", ["workstationId", "status"])
    .index("by_repository_status", ["repositoryId", "status"])
    .index("by_owner_run", ["ownerRunId"]),

  agentRuns: defineTable({
    workSessionId: v.id("workSessions"),
    taskId: v.id("tasks"),
    workspaceId: v.id("workspaces"),
    workstationId: v.id("workstations"),
    role: v.optional(v.union(v.literal("builder"), v.literal("verifier"))),
    runtime: v.string(),
    nativeSessionId: v.optional(v.string()),
    parentRunId: v.optional(v.id("agentRuns")),
    status: runStatus,
    attempt: v.number(),
    activityLabel: v.optional(v.string()),
    resultSummary: v.optional(v.string()),
    exitReason: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    lastActivityAt: v.number(),
    heartbeatAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    initialHeadSha: v.optional(v.string()),
    finalHeadSha: v.optional(v.string()),
  })
    .index("by_session_activity", ["workSessionId", "lastActivityAt"])
    .index("by_session_status", ["workSessionId", "status"])
    .index("by_task", ["taskId"])
    .index("by_workspace", ["workspaceId"])
    .index("by_workstation_status", ["workstationId", "status"])
    .index("by_parent", ["parentRunId"])
    .index("by_native_session", ["workstationId", "runtime", "nativeSessionId"]),

  runEvents: defineTable({
    runId: v.id("agentRuns"),
    workstationId: v.id("workstations"),
    eventId: v.string(),
    sequence: v.number(),
    type: v.string(),
    occurredAt: v.number(),
    payload: v.any(),
  })
    .index("by_run_sequence", ["runId", "sequence"])
    .index("by_run_event_id", ["runId", "eventId"])
    .index("by_workstation_time", ["workstationId", "occurredAt"]),

  commands: defineTable({
    workstationId: v.id("workstations"),
    type: v.string(),
    targetType: v.string(),
    targetId: v.string(),
    claimNodeInstanceId: v.optional(v.string()),
    idempotencyKey: v.string(),
    status: commandStatus,
    payload: v.any(),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    claimedAt: v.optional(v.number()),
    acknowledgedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
  })
    .index("by_workstation_status", ["workstationId", "status"])
    .index("by_workstation_created", ["workstationId", "createdAt"])
    .index("by_idempotency_key", ["idempotencyKey"]),

  approvals: defineTable({
    ownerId: v.id("users"),
    workSessionId: v.id("workSessions"),
    runId: v.optional(v.id("agentRuns")),
    workstationId: v.optional(v.id("workstations")),
    action: v.string(),
    risk: v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("critical")),
    request: v.any(),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("expired"),
    ),
    requestedAt: v.number(),
    resolvedAt: v.optional(v.number()),
    resolvedBy: v.optional(v.id("users")),
  })
    .index("by_owner_status", ["ownerId", "status"])
    .index("by_session", ["workSessionId"])
    .index("by_run", ["runId"]),

  artifacts: defineTable({
    workSessionId: v.id("workSessions"),
    taskId: v.optional(v.id("tasks")),
    runId: v.optional(v.id("agentRuns")),
    kind: v.string(),
    name: v.string(),
    storage: v.union(v.literal("local"), v.literal("convex_storage"), v.literal("git")),
    locator: v.string(),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index("by_session", ["workSessionId"])
    .index("by_task", ["taskId"])
    .index("by_run", ["runId"]),

  sessionDecisions: defineTable({
    workSessionId: v.id("workSessions"),
    taskId: v.optional(v.id("tasks")),
    runId: v.optional(v.id("agentRuns")),
    category: v.string(),
    summary: v.string(),
    rationale: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_session", ["workSessionId"])
    .index("by_task", ["taskId"]),

  nodeEventCursors: defineTable({
    workstationId: v.id("workstations"),
    nodeInstanceId: v.string(),
    runId: v.id("agentRuns"),
    lastSequence: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workstation", ["workstationId"])
    .index("by_run", ["runId"])
    .index("by_instance_run", ["nodeInstanceId", "runId"]),
  traces: defineTable({
    runId: v.id("agentRuns"),
    workspaceId: v.id("workspaces"),
    role: v.union(v.literal("builder"), v.literal("verifier")),
    subjectSha: v.string(),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  }).index("by_run", ["runId"]),
  traceSteps: defineTable({
    traceId: v.id("traces"),
    eventId: v.string(),
    sequence: v.number(),
    type: v.string(),
    summary: v.string(),
    occurredAt: v.number(),
  })
    .index("by_trace_sequence", ["traceId", "sequence"])
    .index("by_trace_event", ["traceId", "eventId"]),
  verificationRuns: defineTable({
    candidateRunId: v.id("agentRuns"),
    verifierRunId: v.id("agentRuns"),
    subjectSha: v.string(),
    createdAt: v.number(),
  })
    .index("by_candidate", ["candidateRunId"])
    .index("by_verifier", ["verifierRunId"]),
  evidence: defineTable({
    verificationRunId: v.id("verificationRuns"),
    verifierRunId: v.id("agentRuns"),
    subjectSha: v.string(),
    modality: v.union(
      v.literal("static"),
      v.literal("test"),
      v.literal("behavioral"),
      v.literal("visual"),
      v.literal("interaction"),
      v.literal("mutation"),
      v.literal("security"),
    ),
    result: v.union(v.literal("passed"), v.literal("failed")),
    summary: v.string(),
    createdAt: v.number(),
  }).index("by_verification", ["verificationRunId"]),
  trustDecisions: defineTable({
    candidateRunId: v.id("agentRuns"),
    subjectSha: v.string(),
    eligible: v.boolean(),
    reasons: v.array(v.string()),
    createdAt: v.number(),
  }).index("by_candidate", ["candidateRunId"]),
});
