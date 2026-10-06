// Preview harness (dev only): in-memory stand-in for the Convex backend so the real
// web app can be opened in a browser, or driven by Playwright, without sign-in or a
// deployment. Enabled by `ZAMOLXIS_PREVIEW=1 pnpm --filter @zamolxis/web dev`, which
// aliases `convex/react` and `@convex-dev/auth/react` to the modules next to this file.
// Never bundled in production: the alias exists only when the variable is set.
import { createScenario, type Scenario, scenarioNames } from "./fixtures";

type Listener = () => void;
const listeners = new Set<Listener>();
let scenario: Scenario | undefined;
let version = 1;
const cache = new Map<string, { version: number; value: unknown }>();

function current(): Scenario {
  if (!scenario) {
    const requested =
      typeof location === "undefined" ? null : new URL(location.href).searchParams.get("scenario");
    const known = (scenarioNames as readonly string[]).includes(requested ?? "");
    scenario = createScenario(known && requested ? requested : "owner");
  }
  return scenario;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function getVersion(): number {
  return version;
}
export function bump(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function key(name: string, args: unknown): string {
  return `${name}:${JSON.stringify(args ?? null)}`;
}

/** Resolves a query against the scenario; results are stable until the store changes. */
export function readQuery(name: string, args: unknown): unknown {
  const id = key(name, args);
  const cached = cache.get(id);
  if (cached && cached.version === version) return cached.value;
  const value = current().query(name, (args ?? {}) as Record<string, unknown>);
  cache.set(id, { version, value });
  return value;
}

export function readPage(name: string, args: unknown): unknown[] {
  const page = readQuery(name, args);
  return Array.isArray(page) ? page : [];
}

export async function runMutation(name: string, args: unknown): Promise<unknown> {
  const result = await current().mutate(name, (args ?? {}) as Record<string, unknown>, bump);
  bump();
  return result;
}
