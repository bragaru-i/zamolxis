export interface PlannedTask {
  key: string;
  title: string;
  description: string;
  dependencies: string[];
  verificationScripts: string[];
  requiredModalities: string[];
}
export function validatePlan(tasks: PlannedTask[]): void {
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 32)
    throw new Error("INVALID_PLAN");
  const seen = new Set<string>();
  for (const task of tasks) {
    if (
      !/^[a-zA-Z0-9_-]{1,64}$/.test(task.key) ||
      seen.has(task.key) ||
      !task.title.trim() ||
      task.title.length > 200 ||
      !task.description.trim() ||
      task.description.length > 16000 ||
      task.dependencies.length > 32 ||
      new Set(task.dependencies).size !== task.dependencies.length ||
      task.dependencies.some((key) => !seen.has(key)) ||
      task.verificationScripts.length > 16 ||
      new Set(task.verificationScripts).size !== task.verificationScripts.length ||
      task.verificationScripts.some((script) => !/^[a-zA-Z0-9:_-]{1,64}$/.test(script)) ||
      !task.requiredModalities.length ||
      task.requiredModalities.length > 3 ||
      new Set(task.requiredModalities).size !== task.requiredModalities.length ||
      task.requiredModalities.some(
        (modality) => !["static", "test", "behavioral"].includes(modality),
      )
    )
      throw new Error("INVALID_PLAN");
    seen.add(task.key);
  }
}
