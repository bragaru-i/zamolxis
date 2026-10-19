---
name: updating-the-node
description: Use after a merge that changes apps/node or packages, or when a computer's Node runs an old commit. Owns restarting the Node service on the owner's Mac or Linux computer; not deploys of Convex or the web app (CI does those).
---

# Updating the Node

**Invariant:** backend first, Node second; restart the service, never the machine.

CI deploys Convex and Vercel. The Node on each computer keeps its old code until its service restarts on the new checkout. Changes under `apps/web/`, `convex/` or `docs/` need nothing on the computers.

## Process

1. Wait until the deploy run for that commit has finished (`gh run list --workflow deploy.yml --branch main`). A Node started on code the backend does not know exits on its first heartbeat with `Server Error` and crash-loops until the deploy lands.
2. Do it between Sessions: runs in flight resume (Codex `thread/resume`), but an approval held at restart is withdrawn and asked again.
3. On that computer, in its canonical checkout: `pnpm zamolxis update`. It refuses local changes, another branch or a diverged checkout; fast-forwards to `origin/main`; installs from the lockfile; waits for `/api/bootstrap` to report the commit; restarts launchd/systemd and waits for a heartbeat.
4. Manual path on the Mac (`/Users/Shared/projects/zamolxis`):
   ```bash
   node scripts/prod-inspect.mjs data commands 5 type,status   # nothing pending/claimed?
   git checkout -- convex/_generated/api.ts
   git fetch origin main && git merge --ff-only origin/main     # never git pull
   pnpm install --frozen-lockfile
   launchctl kickstart -k gui/$(id -u)/app.zamolxis.node
   ```
   Linux (`~/projects/zamolxis`): same Git steps, then `systemctl --user restart app.zamolxis.node`.
5. Check: `launchctl print gui/$(id -u)/app.zamolxis.node` shows `state = running` (Linux: `systemctl --user is-active`), `node scripts/prod-inspect.mjs data workstations 1 name,status,lastHeartbeatAt` shows a fresh heartbeat, and `~/Library/Application Support/Zamolxis/node-error.log` stops growing within a minute. A few `HEARTBEAT_FAILED` or `NODE_CONTROL_FAILED` lines at the restart are expected.
6. From anywhere: Settings -> Computers shows "macOS · Node <commit>" ("+dirty" with local changes). Older than `git log -1 --format=%h origin/main` means not restarted.

## Gotchas

- `pnpm zamolxis watch` shows what a Node is doing, read-only; `setup --repair` is the health check.
- Linux AppArmor setting and other traps: `docs/agent-runbook.md`, "Pitfalls".

## Pair with

`shipping-a-change`.
