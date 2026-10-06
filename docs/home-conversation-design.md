# Home conversation and Work Session navigation

**Owner review draft — proposed, not implemented.** Based on executable repository
SHA `1f2407fa3c232a1dfd6e18093f3c3dccc6acb455` (2026-10-06). Approval of this
artifact precedes implementation. No application, schema or runtime changes are
included. The assigned worktree was clean and at the supplied SHA; local
`origin/main` matches it. Remote PR/review/CI state was not verified, and this
artifact makes no integration or deployment claim.

## Decision to approve

Home is the owner's durable Orchestrator conversation. Work Sessions are secondary
navigation in a desktop sidebar and a collapsible mobile drawer. Sending a Home
message can answer, clarify or propose; it never creates a Work Session, Task or
execution Run, even when the text says “do it”, “continue” or contains a structured
plan. Opening work requires a separate, explicit owner action with a named target.
Read-only Orchestrator replies can still use the configured model and tokens.

Hiding is an owner visibility preference, independent of lifecycle. Hidden work
continues normally and remains reachable through links and attention alerts.
Neither hide nor restore authorizes execution, acknowledges a blocker, closes a
session, cancels a Task, releases capacity or changes retention eligibility.

## Desktop layout

Proposed breakpoint: sidebar at widths of 1024 px and above; drawer below that.
Sidebar approximately 300 px; conversation fills remaining space, with readable
message width capped around 800 px. Reuse shared UI tokens and status language.

```text
┌──────────────────────────────┬─────────────────────────────────────────────┐
│ Zamolxis                     │ Home · Orchestrator       Mac online Settings│
│ Home                         │ Needs your attention · 3 (1 hidden) [Review]│
│ Work Sessions                ├─────────────────────────────────────────────┤
│ [+ New Work Session]         │ You: What needs my attention?              │
│ [Search sessions…          ] │ Zamolxis: … [Open existing session]         │
│ All Active Waiting Completed │                                             │
│ Hidden (4)                   │ Proposal · Nothing started                  │
│                              │ Goal / scope / proposed tasks               │
│ Fix sign-in    Waiting · !   │ [Review proposal]                           │
│ Search         Active        │                                             │
│ Docs           Completed     ├─────────────────────────────────────────────┤
│ [Show older sessions]        │ Context: Product / Repository               │
│                              │ [Ask Zamolxis…                         Send]│
│                              │ Sending a message does not start work.      │
└──────────────────────────────┴─────────────────────────────────────────────┘
```

Conversation and composer are the primary area; session rows never appear below
the transcript. Sidebar and transcript scroll independently. The composer stays
at the bottom of the main pane, not across the sidebar. Loading and onboarding
must not displace the composer; show a compact setup notice with an expandable
checklist. Existing settings and pairing flows remain reachable.

Selecting an existing row opens its Work Session in the main pane with title,
status, tasks, approvals and Run detail. Keep the sidebar available and mark the
selection. Home returns to the Orchestrator with its scroll position and unsent
draft preserved. Navigation is observation; it never reopens an ended session.

## Mobile layout

```text
Closed drawer                         Open drawer
┌─────────────────────────────┐       ┌─────────────────────────────┐
│ [Sessions !3] Home  Settings │       │ Work Sessions       [Close] │
│ Attention 3 · 1 hidden [View]│       │ Home                        │
├─────────────────────────────┤       │ [+ New Work Session]        │
│ Orchestrator conversation   │       │ [Search sessions…          ]│
│                             │       │ All Active Waiting Completed│
│ Proposal · Nothing started  │       │ Hidden (4)                  │
│ [Review proposal]           │       │ Fix sign-in  Waiting · !    │
│                             │       │ Search       Active         │
├─────────────────────────────┤       │ Docs         Completed      │
│ Context: Product / Repo     │       │ [Show older sessions]       │
│ [Ask Zamolxis…        Send]  │       └─────────────────────────────┘
└─────────────────────────────┘
```

Drawer is closed by default and opens from a labelled header button, with no
gesture required. Use a modal navigation sheet, full-height on narrow phones,
with scrollable contents and wrapped filter controls. Closing by Close, Escape
or backdrop restores focus to the trigger. Trap focus while open, make background
inert, and use `aria-expanded`/`aria-controls` on the trigger. Selecting a row
closes the drawer and opens the session; going back returns to Home. Search and
filter state survive drawer closure. The attention count remains in the header
when the drawer is closed, including while viewing a session.

Composer respects keyboard viewport and iOS safe areas; no horizontal page
scroll at 320 px. Touch targets are at least 44 px. Do not force-scroll a reader
away from older messages; show a “New messages” affordance instead. Announce
message and visibility outcomes politely without re-announcing the transcript.

## Session discovery

Default is **All** visible sessions, ordered by last work activity descending,
then ID for stable pagination. Each row shows title, Product/repository context,
plain-language lifecycle label, task progress, activity time, attention reason
when present and a separately focusable actions menu. Do not nest menu buttons
inside the row's navigation button.

| Control | Proposed scope and meaning |
| --- | --- |
| All | Every non-hidden session, including failed and cancelled |
| Active | `planning`, `running`; also any session with live/queued/uncertain owned work despite a stale aggregate status |
| Waiting | `waiting` (shown as Idle where appropriate), `needs_input`, or unresolved attention; may overlap Active |
| Completed | Exactly `completed`; failed/cancelled remain in All with their actual labels |
| Hidden | Hidden sessions of every lifecycle; explicit visibility view with a hidden count |
| Search | Server-side title and goal search, with Product/repository context displayed; applied to selected view across all pages |

Hidden is a separate view, not a lifecycle status. Entering Hidden resets the
status filter to All; returning restores the previous visible filter and query.
Search preserves the selected scope and offers “Search Hidden” when hidden
matches exist. Empty-query search returns the ordinary ordered list. Counts and
results must reflect the full authorized dataset, never just loaded rows.
Changing search/filter resets the pagination cursor. Keep load-more and query
errors explicit, with retry and the draft preserved.

## Hide and restore

1. Owner selects row menu → **Hide from session list**, or the same action in a
   session header menu. Helper copy: “This only hides the session from your list.
   Work keeps running, and attention alerts remain visible.”
2. Persist the preference on the server for this authenticated owner. No lifecycle
   confirmation dialog is needed for this reversible action. Until it succeeds,
   keep the row and disable the duplicate action; failure keeps it visible with
   an inline retry. Success removes it from visible views and announces
   “Session hidden. Work continues.” with **Undo**.
3. If already viewing it, keep the session open and show **Hidden · Restore**.
   Its URL remains valid. Opening a hidden session from any link does not restore
   it automatically. Hide while it needs attention leaves the alert intact.
4. In Hidden, row menu → **Restore to session list**, or use the open session's
   Restore button. Success clears hiding and announces restoration. It appears
   in whichever visible filters match its current state, at its original activity
   position; restoring does not change work activity time. Offer **View in All**
   if it would be absent from the previously selected filter.

Close session and Stop work remain separate lifecycle controls with their
existing authorization/confirmation policy. Never use close/cancel as a shortcut
for hiding. Undo is the same idempotent restore mutation. Cross-device changes
update reactively; retries and concurrent hide/restore must settle to a server
revision rather than overwrite a later preference with a stale retry.

## Attention remains discoverable

Home's compact **Needs your attention** strip and mobile header count are outside
all session filters and search. They include hidden sessions. Clicking Review
opens an attention inbox with pagination, independent of recent-session limits.
Count distinct sessions and show item counts separately so multiple approvals
in one session are understandable. Every item includes session title, context,
reason, age, **Hidden** when applicable and **Open session**. Hidden items also
offer Restore, never require restoration to review or act.

Include pending approvals, `needs_input`, exhausted repair/conflict blockers,
lost or uncertain Runs requiring reconciliation, and actionable publication
failures. Backend state determines whether an item is unresolved; ordinary Idle
and completed work do not automatically require attention. Sort approvals by
nearest expiry first, then other blockers by oldest unresolved time. Expired or
already resolved requests update in place and cannot be approved from stale UI.
Preserve existing risk labels, critical approval second tap and owner-only
resolution. Opening, hiding or restoring never resolves an attention item.

For example, a hidden running session receives an approval: its Hidden row gains
the reason, the global count increases, and the attention inbox offers review.
It stays hidden after approval and continues work. A hidden session with an
exhausted repair remains listed in attention until the blocker is resolved.
Conversation links are useful navigation but their status is a historical
snapshot; the reactive inbox and session detail are authoritative. Do not depend
on the Orchestrator's five-most-recent-session summary to find old blockers.

## Chat, proposal review and opening work

| Owner action | What happens | Execution consequence |
| --- | --- | --- |
| Send Home message | Save chat; answer, clarify or return an inert proposal | No Session, Task, workspace provisioning or execution Run |
| Review proposal | Open a review panel with goal, scope, proposed tasks, constraints and repository selection | No work starts |
| New Work Session | Open a draft form: title/goal, Product, repository, request | No server Session until explicit confirmation |
| Open existing session / linked Run | Navigate to saved detail at `?session=…` / `?run=…` | No lifecycle change |
| Open Work Session and start planning | Submit the reviewed request after displaying target and effect | Create Session and request SHA-bound Supervisor planning; authorized delegation can then start execution |
| Add work to selected session | Review names the existing target, then explicitly confirm | Backend validates reuse/reopen and delegates only the approved request |

Proposal card copy is **Proposal · Nothing started**, with **Review proposal**.
Review shows the full request that will be submitted, including owner edits;
missing context must be chosen there rather than asking the owner to resend chat.
Final button is **Open Work Session and start planning**, with explanation:
“This opens work in [Product / repository]. Planning may start agents after the
backend validates the plan.” Cancel retains the proposal and creates nothing.
A double tap/retry opens exactly one Session. After success replace the final
action with **View Work Session**, link the originating message, and navigate to
the session. Planning/queue failures appear in that session with the saved request.

For “continue” or “do it” in chat, suggest reviewing work for an explicitly named
session; never infer authorization from a recent link. Review defaults to New
unless the owner deliberately selects a valid existing target. An ended target
must state whether it will reopen or create a new session before confirmation.
Existing Session conversation needs the same distinction: ordinary Send answers
or proposes, and adding executable work requires the explicit reviewed action.
Keep “Message agent” steering as a separately labelled action targeting an
existing Run; it must not be confused with Home chat or create new work silently.

## Empty and exceptional states

| State | Copy / action |
| --- | --- |
| No conversation | “Ask a question or explore an idea. Messages do not start work.” Example prompts ask about status or planning; composer remains available |
| No sessions | “No Work Sessions yet.” **New Work Session**; chat remains useful |
| All sessions hidden | “No visible sessions.” **View Hidden (N)** and **New Work Session** |
| No Active / Waiting / Completed | “No [active / waiting / completed] sessions.” **Show All** |
| Hidden empty | “No hidden sessions. Sessions you hide will appear here.” **Show All** |
| Search empty | “No matches in [view].” **Clear search**; **Search Hidden** if relevant |
| Attention empty | “Nothing needs your attention.” Do not claim nothing is running |
| No paired Mac / repository | Expandable setup checklist; questions available; work confirmation explains missing setup and links to setup |
| Mac offline | Chat can use deterministic replies; review available; opening work explicitly explains it will queue until a compatible Mac is online |
| Loading / query failure | Skeleton or labelled loading, then retry; never render an empty-success message while data is unknown |
| Hidden deep link | Full session detail with Hidden label and Restore; no automatic reopening |
| Inaccessible / removed target | “This session isn't available.” **Home**; expose no other owner's metadata |

## Existing implementation map

Paths below are relative to this repository; these are inspection references,
not proposed code already delivered.

| Path | Existing behavior / later design touchpoint |
| --- | --- |
| `apps/web/app/page.tsx` | Home entry and authenticated access gate; preserve access boundary |
| `apps/web/app/features/workspace.tsx` | Home/Session switching, Settings, Mac indicator, pairing; persistent navigation shell |
| `apps/web/app/features/sessions.tsx` | `SessionList`, internal `OrchestratorConversation`, `OrchestratorComposer`, `OpenProposal`, typed links; split navigation from conversation and add review flow |
| `apps/web/app/features/session-view.tsx` | Session composer, task/run views, close/stop, proposal actions; eliminate Send-triggered work/reopening ambiguity |
| `apps/web/app/features/conversation.ts` | Supervisor reply states and ended-session behavior |
| `apps/web/app/features/use-location.ts` | URL navigation and browser history; preserve session/run deep links |
| `apps/web/app/features/approvals.tsx` | Approval cards and inbox currently showing at most three cards; extend discoverability without weakening approval rules |
| `apps/web/app/features/onboarding.tsx` | Backend-derived setup checklist |
| `apps/web/app/features/run-detail.tsx`, `steer.tsx`, `publish.tsx` | Existing targeted actions and evidence; preserve explicit action boundaries |
| `packages/ui/src/index.tsx`, `styles.css` | AppShell, Composer, Sheet, Picker, status labels and responsive/safe-area styles |
| `convex/sessions.ts`, `schema.ts` | Owner session pagination/get/create/close/cancel; no hiding field or search API today |
| `convex/orchestrator.ts`, `lib/orchestration.ts` | Home submit currently recognizes execution language and routes to create/continue; proposals already have owner-only `openProposal` |
| `convex/supervisor.ts`, `lib/lifecycle.ts`, `lib/settlement.ts` | Session submission, proposal authorization and lifecycle aggregates |
| `convex/approvals.ts`, `runs.ts`, `tasks.ts`, `integration.ts` | Canonical approval, reconciliation, blocker and publication state |

Existing UI regression tests live beside `sessions.tsx`, `workspace.tsx` and
`session-view.tsx`; routing coverage includes `tests/orchestrator-conversation.test.ts`
and `tests/supervisor-conversation.test.ts`. Owner isolation belongs in
`convex/access.test.ts` as well as mutation/query tests.

## Backend work required later

1. Add owner-scoped visibility metadata (proposed `ownerHiddenAt` and visibility
   revision on the already owner-bound `workSessions` row; absent means visible).
   Owner-only idempotent hide/restore validates `ownSession`; no commands, events
   that imply work activity, lifecycle/count edits or retention changes. Plan
   migration/backfill and indexes before enabling filtered pagination.
2. Extend list/search with visibility, grouped filter, stable pagination and counts.
   Search must use an owner-isolated indexed strategy over title/goal, with defined
   case-insensitive token matching; avoid filtering a loaded page or scanning all
   historical sessions. Materialize a discovery projection if needed for grouped
   status/attention predicates. Existing `listMine` only filters one raw status.
3. Provide indexed owner-wide attention queries and live counts, including hidden
   and older sessions. Persist/update a bounded projection transactionally with
   approval, blocker and reconciliation changes; paginate items instead of relying
   on `.take()` truncation. Define repair/publication attention resolution from
   canonical state, not a model's reply. No visibility predicate in this query.
4. Change Home `orchestrator.submit` to chat-only server-side. Execution-looking
   text must not call `submitText`; model/legacy output cannot authorize work.
   Extend explicit proposal/manual-opening APIs with reviewed request, chosen
   Product/repository, optional deliberate existing target, owner authorization
   and persistent idempotency. Never trust a client mode flag alone. Preserve
   historical create/continue messages and links without replaying them.
5. Audit `supervisor.submit`, structured-plan shortcuts and proposal opening so
   ordinary Session chat cannot silently delegate or reopen/create work. Separate
   read-only conversation from authenticated explicit execution authorization.
   Review edited proposals again through SHA-bound context, validated DAG and
   backend dispatch; review is not trust or acceptance of a future candidate.
6. Keep independent verification, repair limits, exact-SHA trust, capacity and
   human publishing/merge policy intact. New API modules need registration in
   the repository-maintained `convex/_generated/api.ts` if introduced.

## Evidence, documentation and later acceptance

Inspected `AGENTS.md`, `README.md`, `docs/alpha-status.md`,
`docs/agent-runbook.md`, relevant UI/backend sources and CI. Sibling
`zamolxis-docs` README, `docs/realtime-ui.md` and `docs/session-model.md` still
describe session-first Home and automatic language-based routing; they are older
architecture references, not evidence of shipped redesign. Implementation should
synchronize those references in an authorized documentation change. This task
does not modify that checkout. Current README/Alpha language describes the actual
execution-language routing; update it only when the new boundary is implemented.

Later acceptance must prove: every Home Send (including “do it” and structured
plans) creates no work; proposal review/cancel is inert; explicit open is
owner-authorized and retry-safe; hidden active work keeps running and capacity
reserved; hide/restore leaves lifecycle, canonical Git state and retention
unchanged; other owners cannot discover or alter sessions; older hidden blockers
are found despite pagination/filter/search; stale approvals cannot resolve;
deep links/history and independent drafts survive navigation; filters cover
failed/cancelled and overlapping active attention correctly.

Validate desktop sidebar and mobile drawer at 320/390/768/1024/1440 px, keyboard
and screen-reader navigation, real iPhone keyboard/safe areas/home-screen mode,
offline/reconnection and cross-device visibility. For later implementation run
repository `pnpm check` and applicable authenticated native acceptance per the
runbook. This documentation-only artifact is checked with `git diff --check`;
application tests or a build would not validate these proposed interactions.

## Owner approval record

**Pending. No implementation authorized by this artifact.** Approve or revise:

- Conversation-first Home and the sidebar/drawer layout.
- Separate proposal review and explicit work confirmation, including removing
  execution-by-chat behavior from Home and ordinary Session conversation.
- Visibility-only hide/restore with global attention discoverability for hidden work.
- Filter mapping (Waiting includes Idle; Completed excludes failed/cancelled),
  search scope and the separate Hidden view.
- Backend contracts and acceptance scope above before implementation begins.
