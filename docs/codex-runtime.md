# Codex runtime integration

Issue #20 replaces Fake Runtime with a native adapter behind AgentRuntime. Runtime selection remains separate from model selection; the Node supplies and validates the workspace assignment.

The first component is AppServerClient, a local stdio transport. It launches the configured Codex executable directly (no shell) with `app-server --listen stdio://` in the assigned absolute cwd. It initializes the native client handshake, correlates concurrent responses, and exposes native notifications inside the adapter package. It does not start inference or expose a domain runtime yet.

Frames are capped at 1 MiB and pending requests at 64. Malformed input, child exit, stream errors and request timeouts close the connection and reject outstanding operations. Requests are never automatically replayed: a timed-out launch may have succeeded, so the future adapter must reconcile rather than launch twice. Native error content and stderr are not forwarded, keeping vendor diagnostics and potential secrets out of normalized events.

Server-initiated requests receive an unsupported-operation error. This includes approval, credentials and tool requests: the transport cannot authorize them. A future Node approval bridge must enforce workstation policy; it must not silently approve native operations. The transport alone is not a sandbox or a policy implementation.

Protocol baseline: installed codex-cli 0.160.0 and its generated TypeScript schema; verified against the [official app-server documentation](https://learn.chatgpt.com/docs/app-server). Generate version-matching bindings with `codex app-server generate-ts --out <scratch-directory>` when updating the adapter. Generated vendor files are development references, not domain contracts.

Remaining #20 work: workspace-bound thread start/resume, native session persistence/reconciliation, normalized activity/tool/file/terminal events, steering, deterministic stop, shared adapter contract tests and a controlled native execution smoke test. Keep #20 open until those acceptance criteria pass. No live inference was performed for this transport component.
