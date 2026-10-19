# Zamolxis glossary

Definitions only: no plans, no implementation. One name per concept; the owner's
words (what the app shows) follow in quotes. A new term lands here when a decision
settles it; challenge work that contradicts an entry. The Node gives this file to
agents, so keep it short.

## Where work lives

- **Owner:** the signed-in person. Ownership comes from Google sign-in; access is
  granted in the database. Never inferred from a Node.
- **Product:** an owner's project, grouping its repositories. "Project" in the app.
- **Repository:** one Git repository. A **repository location** is its checkout on
  one computer, granted at setup. The checkout itself (the canonical checkout) is
  never an agent's workspace.
- **Node:** the Zamolxis service on the owner's computer (`apps/node`). It runs
  agents and Git; it is authorized separately from the owner. "Computer" or "Mac".
- **Chat:** an owner-level conversation on Home with the Orchestrator. It never
  starts work by itself. Deleting hides it and keeps any Work Session it opened.
- **Work Session:** one piece of owner-requested work on a repository, with its own
  conversation, tasks and runs. Sessions never move to another computer.
- **Proposal:** a plan or change request shown to the owner, inert until the owner
  opens it. "Open this work" (in a Session) or "Open Work Session and start
  planning" (from a Chat).
- **Task:** one unit of a validated plan: title, description naming the files to
  change and read first, acceptance points and dependencies (acyclic).
- **Workspace:** a separate Git worktree for one run, owned by the Node.

## Who does the work

A **role** is a job in the work; its owner-facing label is in quotes.

- **Orchestrator:** answers in Chat ("Chat with you"). No repository, read-only.
- **Supervisor:** reads the repository at an exact SHA and answers, asks, proposes
  or delegates ("Plan the work"). Also called the planner; prefer Supervisor in code.
  It proposes; the backend authorizes.
- **Builder:** makes one task's change in its own workspace ("Write the code").
- **Verifier:** checks a candidate independently ("Check it"), in its own workspace
  at the exact candidate SHA, with the acceptance points and public failure
  evidence only, never the Builder's reasoning. "Checker" means the same; prefer
  Verifier in code. **Checks only:** a Verifier that runs the repository checks
  without a model.
- **Repair:** fixes what the Verifier found ("Fix failures"). At most two repairs
  per task in Alpha; history is kept.
- **Runtime:** what drives a model (Codex, Claude, local model, Codex with a local
  model). Distinct from the **model** itself.
- **Agent run:** one runtime session for one role. Actual model, tokens and cost are
  stored only when the provider reports them.

## How agents are chosen

- **Agent:** in "My agents", a named chain of one to three models: the first one
  the computer can start is used; the rest are **backups**. No automatic switch when
  a running agent fails (owner, 2026-10-07).
- **Profile:** a role's settings (agent chain, instructions, approvals, limits),
  snapshotted on every run.
- **Workflow:** a set of profiles, one per role. Order when work starts: chosen ->
  project on that computer -> computer -> Default. **Presets:** Save tokens,
  Balanced, Max quality, Codex only, Local first.

## Trust

- **Candidate:** a Builder's or Repair's finished commit. A candidate is never
  trusted because the agent says it is done.
- **Evidence:** SHA-bound results: repository checks with exit codes, and the
  Verifier's acceptance verdicts (a point not met blocks; "cannot judge" never does).
- **Trust decision:** deterministic, from the evidence, for one exact SHA.
- **Integration:** a local branch prepared from a trusted SHA only.
- **Publish:** the owner's "Open pull request": push the trusted commit as
  `zamolxis/<task>-<sha7>` and open a PR. Nothing merges automatically.
- **Approval:** an agent's request to do something risky, held for the owner
  (Approve, Approve for run, Reject). Verifier, Supervisor and credential requests
  are always refused.
