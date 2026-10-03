# Runtime adapter contract v0.1

Runtime selection is separate from model selection. An AgentRuntime advertises capabilities and implements start/resume/send/stop/inspect plus normalized event subscription. Workspace assignment comes from the Node; runtimes cannot choose repository paths.

RuntimeRegistry chooses only allowed adapters satisfying required capabilities. Forced selection never falls back; preferred selection may use another eligible adapter. Domain/application code does not branch on vendor names.

FakeRuntime is an in-memory deterministic adapter with configurable activity, waiting, success and failure steps. A waiting scenario continues on message/resume, and stop is idempotent. Repeated start for the same Run returns the same session; conflicting workspace assignment or instruction is rejected. Snapshots are defensive copies and replay uses stable ordered event IDs.

The fake does not execute shell commands or mutate files. Its assigned cwd is metadata validated by the Node's Workspace Manager before runtime launch. In-memory fake sessions cannot survive a Node process restart; reconciliation must mark an unrecoverable session lost rather than silently start it again.

`@zamolxis/test-kit/runtime-contract` exports `defineRuntimeAdapterContract` for future Codex/Claude/Hermes adapters. Each adapter supplies a controlled factory and a workspace-bound input. The suite checks advertised identity, assignment preservation, idempotent starts, event provenance/replay and rejection of changed workspace assignment. Adapter-specific tests cover waiting/message/resume/stop semantics.
