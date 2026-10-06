# UI/UX & Design System Contract

Zamolxis is **conversation-first**. The primary experience should feel immediately familiar to users of modern AI chat/coding applications: prompt, response, live work, follow-up.

Infrastructure complexity is progressive disclosure, not the default screen.

## Primary mental model

```text
              ORCHESTRATOR CONVERSATION
+---------------------------------------------------+
| product context / linked work                     |
+---------------------------------------------------+
|                                                   |
| conversation                                      |
|                                                   |
| User                                              |
| What is happening with ticket ABC-123?            |
|                                                   |
| Zamolxis                                          |
| The API fix passed verification. The UI task is   |
| waiting for approval.                             |
|                                                   |
|  [ Open Work Session ] [ Open waiting Agent ]     |
|                                                   |
| User                                              |
| Fix the UI issue and continue.                    |
|                                                   |
| Zamolxis                                          |
| I continued the existing Session with Builder X.  |
|                                                   |
+---------------------------------------------------+
| + attachment     Ask Zamolxis...         Send     |
+---------------------------------------------------+
```

A user should not need to create a Work Session before asking Zamolxis a question. The
Orchestrator decides whether to answer from durable state, link existing work, continue a
Session, or create one for new execution. Workstations, Workspaces, Runs, adapters and Git
worktrees remain progressive disclosure.

## Desktop shell

```text
+-----------------------------------------------------------------------+
| Sidebar       | Conversation / Session                   | Inspector  |
|               |                                          |            |
| New chat      | Orchestrator conversation                | Linked work|
| My Work       |                                          | Agents     |
| Needs You     | inline run/task cards                    | Activity   |
| Recent        |                                          | Changes    |
|               |                                          | Context    |
| Workstations  |                                          |            |
| Settings      |                                          |            |
|               |------------------------------------------|            |
|               | Composer                                 |            |
+-----------------------------------------------------------------------+
```

Conversation owns the largest visual area. Composer is persistent. Inspector is secondary/collapsible. Sidebar is navigation, not an infrastructure dashboard. Task/Run cards may appear inline.

## Mobile shell

```text
+-------------------------------+
| < Chats        Zamolxis   ... |
+-------------------------------+
|                               |
| Conversation                  |
|                               |
| inline task/run cards         |
|                               |
+-------------------------------+
| Ask / steer...          Send  |
+-------------------------------+
```

Tasks, Agents, Activity, Changes and Context open as Sheet/Drawer views. Primary controls remain usable one-handed: Send, Steer, Stop, Approve/Reject and current activity.

Do not reproduce a three-column desktop dashboard on a phone.

## Conversation model

> **Breaking architecture boundary:** the home conversation is not a Work Session. UI mocks,
> routes and copy must not use “New session” or **Start** as the default chat entry point.

The primary conversation is a durable Orchestrator conversation owned by the user. It exists
outside Work Sessions. A normal question, status request, explanation or summary stays in this
conversation and creates no Work Session, Task or Agent Run.

The Orchestrator can render linked cards for an existing Work Session, Task, Agent Run, approval,
verification result, pull request or external ticket. Opening a card navigates to its detail. A
Work Session has its own focused conversation and activity after the Orchestrator creates or
reuses it for execution.

Supported blocks include user message, Orchestrator answer, proposal, routing decision, linked
ticket/Session/Task/Agent Run, approval request, result summary, changed-files summary, error or
recovery state, artifact and compact activity group.

Raw low-level events belong in Activity detail, not as thousands of chat messages.

## Composer

Composer is a first-class product component, not a plain textarea. The home composer sends to the
Orchestrator and says **Send**, never **Start**. It supports multiline prompts, attachments,
optional Product/repository context and future slash commands. A Session composer adds current
Session context, steering and Stop while executing.

Default interaction stays simple: type and send.

## Progressive disclosure

```text
Level 1 — Conversation
  What did I ask? What is Zamolxis doing? Does it need me?

Level 2 — Work
  Tasks, Runs, agents, progress, changed files.

Level 3 — Diagnostics
  Workstation, Workspace, native session, command/event history,
  Git state, runtime capabilities.
```

Never force Level 3 concepts into Level 1 UI.

## Design System is mandatory

All product UI uses the Zamolxis Design System from `packages/ui`.

Do not invent one-off colors, spacing, radii, typography or shadows inside feature components.

### Token groups

```text
Color
  background / foreground
  surface / surface-muted
  card / popover
  border / input / ring
  primary / secondary
  success / warning / danger / info
  agent-running / agent-waiting / needs-attention

Typography
  font-sans / font-mono
  shared type scale, line heights, weights and tracking

Spacing
  shared finite spacing scale

Radius
  sm / md / lg / xl / full

Elevation
  none / subtle / overlay

Layout
  sidebar widths / inspector widths / content max width
  composer max width / mobile safe-area values

Motion
  fast / normal / slow / easing tokens
```

Use semantic CSS variables. Feature code must not carry arbitrary palette values.

## Typography

Typography is centralized. Use a deliberate sans family for product UI and mono only for code/terminal/Git/native identifiers.

Conversation markdown uses one shared chat typeset/rhythm. Do not style Markdown independently in every message component.

## Spacing and density

Use a finite spacing scale. Avoid arbitrary pixel padding values in feature code without a documented reason.

Zamolxis is information-dense but calm: compact navigation, comfortable conversation reading, tighter diagnostic panels, consistent card padding and row heights.

## Borders, radius and elevation

One radius family makes buttons, composer, cards, sheets and graph nodes feel related. Prefer subtle borders/surface contrast over excessive shadows. Status is never communicated by color alone.

## Component ownership

```text
packages/ui/
  primitives/
  tokens/
  typography/
  layout/
  conversation/
  sessions/
  tasks/
  runs/
  activity/
  approvals/
  graph/
```

`apps/web/features` composes these components with product data/behavior. It does not recreate their visual styling.

## Component variants

Variants are explicit and finite.

Good: `<StatusBadge status="running" />`

Bad: a generic Badge with arbitrary hard-coded background, padding and radius classes.

## Accessibility

Design-system primitives preserve keyboard navigation, visible focus, semantic labels, sufficient contrast, reduced-motion preference, screen-reader status text and touch target sizing.

## Responsive rule

Responsive behavior is designed at component level, not repaired at page level. Every major component defines desktop, narrow/tablet and phone behavior.

## Graph consistency

React Flow UI is allowed because it is built using shadcn/Tailwind and its code is owned/customizable. Graph nodes use the same Zamolxis tokens and semantic components.

## Enforcement

Frontend review/CI should reject arbitrary hard-coded palette colors, arbitrary pixel padding/radius when a token exists, feature-local copies of shared primitives, direct third-party styling that bypasses `packages/ui`, competing general-purpose design systems and desktop-only primary interactions.

## UX acceptance test

A first-time user on a phone can open Zamolxis and ask a normal-language question without creating
work. The reply summarizes current state and links relevant tickets, Sessions and Agents. An
explicit execution request creates or continues the appropriate Session; the user can then inspect
a running agent, steer it, respond to an approval and understand deterministic completion without
learning infrastructure terminology.
