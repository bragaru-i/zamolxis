import type { RuntimeCapabilitiesDto } from "@zamolxis/contracts";
import type { AgentRuntime } from "./agent-runtime";

export type RuntimeCapability = Exclude<keyof RuntimeCapabilitiesDto, "runtime">;
export class RuntimeRegistry {
  readonly #runtimes = new Map<string, AgentRuntime>();
  register(runtime: AgentRuntime): void {
    if (this.#runtimes.has(runtime.id)) throw new Error("RUNTIME_ALREADY_REGISTERED");
    if (runtime.capabilities().runtime !== runtime.id) throw new Error("RUNTIME_IDENTITY_MISMATCH");
    this.#runtimes.set(runtime.id, runtime);
  }
  get(id: string): AgentRuntime {
    const runtime = this.#runtimes.get(id);
    if (!runtime) throw new Error("RUNTIME_UNAVAILABLE");
    return runtime;
  }
  resolve(
    policy: { readonly mode: "auto" | "preferred" | "forced"; readonly runtime?: string },
    required: readonly RuntimeCapability[],
    isAllowed: (runtime: string) => boolean,
  ): AgentRuntime {
    const eligible = [...this.#runtimes.values()].filter(
      (runtime) =>
        isAllowed(runtime.id) && required.every((capability) => runtime.capabilities()[capability]),
    );
    const preferred = eligible.find((runtime) => runtime.id === policy.runtime);
    const selected = policy.mode === "forced" ? preferred : (preferred ?? eligible[0]);
    if (!selected) throw new Error("RUNTIME_UNAVAILABLE");
    return selected;
  }
}
