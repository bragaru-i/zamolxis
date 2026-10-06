// Scenario data for the preview harness (see store.ts). Shapes mirror the Convex queries the
// web app reads; ids are plain strings. Nothing here reaches production.

type Row = Record<string, unknown>;
type Args = Record<string, unknown>;

export interface Scenario {
  query(name: string, args: Args): unknown;
  mutate(name: string, args: Args, bump: () => void): Promise<unknown>;
}

export const scenarioNames = ["owner", "empty", "attention", "busy"] as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const LONG_TITLE =
  "Goal: Redesign Zamolxis Home around a ChatGPT-like conversation interface while making Work Sessions easy to find, filter, and hide";

const SUMMARY = `Implemented the rounding fix in \`packages/domain/src/totals.ts\` and added a regression test.

- Totals now round once, after summing line items.
- \`pnpm test --filter domain\` passes (14 tests).
- No changes outside the task's files.`;

const MODELS = {
  claude: [
    {
      id: "claude-opus-5-5",
      displayName: "Opus 5.5",
      description: "For complex work and everyday tasks",
      isDefault: true,
      efforts: ["low", "medium", "high"],
      defaultEffort: "medium",
    },
    {
      id: "claude-fable-5-1",
      displayName: "Fable 5.1",
      description: "For your toughest challenges",
      efforts: ["low", "medium", "high", "max"],
      defaultEffort: "high",
    },
    {
      id: "claude-haiku-4-5",
      displayName: "Haiku 4.5",
      description: "Fastest for quick answers",
      efforts: ["low", "medium"],
      defaultEffort: "low",
    },
    {
      id: "claude-sonnet-5-5",
      displayName: "Sonnet 5.5",
      description: "Most efficient for simpler tasks",
      efforts: ["low", "medium", "high"],
      defaultEffort: "medium",
    },
  ],
  codex: [
    {
      id: "gpt-5.1-codex",
      displayName: "GPT-5.1 Codex",
      description: "Optimized for agentic coding",
      isDefault: true,
      efforts: ["low", "medium", "high", "xhigh"],
      defaultEffort: "medium",
    },
    {
      id: "gpt-6.1-sol",
      displayName: "GPT-6.1 Sol",
      description: "Frontier reasoning",
      efforts: ["low", "medium", "high", "xhigh"],
      defaultEffort: "high",
    },
    {
      id: "gpt-5.1-codex-mini",
      displayName: "GPT-5.1 Codex mini",
      description: "Fast and cheap for small edits",
      efforts: ["minimal", "low", "medium"],
      defaultEffort: "low",
    },
  ],
};

function build(name: string) {
  const now = Date.now();
  const empty = name === "empty";
  const attention = name === "attention";
  const busy = name === "busy";

  const workstations: Row[] = empty
    ? []
    : [
        {
          _id: "w1",
          name: "Ion's MacBook Pro",
          status: "online",
          lastHeartbeatAt: now - 4000,
          runtimes: [
            { runtime: "codex", status: "available" },
            { runtime: "claude", status: "available" },
          ],
        },
      ];

  const sessions: Row[] = empty
    ? []
    : [
        {
          _id: "s1",
          title: "Fix checkout totals and invoice VAT",
          status: "running",
          lastActivityAt: now - 2 * MINUTE,
          totalTaskCount: 3,
          completedTaskCount: 1,
          activeRunCount: 2,
        },
        {
          _id: "s2",
          title: LONG_TITLE,
          status: "planning",
          lastActivityAt: now - 40_000,
          totalTaskCount: 0,
          completedTaskCount: 0,
          activeRunCount: 0,
        },
        {
          _id: "s3",
          title: "So what shall be done to finish the alpha ?",
          status: "needs_input",
          lastActivityAt: now - 3 * HOUR,
          totalTaskCount: 2,
          completedTaskCount: 0,
          activeRunCount: 0,
          contextSummary: "VERIFICATION_FAILED",
        },
        {
          _id: "s4",
          title: "What are next things to do? Check plans",
          status: "completed",
          lastActivityAt: now - 26 * HOUR,
          totalTaskCount: 2,
          completedTaskCount: 2,
          activeRunCount: 0,
        },
        {
          _id: "s5",
          title: "Current project status?",
          status: "waiting",
          lastActivityAt: now - 5 * HOUR,
          totalTaskCount: 0,
          completedTaskCount: 0,
          activeRunCount: 0,
        },
        {
          _id: "s6",
          title: "Are you on?",
          status: "completed",
          lastActivityAt: now - 2 * 24 * HOUR,
          totalTaskCount: 0,
          completedTaskCount: 0,
          activeRunCount: 0,
        },
        {
          _id: "s7",
          title: "Hi",
          status: "cancelled",
          lastActivityAt: now - 3 * 24 * HOUR,
          totalTaskCount: 0,
          completedTaskCount: 0,
          activeRunCount: 0,
        },
        {
          _id: "s8",
          title: "Migrate the sign-in flow to passkeys",
          status: "failed",
          lastActivityAt: now - 4 * 24 * HOUR,
          totalTaskCount: 1,
          completedTaskCount: 0,
          activeRunCount: 0,
          contextSummary: "NODE_OFFLINE",
        },
      ];
  if (busy)
    for (let index = 0; index < 12; index++)
      sessions.push({
        _id: `sx${index}`,
        title: `Older session ${index + 1}: tidy up module ${index + 1}`,
        status: index % 3 ? "completed" : "cancelled",
        lastActivityAt: now - (5 + index) * 24 * HOUR,
        totalTaskCount: 1,
        completedTaskCount: index % 3 ? 1 : 0,
        activeRunCount: 0,
      });

  const tasks: Record<string, Row[]> = {
    s1: [
      {
        _id: "t1",
        _creationTime: now - 20 * MINUTE,
        workSessionId: "s1",
        title: "Fix checkout totals rounding",
        status: "running",
        phase: "building",
        repairAttempts: 0,
      },
      {
        _id: "t2",
        _creationTime: now - 19 * MINUTE,
        workSessionId: "s1",
        title: "Add VAT line to the invoice PDF",
        status: "waiting",
        phase: "verifying",
        repairAttempts: 1,
      },
      {
        _id: "t3",
        _creationTime: now - 18 * MINUTE,
        workSessionId: "s1",
        title: "Document the totals rule in the README",
        status: "completed",
        phase: "completed",
        repairAttempts: 0,
        trustOutcome: "trusted",
      },
    ],
    s3: [
      {
        _id: "t4",
        _creationTime: now - 4 * HOUR,
        workSessionId: "s3",
        title: "Write the alpha checklist",
        status: "waiting",
        phase: "needs_input",
        repairAttempts: 2,
        trustOutcome: "untrusted",
        failureReason: "VERIFICATION_FAILED",
      },
      {
        _id: "t5",
        _creationTime: now - 4 * HOUR,
        workSessionId: "s3",
        title: "Close the open onboarding gaps",
        status: "queued",
        phase: "queued",
        repairAttempts: 0,
      },
    ],
    s4: [
      {
        _id: "t6",
        _creationTime: now - 27 * HOUR,
        workSessionId: "s4",
        title: "List the next steps from docs/alpha-status.md",
        status: "completed",
        phase: "completed",
        repairAttempts: 0,
        trustOutcome: "trusted",
      },
      {
        _id: "t7",
        _creationTime: now - 27 * HOUR,
        workSessionId: "s4",
        title: "Check the plans against open issues",
        status: "completed",
        phase: "completed",
        repairAttempts: 0,
        trustOutcome: "trusted",
      },
    ],
  };

  const run = (row: Row): Row => ({
    workstationId: "w1",
    attempt: 1,
    lastActivityAt: now - 5000,
    ...row,
  });
  const runs: Record<string, Row[]> = {
    s1: [
      run({
        _id: "r1",
        _creationTime: now - 8 * MINUTE,
        workSessionId: "s1",
        taskId: "t1",
        workspaceId: "ws1",
        role: "builder",
        runtime: "codex",
        status: "running",
        modelRequested: "gpt-5.1-codex",
        modelActual: "gpt-5.1-codex",
        reasoningEffort: "medium",
        activityLabel: "Running pnpm test --filter domain",
        inputTokens: 41_200,
        cachedInputTokens: 30_100,
        outputTokens: 7_010,
        totalTokens: 48_210,
        startedAt: now - 7 * MINUTE - 12_000,
        initialHeadSha: "e4c3af024d101a84aab867b6cab3e30b0aab56df",
      }),
      run({
        _id: "r2",
        _creationTime: now - 15 * MINUTE,
        workSessionId: "s1",
        taskId: "t2",
        workspaceId: "ws2",
        role: "builder",
        runtime: "claude",
        status: "completed",
        modelRequested: "claude-opus-5-5",
        modelActual: "claude-opus-5-5",
        reasoningEffort: "medium",
        inputTokens: 102_000,
        cachedInputTokens: 80_000,
        outputTokens: 18_400,
        totalTokens: 120_400,
        estimatedCostUsd: 0.84,
        startedAt: now - 15 * MINUTE,
        completedAt: now - 6 * MINUTE,
        resultSummary: SUMMARY,
        finalHeadSha: "9b1f2d4c0a8e7f6d5c4b3a2918f7e6d5c4b3a291",
        finalChangedFileCount: 3,
      }),
      run({
        _id: "r3",
        _creationTime: now - 5 * MINUTE,
        workSessionId: "s1",
        taskId: "t2",
        workspaceId: "ws3",
        role: "verifier",
        runtime: "claude",
        status: "running",
        modelRequested: "claude-sonnet-5-5",
        modelActual: "claude-sonnet-5-5",
        activityLabel: "Reading apps/web/app/features/usage.tsx",
        inputTokens: 8_000,
        outputTokens: 1_100,
        totalTokens: 9_100,
        startedAt: now - 4 * MINUTE - 30_000,
        parentRunId: "r2",
      }),
      run({
        _id: "r4",
        _creationTime: now - 17 * MINUTE,
        workSessionId: "s1",
        taskId: "t3",
        workspaceId: "ws4",
        role: "builder",
        runtime: "codex",
        status: "completed",
        modelActual: "gpt-5.1-codex-mini",
        inputTokens: 6_000,
        outputTokens: 900,
        totalTokens: 6_900,
        startedAt: now - 17 * MINUTE,
        completedAt: now - 14 * MINUTE,
        resultSummary: "Added the rounding rule to the README under Billing.",
        finalHeadSha: "77aa11bb22cc33dd44ee55ff6677889900aabbcc",
        finalChangedFileCount: 1,
      }),
      run({
        _id: "r5",
        _creationTime: now - 13 * MINUTE,
        workSessionId: "s1",
        taskId: "t3",
        workspaceId: "ws5",
        role: "verifier",
        runtime: "codex",
        status: "completed",
        modelActual: "gpt-5.1-codex",
        totalTokens: 3_300,
        startedAt: now - 13 * MINUTE,
        completedAt: now - 11 * MINUTE,
        resultSummary: "The README change matches the acceptance criteria.",
        parentRunId: "r4",
      }),
    ],
    s3: [
      run({
        _id: "r6",
        _creationTime: now - 4 * HOUR,
        workSessionId: "s3",
        taskId: "t4",
        workspaceId: "ws6",
        role: "repair",
        runtime: "codex",
        status: "failed",
        modelActual: "gpt-5.1-codex",
        totalTokens: 54_000,
        startedAt: now - 4 * HOUR,
        completedAt: now - 3 * HOUR,
        exitReason: "VERIFICATION_FAILED",
      }),
    ],
    s4: [
      run({
        _id: "r7",
        _creationTime: now - 27 * HOUR,
        workSessionId: "s4",
        taskId: "t6",
        workspaceId: "ws7",
        role: "builder",
        runtime: "codex",
        status: "completed",
        modelActual: "gpt-6.1-sol",
        totalTokens: 12_000,
        startedAt: now - 27 * HOUR,
        completedAt: now - 26 * HOUR - 30 * MINUTE,
        resultSummary: "Listed six next steps.",
      }),
    ],
  };

  const messages: Record<string, Row[]> = {
    s1: [
      {
        _id: "m1",
        text: "Fix the checkout totals rounding and add the VAT line to the invoice PDF. Document the rule.",
        productId: "p1",
        repositoryId: "rp1",
        createdAt: now - 21 * MINUTE,
        planned: true,
        planTaskCount: 3,
        planStatus: "completed",
        decision: "delegate",
        reply: "Opening three tasks: the rounding fix, the VAT line and the README note.",
        supervisor: { modelActual: "gpt-6.1-sol", totalTokens: 9_800 },
      },
    ],
    s2: [
      {
        _id: "m2",
        text: LONG_TITLE,
        productId: "p1",
        repositoryId: "rp1",
        createdAt: now - 40_000,
        planned: false,
        planTaskCount: 0,
        planStatus: "acknowledged",
        progress: {
          activity: "Reading apps/web/app/features/sessions.tsx",
          startedAt: now - 38_000,
        },
        supervisor: { totalTokens: 2_300 },
      },
    ],
    s3: [
      {
        _id: "m3",
        text: "So what shall be done to finish the alpha ?",
        productId: "p1",
        repositoryId: "rp1",
        createdAt: now - 4 * HOUR,
        planned: true,
        planTaskCount: 2,
        planStatus: "completed",
        decision: "delegate",
        reply: "Two tasks cover the remaining gaps.",
      },
      {
        _id: "m4",
        text: "Why did the check fail?",
        productId: "p1",
        repositoryId: "rp1",
        createdAt: now - 3 * HOUR,
        planned: false,
        planTaskCount: 0,
        planStatus: "completed",
        decision: "ask",
        reply:
          "The behavioral check needs a running Node. Should I retry once the Mac is online, or mark the task as done without it?",
      },
    ],
    s4: [
      {
        _id: "m5",
        text: "What are next things to do? Check plans",
        productId: "p1",
        repositoryId: "rp1",
        createdAt: now - 27 * HOUR,
        planned: true,
        planTaskCount: 2,
        planStatus: "completed",
        decision: "delegate",
        reply: "Checking the plans against the open issues.",
      },
    ],
    s5: [
      {
        _id: "m6",
        text: "Current project status?",
        productId: "p1",
        repositoryId: "rp1",
        createdAt: now - 5 * HOUR,
        planned: false,
        planTaskCount: 0,
        planStatus: "completed",
        decision: "answer",
        reply:
          "Alpha is not finished: issues #45, #47, #48 and #49 are open. The Node, pairing and the Supervisor loop work end to end.",
        supervisor: { modelActual: "gpt-6.1-sol", totalTokens: 4_100 },
      },
    ],
    s6: [
      {
        _id: "m7",
        text: "Are you on?",
        productId: "p1",
        repositoryId: "rp1",
        createdAt: now - 2 * 24 * HOUR,
        planned: false,
        planTaskCount: 0,
        planStatus: "completed",
        decision: "answer",
        reply: "Yes.",
      },
    ],
    s7: [
      {
        _id: "m8",
        text: "Hi",
        productId: "p1",
        repositoryId: "rp1",
        createdAt: now - 3 * 24 * HOUR,
        planned: false,
        planTaskCount: 0,
        planStatus: "failed",
        planError: "SUPERVISOR_STOPPED",
        stopped: true,
      },
    ],
    s8: [
      {
        _id: "m9",
        text: "Migrate the sign-in flow to passkeys",
        productId: "p1",
        repositoryId: "rp1",
        createdAt: now - 4 * 24 * HOUR,
        planned: true,
        planTaskCount: 1,
        planStatus: "completed",
        decision: "delegate",
      },
    ],
  };

  // Proof images: an image the Builder's change added (a logo) and two screenshots it saved.
  const svg = (body: string) =>
    `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">${body}</svg>`)}`;
  const proofImages: Row[] = [
    {
      _id: "a1",
      runId: "r1",
      name: "apps/web/app/icon.svg",
      source: "changed",
      url: svg(
        '<rect width="120" height="120" rx="26" fill="#173a66"/><path d="M30 44l15 12 15-22 15 22 15-12-6 34H36z" fill="#e7b74a"/><text x="60" y="100" text-anchor="middle" font-family="sans-serif" font-size="22" font-weight="700" fill="#fff">Z</text>',
      ),
    },
    {
      _id: "a2",
      runId: "r1",
      name: "home-light.png",
      source: "proof",
      url: svg(
        '<rect width="120" height="120" fill="#f3f5f9"/><rect x="10" y="12" width="100" height="14" rx="4" fill="#173a66"/><rect x="10" y="34" width="70" height="8" rx="3" fill="#c9d3e0"/><rect x="10" y="48" width="90" height="40" rx="6" fill="#fff" stroke="#c9d3e0"/>',
      ),
    },
    {
      _id: "a3",
      runId: "r1",
      name: "home-dark.png",
      source: "proof",
      url: svg(
        '<rect width="120" height="120" fill="#111a26"/><rect x="10" y="12" width="100" height="14" rx="4" fill="#e7b74a"/><rect x="10" y="34" width="70" height="8" rx="3" fill="#2c3a4d"/><rect x="10" y="48" width="90" height="40" rx="6" fill="#1b2635" stroke="#2c3a4d"/>',
      ),
    },
  ];
  const link = (row: Row): Row => ({ _id: `l${Math.random().toString(36).slice(2, 8)}`, ...row });
  // Chats on Home, newest activity first. Messages name their chat.
  const conversations: Row[] = empty
    ? []
    : [
        {
          _id: "c1",
          title: "Can you check, do we finished alpha?",
          lastActivityAt: now - 20 * MINUTE,
          createdAt: now - 50 * MINUTE,
        },
        {
          _id: "c2",
          title: "How does the verifier work?",
          lastActivityAt: now - 26 * HOUR,
          createdAt: now - 26 * HOUR,
        },
        {
          _id: "c3",
          title: "Why did the checkout fix need a repair?",
          lastActivityAt: now - 4 * 24 * HOUR,
          createdAt: now - 4 * 24 * HOUR,
        },
      ];
  const orchestrator: Row[] = empty
    ? []
    : [
        {
          _id: "o3",
          conversationId: "c2",
          text: "How does the verifier work?",
          reply:
            "After a Builder finishes, a separate Verifier gets its own copy of the exact change and runs the checks (tests, lint, build). Only a change that passes those checks is trusted and goes on to integration. The Verifier never sees the Builder's reasoning, only the acceptance criteria and the code.",
          route: "answer",
          status: "answered",
          answeredBy: "model",
          modelActual: "gpt-6.1-sol",
          totalTokens: 1_800,
          createdAt: now - 26 * HOUR,
          links: [],
        },
        {
          _id: "o4",
          conversationId: "c3",
          text: "Why did the checkout fix need a repair?",
          reply:
            "The first Builder change failed the Verifier: two invoice tests expected rounded VAT. A Repair run fixed the rounding and the second check passed.",
          route: "answer",
          status: "answered",
          answeredBy: "model",
          modelActual: "gpt-6.1-sol",
          totalTokens: 2_100,
          createdAt: now - 4 * 24 * HOUR,
          links: [],
        },
        {
          _id: "o1",
          conversationId: "c1",
          text: "Can you check, do we finished alpha?",
          reply:
            'I can\'t confirm that alpha is finished from the current state. Both "Current project status?" and "So what shall be done to finish the alpha?" are waiting for your input, and neither has recorded tasks or completion evidence.\n\nOpen those Work Sessions to resolve the outstanding questions and verify alpha completion.',
          route: "answer",
          status: "answered",
          answeredBy: "model",
          modelActual: "gpt-6.1-sol",
          totalTokens: 3_900,
          productId: "p1",
          repositoryId: "rp1",
          createdAt: now - 50 * MINUTE,
          links: [
            link({
              targetType: "session",
              targetId: "s5",
              workSessionId: "s5",
              label: "Current project status?",
              status: "needs_input",
            }),
            link({
              targetType: "session",
              targetId: "s3",
              workSessionId: "s3",
              label: "So what shall be done to finish the alpha ?",
              status: "needs_input",
            }),
            link({
              targetType: "session",
              targetId: "s6",
              workSessionId: "s6",
              label: "Are you on?",
              status: "completed",
            }),
            link({
              targetType: "session",
              targetId: "s7",
              workSessionId: "s7",
              label: "Hi",
              status: "completed",
            }),
            link({
              targetType: "session",
              targetId: "s4",
              workSessionId: "s4",
              label: "What are next things to do? Check plans",
              status: "completed",
            }),
          ],
        },
        {
          _id: "o2",
          conversationId: "c1",
          text: "Reorganize Home Screen:\n- sessions can be hidden and filtered\n- I must see a chat gpt like interface\nThink about it, then describe the screen.",
          reply:
            "I'd make Home a **conversation** first. Sessions live in a sidebar.\n\n- **Main area:** the conversation with a clear composer.\n- **Sidebar:** Work Sessions with search and filters.\n- **Hide sessions:** remove them from the usual list without closing them.\n\nKeep chatting and starting work separate: discussing an idea produces a proposal; work begins only when you explicitly open a Work Session.",
          route: "propose",
          status: "answered",
          answeredBy: "model",
          modelActual: "gpt-6.1-sol",
          totalTokens: 6_200,
          proposal: `${LONG_TITLE}\n\nScope: Prepare a reviewable Home screen design covering desktop and mobile. Put the orchestrator conversation and message composer in the main area. Move Work Sessions into a sidebar, with a collapsible drawer on mobile.\n\nAcceptance criteria: The conversation is the primary Home experience. Owners can search and filter sessions, hide a session without closing it, and restore it from Hidden.`,
          productId: "p1",
          repositoryId: "rp1",
          createdAt: now - 20 * MINUTE,
          links: [
            link({
              targetType: "session",
              targetId: "s3",
              workSessionId: "s3",
              label: "So what shall be done to finish the alpha ?",
              status: "waiting",
            }),
            link({
              targetType: "session",
              targetId: "s5",
              workSessionId: "s5",
              label: "Current project status?",
              status: "completed",
            }),
            link({
              targetType: "session",
              targetId: "s6",
              workSessionId: "s6",
              label: "Are you on?",
              status: "completed",
            }),
            link({
              targetType: "session",
              targetId: "s7",
              workSessionId: "s7",
              label: "Hi",
              status: "completed",
            }),
            link({
              targetType: "session",
              targetId: "s2",
              workSessionId: "s2",
              label: `Open this work: ${LONG_TITLE}`,
              status: "planning",
            }),
            link({
              targetType: "run",
              targetId: "r1",
              workSessionId: "s1",
              label: "Building: Fix checkout totals rounding",
              status: "running",
            }),
            link({
              targetType: "pull_request",
              targetId: "t3",
              workSessionId: "s1",
              label: "Pull request: Document the totals rule in the README",
              url: "https://github.com/bragaru-i/zamolxis/pull/98",
              status: "published",
            }),
          ],
        },
        {
          _id: "o3",
          text: "So what are current progress?",
          reply: "Three sessions are completed. Two remain open and are currently waiting.",
          route: "answer",
          status: "thinking",
          createdAt: now - 20_000,
          links: [],
        },
      ];

  const approvals: Row[] = attention
    ? [
        {
          _id: "ap1",
          workSessionId: "s1",
          runId: "r1",
          action: "command",
          risk: "high",
          request: { kind: "command", summary: "curl -fsSL https://example.com/install.sh | sh" },
          requestedAt: now - 90_000,
        },
      ]
    : [];

  const profiles: Row[] = empty
    ? []
    : [
        {
          _id: "a1",
          name: "Builder",
          role: "builder",
          runtime: "codex",
          model: "gpt-5.1-codex",
          reasoningEffort: "medium",
          enabled: true,
          updatedAt: now - 3 * HOUR,
        },
        {
          _id: "a2",
          name: "Verifier",
          role: "verifier",
          runtime: "claude",
          model: "claude-sonnet-5-5",
          enabled: true,
          updatedAt: now - 2 * HOUR,
        },
        {
          _id: "a3",
          name: "Orchestrator",
          role: "orchestrator",
          runtime: "codex",
          model: "gpt-6.1-sol",
          reasoningEffort: "high",
          enabled: true,
          updatedAt: now - HOUR,
        },
      ];

  const usage = (rows: Row[]) => {
    const total = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      items: 0,
      reported: 0,
      costUsd: undefined as number | undefined,
    };
    const byRole = new Map<string, typeof total>();
    const byModel = new Map<string, typeof total>();
    const add = (into: typeof total, row: Row) => {
      into.items += 1;
      into.inputTokens += (row.inputTokens as number) ?? 0;
      into.cachedInputTokens += (row.cachedInputTokens as number) ?? 0;
      into.outputTokens += (row.outputTokens as number) ?? 0;
      if (row.totalTokens !== undefined) {
        into.totalTokens += row.totalTokens as number;
        into.reported += 1;
      }
      if (row.estimatedCostUsd !== undefined)
        into.costUsd = (into.costUsd ?? 0) + (row.estimatedCostUsd as number);
    };
    const fresh = () => ({ ...total });
    for (const row of rows) {
      add(total, row);
      const role = (row.role as string) ?? "builder";
      byRole.set(role, byRole.get(role) ?? fresh());
      add(byRole.get(role) as typeof total, row);
      const model = (row.modelActual as string) ?? "";
      byModel.set(model, byModel.get(model) ?? fresh());
      add(byModel.get(model) as typeof total, row);
    }
    const strip = (totals: typeof total) =>
      totals.costUsd === undefined ? (({ costUsd: _cost, ...rest }) => rest)(totals) : totals;
    return {
      total: strip(total),
      byRole: [...byRole.entries()].map(([role, totals]) => ({ role, ...strip(totals) })),
      byModel: [...byModel.entries()].map(([model, totals]) => ({
        ...(model ? { model } : {}),
        ...strip(totals),
      })),
      truncated: false,
    };
  };

  const events: Row[] = [
    {
      _id: "e1",
      sequence: 1,
      type: "run.started",
      occurredAt: now - 7 * MINUTE,
      payload: { activity: "Reading the task" },
    },
    {
      _id: "e2",
      sequence: 2,
      type: "tool.started",
      occurredAt: now - 6 * MINUTE,
      payload: { tool: "command", summary: "rg -n 'round' packages/domain/src" },
    },
    {
      _id: "e3",
      sequence: 3,
      type: "tool.completed",
      occurredAt: now - 6 * MINUTE + 2000,
      payload: { tool: "command", summary: "rg -n 'round' packages/domain/src", success: true },
    },
    {
      _id: "e4",
      sequence: 4,
      type: "files.changed",
      occurredAt: now - 4 * MINUTE,
      payload: { paths: ["packages/domain/src/totals.ts", "packages/domain/src/totals.test.ts"] },
    },
    {
      _id: "e5",
      sequence: 5,
      type: "run.message",
      occurredAt: now - 3 * MINUTE,
      payload: {
        text: "Rounding once after the sum fixes the off-by-one cent. Running the domain tests now.",
      },
    },
    {
      _id: "e6",
      sequence: 6,
      type: "tool.started",
      occurredAt: now - MINUTE,
      payload: { tool: "command", summary: "pnpm test --filter domain" },
    },
  ];

  const products: Row[] = empty ? [] : [{ _id: "p1", name: "Zamolxis" }];
  const repositories: Row[] = empty ? [] : [{ _id: "rp1", name: "zamolxis" }];

  const scenario: Scenario = {
    query(name, args) {
      switch (name) {
        case "profiles:viewer":
          return { userId: "u1", email: "owner@example.com", accessStatus: "allowed" };
        case "workstations:listMine":
          return workstations;
        case "onboarding:progress":
          return empty
            ? {
                complete: false,
                steps: [
                  {
                    id: "signin",
                    title: "Sign in",
                    state: "done",
                    detail: "Signed in with Google.",
                  },
                  { id: "access", title: "Get access", state: "done", detail: "Access granted." },
                  {
                    id: "pair",
                    title: "Pair a Mac",
                    state: "needs_you",
                    detail: "Run `pnpm zamolxis setup` on your Mac.",
                  },
                  {
                    id: "repo",
                    title: "Add a repository",
                    state: "upcoming",
                    detail: "Setup lists your repositories.",
                  },
                  {
                    id: "first",
                    title: "First session",
                    state: "upcoming",
                    detail: "Tell Zamolxis what to do.",
                  },
                ],
              }
            : { complete: true, steps: [] };
        case "approvals:listPending":
          return approvals;
        case "approvals:listPendingBySession":
          return approvals.filter((row) => row.workSessionId === args.workSessionId);
        case "orchestrator:conversations":
          return [...conversations].sort(
            (a, b) => (b.lastActivityAt as number) - (a.lastActivityAt as number),
          );
        case "orchestrator:messages": {
          const conversationId = args.conversationId ?? conversations[0]?._id;
          return orchestrator.filter((row) => row.conversationId === conversationId);
        }
        case "supervisor:products":
          return products;
        case "repositories:listByProduct":
          return repositories;
        case "sessions:listMine":
          return args.status ? sessions.filter((row) => row.status === args.status) : sessions;
        case "sessions:get":
          return sessions.find((row) => row._id === args.workSessionId) ?? null;
        case "supervisor:messages":
          return messages[args.workSessionId as string] ?? [];
        case "proof:listForSession":
          return args.workSessionId === "s1" ? proofImages : [];
        case "tasks:listBySession":
          return tasks[args.workSessionId as string] ?? [];
        case "runs:listBySession":
          return runs[args.workSessionId as string] ?? [];
        case "runs:listActive":
          return Object.values(runs)
            .flat()
            .filter((row) =>
              ["queued", "starting", "running", "waiting", "needs_approval", "stopping"].includes(
                row.status as string,
              ),
            )
            .map((row) => ({
              ...row,
              sessionTitle: sessions.find((session) => session._id === row.workSessionId)?.title,
              taskTitle: Object.values(tasks)
                .flat()
                .find((task) => task._id === row.taskId)?.title,
            }));
        case "usage:session":
          return usage(runs[args.workSessionId as string] ?? []);
        case "usage:summary": {
          const all = Object.values(runs).flat();
          return {
            ...usage(all),
            period: args.period,
            sessionCount: Object.keys(runs).length,
            topSessions: Object.entries(runs).map(([id, rows]) => ({
              _id: id,
              title: sessions.find((session) => session._id === id)?.title ?? id,
              status: sessions.find((session) => session._id === id)?.status ?? "completed",
              ...usage(rows).total,
            })),
          };
        }
        case "agentProfiles:list":
          return args.productId ? [] : profiles;
        case "agentProfiles:defaultRuntime":
          return "codex";
        case "agentProfiles:models":
          return empty
            ? []
            : [
                { runtime: "claude", models: MODELS.claude },
                { runtime: "codex", models: MODELS.codex },
              ];
        case "runDetail:get": {
          const row = Object.values(runs)
            .flat()
            .find((candidate) => candidate._id === args.runId);
          if (!row) return null;
          const task = Object.values(tasks)
            .flat()
            .find((candidate) => candidate._id === row.taskId);
          return {
            run: row,
            task: task
              ? {
                  title: task.title,
                  phase: task.phase,
                  status: task.status,
                  repairAttempts: task.repairAttempts ?? 0,
                  repairLimit: 2,
                  requiredModalities: ["static", "behavioral"],
                }
              : null,
            workspace: {
              kind: "worktree",
              status: "in_use",
              baseRef: "main",
              baseSha: row.initialHeadSha ?? "e4c3af024d101a84aab867b6cab3e30b0aab56df",
              branchName: `zam/${row.taskId}`,
              currentHeadSha: row.finalHeadSha ?? row.initialHeadSha,
            },
            verifications: [],
            trustDecisions: [],
          };
        }
        case "runDetail:changedFiles":
          return {
            paths: [
              "packages/domain/src/totals.ts",
              "packages/domain/src/totals.test.ts",
              "README.md",
            ],
            truncated: false,
          };
        case "events:listByRun":
          return args.runId === "r1" ? [...events].reverse() : [];
        case "traces:listByRun":
          return [];
        case "supervisor:log":
          return [];
        case "integration:publication":
          return { ready: true, status: "none", title: "Document the totals rule in the README" };
        case "admin:viewerRole":
          return "admin";
        case "repositories:listLocations":
          return [
            {
              repositoryLocationId: "loc1",
              repositoryName: "zamolxis",
              canonicalPath: "/Users/Shared/projects/zamolxis",
              status: "available",
              github: {
                slug: "bragaru-i/zamolxis",
                tokenUrl:
                  "https://github.com/settings/personal-access-tokens/new?name=Zamolxis+zamolxis&target_name=bragaru-i&expires_in=90&contents=write&pull_requests=write",
              },
              githubAccess: {
                status: "ok",
                source: "gh_account",
                login: "bragaru-i",
                checkedAt: Date.now() - 4 * 60_000,
              },
            },
          ];
        default:
          return undefined;
      }
    },
    async mutate(name, args, bump) {
      switch (name) {
        case "orchestrator:submit": {
          const id = `o${Date.now()}`;
          let conversationId = args.conversationId as string | undefined;
          if (conversationId) {
            const chat = conversations.find((row) => row._id === conversationId);
            if (chat) chat.lastActivityAt = Date.now();
          } else {
            conversationId = `c${Date.now()}`;
            conversations.push({
              _id: conversationId,
              title: String(args.text).split("\n")[0]?.trim().slice(0, 80) || "Zamolxis",
              lastActivityAt: Date.now(),
              createdAt: Date.now(),
            });
          }
          orchestrator.push({
            _id: id,
            conversationId,
            text: args.text,
            reply: "Looking at your sessions…",
            route: "answer",
            status: "thinking",
            createdAt: Date.now(),
            links: [],
          });
          setTimeout(() => {
            const row = orchestrator.find((candidate) => candidate._id === id);
            if (row)
              Object.assign(row, {
                status: "answered",
                answeredBy: "model",
                modelActual: "gpt-6.1-sol",
                totalTokens: 2_400,
                reply:
                  'Nothing changed since the last answer: one Builder and one Verifier are working in "Fix checkout totals and invoice VAT".',
                links: [
                  link({
                    targetType: "session",
                    targetId: "s1",
                    workSessionId: "s1",
                    label: "Fix checkout totals and invoice VAT",
                    status: "running",
                  }),
                ],
              });
            bump();
          }, 1500);
          return { messageId: id, conversationId, route: "answer" };
        }
        case "orchestrator:renameConversation": {
          const chat = conversations.find((row) => row._id === args.conversationId);
          if (chat) chat.title = args.title;
          return null;
        }
        case "orchestrator:archiveConversation": {
          const index = conversations.findIndex((row) => row._id === args.conversationId);
          if (index >= 0) conversations.splice(index, 1);
          return null;
        }
        case "supervisor:submit": {
          const sessionId = (args.sessionId as string) ?? "s1";
          const id = `m${Date.now()}`;
          const thread = messages[sessionId] ?? [];
          messages[sessionId] = thread;
          thread.push({
            _id: id,
            text: args.text,
            productId: args.productId,
            repositoryId: args.repositoryId,
            createdAt: Date.now(),
            planned: false,
            planTaskCount: 0,
            planStatus: "claimed",
            progress: { activity: "Reading the repository", startedAt: Date.now() },
          });
          setTimeout(() => {
            const row = messages[sessionId]?.find((candidate) => candidate._id === id);
            if (row)
              Object.assign(row, {
                planStatus: "completed",
                decision: "answer",
                reply: "Noted. Nothing else is needed from you right now.",
                supervisor: { modelActual: "gpt-6.1-sol", totalTokens: 1_900 },
              });
            bump();
          }, 2000);
          return sessionId;
        }
        case "runs:stop": {
          const row = Object.values(runs)
            .flat()
            .find((candidate) => candidate._id === args.runId);
          if (row) {
            row.status = "stopping";
            setTimeout(() => {
              row.status = "cancelled";
              row.completedAt = Date.now();
              bump();
            }, 1200);
          }
          return null;
        }
        case "sessions:close": {
          const row = sessions.find((candidate) => candidate._id === args.workSessionId);
          if (row) row.status = "completed";
          return null;
        }
        case "sessions:cancel": {
          const row = sessions.find((candidate) => candidate._id === args.workSessionId);
          if (row) row.status = "cancelled";
          for (const run of runs[args.workSessionId as string] ?? []) run.status = "cancelled";
          return null;
        }
        case "approvals:resolve":
          approvals.splice(0, approvals.length);
          return null;
        case "agentProfiles:setRuntimeForAllRoles": {
          if (args.productId) return null;
          for (const role of [
            "orchestrator",
            "supervisor",
            "builder",
            "verifier",
            "repair",
            "integration",
          ]) {
            const own = profiles.find((row) => row.role === role && row.enabled);
            if (own) {
              if (own.runtime !== args.runtime) {
                own.model = undefined;
                own.reasoningEffort = undefined;
              }
              own.runtime = args.runtime;
              own.updatedAt = Date.now();
            } else
              profiles.push({
                _id: `a${role}${Date.now()}`,
                name: `${role[0]?.toUpperCase()}${role.slice(1)} · All products`,
                role,
                runtime: args.runtime,
                enabled: true,
                updatedAt: Date.now(),
              });
          }
          return null;
        }
        case "orchestrator:openProposal": {
          const row = orchestrator.find((candidate) => candidate._id === args.messageId);
          if (row) row.proposalSessionId = "s2";
          return "s2";
        }
        default:
          return null;
      }
    },
  };
  return scenario;
}

export function createScenario(name: string): Scenario {
  return build(name);
}
