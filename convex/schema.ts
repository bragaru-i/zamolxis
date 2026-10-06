import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Supervisor log steps (mirrors packages/contracts/src/trace/supervisor-log.ts).
export const supervisorLogKind = v.union(
  v.literal("discovery"),
  v.literal("supervisor"),
  v.literal("phase"),
  v.literal("tool"),
  v.literal("message"),
  v.literal("approval"),
);
// A model a runtime offers (mirrors RuntimeModelDto in packages/runtime-core/src/models.ts).
export const runtimeModel = v.object({
  id: v.string(),
  displayName: v.string(),
  description: v.optional(v.string()),
  isDefault: v.optional(v.boolean()),
  efforts: v.optional(v.array(v.string())),
  defaultEffort: v.optional(v.string()),
});
// What a computer reports about one repository's GitHub publishing access (mirrors GitHubAccess
// in packages/application/src/execution/github-access.ts): status, which credential
// publishes (its own token or its chosen gh account), login and token expiry. Never a secret.
export const githubAccess = v.object({
  status: v.union(
    v.literal("ok"),
    v.literal("expiring"),
    v.literal("expired"),
    v.literal("invalid"),
    v.literal("no_push"),
    v.literal("missing"),
    v.literal("account_unavailable"),
    v.literal("unreachable"),
  ),
  source: v.optional(v.union(v.literal("token"), v.literal("gh_account"))),
  login: v.optional(v.string()),
  expiresAt: v.optional(v.number()),
  checkedAt: v.number(),
});
export const supervisorLogStatus = v.union(
  v.literal("started"),
  v.literal("passed"),
  v.literal("failed"),
  v.literal("skipped"),
);
export const supervisorLogReferences = v.object({
  runId: v.optional(v.string()),
  sha: v.optional(v.string()),
  script: v.optional(v.string()),
  exitCode: v.optional(v.number()),
});
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
  ...authTables,
  // Re-infer optional fields locally: auth 0.0.96 declarations include explicit
  // undefined values, incompatible with exactOptionalPropertyTypes. Runtime
  // validators and indexes stay identical to the library schema.
  authAccounts: defineTable({ ...authTables.authAccounts.validator.fields })
    .index("userIdAndProvider", ["userId", "provider"])
    .index("providerAndAccountId", ["provider", "providerAccountId"]),
  authRefreshTokens: defineTable({ ...authTables.authRefreshTokens.validator.fields })
    .index("sessionId", ["sessionId"])
    .index("sessionIdAndParentRefreshTokenId", ["sessionId", "parentRefreshTokenId"]),
  authVerificationCodes: defineTable({ ...authTables.authVerificationCodes.validator.fields })
    .index("accountId", ["accountId"])
    .index("code", ["code"]),
  authVerifiers: defineTable({ ...authTables.authVerifiers.validator.fields }).index("signature", [
    "signature",
  ]),
  textCommands: defineTable({
    ownerId: v.id("users"),
    idempotencyKey: v.string(),
    text: v.string(),
    productId: v.id("products"),
    repositoryId: v.id("repositories"),
    workSessionId: v.id("workSessions"),
    requestedSessionId: v.optional(v.id("workSessions")),
    planningWorkspaceId: v.optional(v.id("workspaces")),
    planDigest: v.optional(v.string()),
    contextSha: v.optional(v.string()),
    contextDigest: v.optional(v.string()),
    // Supervisor outcome for this message (#49). Absent for legacy Nodes.
    decision: v.optional(
      v.union(
        v.literal("answer"),
        v.literal("plan"),
        v.literal("propose"),
        v.literal("delegate"),
        v.literal("ask"),
      ),
    ),
    reply: v.optional(v.string()),
    modelActual: v.optional(v.string()),
    inputTokens: v.optional(v.number()),
    cachedInputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    totalTokens: v.optional(v.number()),
    // Progress reported by the planning Node while the Supervisor works (bounded).
    supervisorActivity: v.optional(v.string()),
    supervisorStartedAt: v.optional(v.number()),
    supervisorProgressAt: v.optional(v.number()),
    // The owner asked to stop the Supervisor; stoppedAt once it stopped before answering.
    stopRequestedAt: v.optional(v.number()),
    stoppedAt: v.optional(v.number()),
  })
    .index("by_owner_key", ["ownerId", "idempotencyKey"])
    .index("by_session", ["workSessionId"]),
  // What the Supervisor did for one message (#49): bounded, redacted steps delivered by the
  // planning Node. Keyed by text command, not by a trace: the Supervisor is a Node-local
  // run without an agentRuns row.
  supervisorLogSteps: defineTable({
    textCommandId: v.id("textCommands"),
    ownerId: v.id("users"),
    sequence: v.number(),
    stepId: v.string(),
    kind: supervisorLogKind,
    label: v.string(),
    status: supervisorLogStatus,
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    detail: v.optional(v.string()),
    references: v.optional(supervisorLogReferences),
  })
    .index("by_text_sequence", ["textCommandId", "sequence"])
    .index("by_text_step", ["textCommandId", "stepId"]),
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
    ...authTables.users.validator.fields,
    authSubject: v.optional(v.string()),
    displayName: v.optional(v.string()),
    createdAt: v.optional(v.number()),
    accessStatus: v.optional(
      v.union(v.literal("pending"), v.literal("allowed"), v.literal("blocked")),
    ),
    // In-app access administration (#47). Set only by convex/admin.ts.
    role: v.optional(v.literal("admin")),
  })
    .index("by_auth_subject", ["authSubject"])
    .index("by_role", ["role"])
    .index("email", ["email"])
    .index("phone", ["phone"]),

  // Bounded, non-identifying label of a browser sign-in (#47), e.g. "Safari on iPhone".
  // Convex Auth stores no user agent; the signed-in browser reports its own label.
  signInLabels: defineTable({
    userId: v.id("users"),
    sessionId: v.id("authSessions"),
    label: v.string(),
    updatedAt: v.number(),
  }).index("by_session", ["sessionId"]),

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
    // Set when this entry was revoked because the same computer paired again (#45).
    replacedBy: v.optional(v.id("workstations")),
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
    // Replaced only by a heartbeat that reports models for this runtime.
    models: v.optional(v.array(runtimeModel)),
    modelsUpdatedAt: v.optional(v.number()),
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

  // The durable, owner-level conversation with Zamolxis. It sits above Work
  // Sessions: questions remain here, while explicit work may link to a Session.
  orchestratorConversations: defineTable({
    ownerId: v.id("users"),
    title: v.string(),
    lastActivityAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    archivedAt: v.optional(v.number()),
  }).index("by_owner_activity", ["ownerId", "lastActivityAt"]),

  orchestratorMessages: defineTable({
    ownerId: v.id("users"),
    conversationId: v.id("orchestratorConversations"),
    idempotencyKey: v.string(),
    text: v.string(),
    productId: v.optional(v.id("products")),
    repositoryId: v.optional(v.id("repositories")),
    route: v.union(
      v.literal("answer"),
      v.literal("ask"),
      v.literal("propose"),
      v.literal("create"),
      v.literal("continue"),
    ),
    // The deterministic summary until the Orchestrator model replies (or if it cannot).
    reply: v.string(),
    workSessionId: v.optional(v.id("workSessions")),
    // Absent on rows written before the model-backed Orchestrator: they are answered.
    status: v.optional(v.union(v.literal("thinking"), v.literal("answered"))),
    answeredBy: v.optional(v.union(v.literal("model"), v.literal("deterministic"))),
    modelError: v.optional(v.string()),
    // An inert proposal: nothing starts until the owner opens it into a Session.
    proposal: v.optional(v.string()),
    proposalSessionId: v.optional(v.id("workSessions")),
    runtime: v.optional(v.string()),
    modelRequested: v.optional(v.string()),
    modelActual: v.optional(v.string()),
    inputTokens: v.optional(v.number()),
    cachedInputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    totalTokens: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_owner_key", ["ownerId", "idempotencyKey"])
    .index("by_conversation_time", ["conversationId", "createdAt"]),

  // Typed navigation emitted by an Orchestrator answer. The first version
  // links Sessions; the target union keeps Tasks/Runs/approvals addressable as
  // richer summaries are added without putting URLs in assistant prose.
  orchestratorMessageLinks: defineTable({
    ownerId: v.id("users"),
    messageId: v.id("orchestratorMessages"),
    workSessionId: v.optional(v.id("workSessions")),
    targetType: v.union(
      v.literal("session"),
      v.literal("task"),
      v.literal("run"),
      v.literal("approval"),
      v.literal("trust"),
      v.literal("pull_request"),
      v.literal("external_ticket"),
    ),
    targetId: v.string(),
    label: v.string(),
    status: v.optional(v.string()),
    url: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_message", ["messageId"])
    .index("by_session", ["workSessionId"]),

  repositories: defineTable({
    ownerId: v.id("users"),
    productId: v.optional(v.id("products")),
    name: v.string(),
    remoteUrl: v.optional(v.string()),
    provider: v.optional(v.string()),
    externalRepositoryId: v.optional(v.string()),
    defaultBranch: v.optional(v.string()),
    // Set when this entry was folded into another one for the same remote; the survivor
    // keeps the locations and the Product.
    mergedIntoId: v.optional(v.id("repositories")),
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
      // Removed by the owner or the Node (#45): never chosen for new work; only an
      // explicit re-grant from setup makes it available again.
      v.literal("removed"),
    ),
    verifiedAt: v.optional(v.number()),
    removedAt: v.optional(v.number()),
    // GitHub publishing access as this computer last checked it (status only, no secret).
    githubAccess: v.optional(githubAccess),
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
    // Set when a follow-up reopens a finished Session; earlier tasks no longer decide its outcome.
    reopenedAt: v.optional(v.number()),
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
    phase: v.optional(
      v.union(
        v.literal("blocked"),
        v.literal("building"),
        v.literal("waiting_for_verification"),
        v.literal("verifying"),
        v.literal("trust_failed"),
        v.literal("repairing"),
        v.literal("ready_for_integration"),
        v.literal("integrating"),
        v.literal("completed"),
        v.literal("needs_input"),
        v.literal("failed"),
      ),
    ),
    repairAttempts: v.optional(v.number()),
    failureReason: v.optional(v.string()),
    verifierWorkspaceId: v.optional(v.id("workspaces")),
    nextWorkspaceId: v.optional(v.id("workspaces")),
    integrationWorkspaceId: v.optional(v.id("workspaces")),
    requiredModalities: v.optional(v.array(v.string())),
    verificationScripts: v.optional(v.array(v.string())),
    verificationRunId: v.optional(v.id("verificationRuns")),
    trustDecisionId: v.optional(v.id("trustDecisions")),
    lastTrustDecisionId: v.optional(v.id("trustDecisions")),
    // Publication of the trusted integration branch, only on the owner's explicit action.
    publishStatus: v.optional(
      v.union(v.literal("pending"), v.literal("published"), v.literal("failed")),
    ),
    publishBranch: v.optional(v.string()),
    publishBase: v.optional(v.string()),
    publishCommandId: v.optional(v.id("commands")),
    publishAttempts: v.optional(v.number()),
    publishError: v.optional(v.string()),
    prUrl: v.optional(v.string()),
    compareUrl: v.optional(v.string()),
    publishedAt: v.optional(v.number()),
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
    // Retention cleanup (convex/lib/retention.ts): requested -> removed, or failed with a
    // code; failures back off and stop after a bounded number of attempts.
    cleanupStatus: v.optional(
      v.union(v.literal("requested"), v.literal("removed"), v.literal("failed")),
    ),
    cleanupCommandId: v.optional(v.id("commands")),
    cleanupAttempts: v.optional(v.number()),
    cleanupRequestedAt: v.optional(v.number()),
    cleanupError: v.optional(v.string()),
    cleanupNextAttemptAt: v.optional(v.number()),
  })
    .index("by_session", ["workSessionId"])
    .index("by_task", ["taskId"])
    .index("by_workstation_status", ["workstationId", "status"])
    .index("by_repository_status", ["repositoryId", "status"])
    .index("by_owner_run", ["ownerRunId"]),

  // Per-owner worktree retention (Settings -> Storage); absent means the default window.
  storageSettings: defineTable({
    ownerId: v.id("users"),
    retentionDays: v.number(),
    updatedAt: v.number(),
  }).index("by_owner", ["ownerId"]),

  agentProfiles: defineTable({
    ownerId: v.id("users"),
    productId: v.optional(v.id("products")),
    name: v.string(),
    role: v.union(
      v.literal("orchestrator"),
      v.literal("supervisor"),
      v.literal("builder"),
      v.literal("verifier"),
      v.literal("repair"),
      v.literal("integration"),
    ),
    runtime: v.string(),
    model: v.optional(v.string()),
    reasoningEffort: v.optional(v.string()),
    enabled: v.boolean(),
    maxConcurrency: v.optional(v.number()),
    // Owner instructions (#48): redacted prompt text, at most 4000 characters.
    instructions: v.optional(v.string()),
    instructionsDigest: v.optional(v.string()),
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner", ["ownerId"])
    .index("by_owner_role", ["ownerId", "role"])
    .index("by_product_role", ["productId", "role"]),

  agentRuns: defineTable({
    workSessionId: v.id("workSessions"),
    taskId: v.id("tasks"),
    workspaceId: v.id("workspaces"),
    workstationId: v.id("workstations"),
    role: v.optional(v.union(v.literal("builder"), v.literal("verifier"), v.literal("repair"))),
    runtime: v.string(),
    agentProfileId: v.optional(v.id("agentProfiles")),
    agentProfileRevision: v.optional(v.number()),
    // SHA-256 of the owner instructions included in this run's prompt, if any.
    instructionsDigest: v.optional(v.string()),
    modelRequested: v.optional(v.string()),
    modelActual: v.optional(v.string()),
    reasoningEffort: v.optional(v.string()),
    runtimeVersion: v.optional(v.string()),
    inputTokens: v.optional(v.number()),
    cachedInputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    totalTokens: v.optional(v.number()),
    estimatedCostUsd: v.optional(v.number()),
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
    finalDirty: v.optional(v.boolean()),
    finalChangedFileCount: v.optional(v.number()),
  })
    .index("by_session_activity", ["workSessionId", "lastActivityAt"])
    .index("by_session_status", ["workSessionId", "status"])
    .index("by_task", ["taskId"])
    .index("by_workspace", ["workspaceId"])
    .index("by_workstation_status", ["workstationId", "status"])
    .index("by_parent", ["parentRunId"])
    .index("by_profile", ["agentProfileId"])
    .index("by_profile_status", ["agentProfileId", "status"])
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
    // Runtime approvals: the stable id reported by the Node (run + native request id),
    // and how the runtime settled it (user decision, timeout, stop or withdrawal).
    runtimeApprovalId: v.optional(v.string()),
    runtimeOutcome: v.optional(
      v.object({
        decision: v.union(v.literal("approved"), v.literal("rejected")),
        reason: v.union(
          v.literal("user"),
          v.literal("timeout"),
          v.literal("stopped"),
          v.literal("withdrawn"),
        ),
        at: v.number(),
      }),
    ),
  })
    .index("by_owner_status", ["ownerId", "status"])
    .index("by_session", ["workSessionId"])
    .index("by_session_status", ["workSessionId", "status"])
    .index("by_run", ["runId"])
    .index("by_run_runtime_approval", ["runId", "runtimeApprovalId"]),

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
    role: v.union(v.literal("builder"), v.literal("verifier"), v.literal("repair")),
    subjectSha: v.string(),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  }).index("by_run", ["runId"]),
  // TraceStepDto (packages/contracts) as stored: ordered by first arrival; a "started"
  // step is settled at most once, otherwise steps are append-only.
  traceSteps: defineTable({
    traceId: v.id("traces"),
    stepId: v.string(),
    sequence: v.number(),
    kind: v.union(
      v.literal("discovery"),
      v.literal("supervisor"),
      v.literal("workspace"),
      v.literal("runtime"),
      v.literal("verification-check"),
      v.literal("trust"),
      v.literal("integration"),
    ),
    label: v.string(),
    status: v.union(
      v.literal("started"),
      v.literal("passed"),
      v.literal("failed"),
      v.literal("skipped"),
    ),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    detail: v.optional(v.string()),
    references: v.optional(
      v.object({
        runId: v.optional(v.string()),
        sha: v.optional(v.string()),
        script: v.optional(v.string()),
        exitCode: v.optional(v.number()),
      }),
    ),
  })
    .index("by_trace_sequence", ["traceId", "sequence"])
    .index("by_trace_step", ["traceId", "stepId"]),
  verificationRuns: defineTable({
    candidateRunId: v.id("agentRuns"),
    verifierRunId: v.id("agentRuns"),
    subjectSha: v.string(),
    trustDecisionId: v.optional(v.id("trustDecisions")),
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
