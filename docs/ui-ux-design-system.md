# UI/UX & Design System Contract

Zamolxis is **conversation-first**. The primary experience should feel immediately familiar to users of modern AI chat/coding applications: prompt, response, live work, follow-up.

Infrastructure complexity is progressive disclosure, not the default screen.

## Primary mental model

```text
                    SESSION
+---------------------------------------------------+
| context / title / status                          |
+---------------------------------------------------+
|                                                   |
| conversation                                      |
|                                                   |
| User                                              |
| Build the reporting dashboard                     |
|                                                   |
| Zamolxis                                          |
| I split this into API and UI work.                |
|                                                   |
|  [ API implementation       Running ]             |
|  [ UI implementation        Running ]             |
|                                                   |
| Agent activity / results appear inline            |
|                                                   |
+---------------------------------------------------+
| + attachment     Ask / steer...          Send     |
+---------------------------------------------------+
```

A user should not need to understand Workstations, Workspaces, Runs, adapters or Git worktrees to ask Zamolxis to do work.

## Desktop shell

```text
+-----------------------------------------------------------------------+
| Sidebar       | Conversation / Session                   | Inspector  |
|               |                                          |            |
| New session   | user + assistant messages                | Tasks      |
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
| < Sessions     Title      ... |
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

Conversation is the user-facing representation of a Work Session.

Supported blocks include user message, Supervisor message, plan, task group, Agent Run card, approval request, result summary, changed-files summary, error/recovery state, artifact and compact activity group.

Raw low-level events belong in Activity detail, not as thousands of chat messages.

## Composer

Composer is a first-class product component, not a plain textarea. It supports multiline prompt, Send, attachment/context affordance, optional runtime override, current Session context, Stop while executing, mobile keyboard/safe-area behavior and future slash commands.

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

A first-time user on a phone can open Zamolxis, start/open a Session, type a normal-language request, understand what work started, inspect a running agent if desired, steer it, respond to an approval and understand completion without learning infrastructure terminology.
