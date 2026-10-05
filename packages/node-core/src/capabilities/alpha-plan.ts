import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validatePlan, type PlannedTask } from "@zamolxis/application";
export function planAlpha(text: string, cwd: string): PlannedTask[] {
  let scripts: Record<string, unknown> = {};
  try {
    scripts = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).scripts ?? {};
  } catch {
    /* Non-JS repositories require explicit checks. */
  }
  const defaults = ["lint", "typecheck", "test"].filter(
    (name) => typeof scripts[name] === "string",
  );
  const tasks: PlannedTask[] = text.trim().startsWith("{")
    ? JSON.parse(text).tasks
    : [
        {
          key: "implementation",
          title: text.slice(0, 80),
          description: text,
          dependencies: [],
          verificationScripts: defaults,
          requiredModalities: defaults.includes("test")
            ? ["static", "test"]
            : ["static", "behavioral"],
        },
      ];
  validatePlan(tasks);
  return tasks;
}
