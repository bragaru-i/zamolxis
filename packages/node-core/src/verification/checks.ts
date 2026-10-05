import { execFile } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
export interface CheckEvidence {
  modality: string;
  result: "passed" | "failed";
  summary: string;
}
// Node executes repository-owned scripts, never shell text from Supervisor output.
export async function runVerificationChecks(
  cwd: string,
  scripts: readonly string[],
  required: readonly string[],
): Promise<CheckEvidence[]> {
  const execute = (executable: string, args: string[]) =>
    new Promise<boolean>((resolve) =>
      execFile(executable, args, { cwd, timeout: 120_000, maxBuffer: 256 * 1024 }, (error) =>
        resolve(!error),
      ),
    );
  const staticPass = await execute("git", ["diff", "--check", "HEAD^", "HEAD"]);
  const evidence: CheckEvidence[] = [
    {
      modality: "static",
      result: staticPass ? "passed" : "failed",
      summary: "git diff --check HEAD^ HEAD",
    },
  ];
  let configured: Record<string, unknown> = {};
  let manager = "npm";
  try {
    const path = join(cwd, "package.json");
    if (lstatSync(path).isSymbolicLink()) throw new Error("UNSAFE_PACKAGE_MANIFEST");
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    configured = pkg.scripts ?? {};
    manager =
      typeof pkg.packageManager === "string" && pkg.packageManager.startsWith("pnpm@")
        ? "pnpm"
        : "npm";
  } catch {
    /* Missing manifest is a failed scripted check, not proof. */
  }
  let passed = scripts.length > 0;
  const summaries: string[] = [];
  for (const script of scripts) {
    const ok =
      /^[a-zA-Z0-9:_-]{1,64}$/.test(script) &&
      typeof configured[script] === "string" &&
      (await execute(manager, ["run", script]));
    passed = passed && ok;
    summaries.push(`${manager} run ${script}: ${ok ? "passed" : "failed"}`);
  }
  if (scripts.length && !passed && !required.includes("test"))
    evidence.push({ modality: "test", result: "failed", summary: summaries.join("; ") });
  for (const modality of required.filter((value) => value !== "static"))
    evidence.push({
      modality,
      result:
        passed &&
        scripts.some((script) => /^(?:test(?::|$)|acceptance(?::|$)|e2e(?::|$))/.test(script))
          ? "passed"
          : "failed",
      summary: summaries.length
        ? summaries.join("; ")
        : "No executable acceptance checks configured",
    });
  return evidence;
}
