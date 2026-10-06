import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { codexEnv } from "@zamolxis/runtime-codex";

type Exec = (file: string, args: readonly string[]) => string;
const exec: Exec = (file, args) =>
  execFileSync(file, [...args], {
    encoding: "utf8",
    timeout: 10_000,
    env: codexEnv(),
    stdio: ["ignore", "pipe", "ignore"],
  });

/** Finds a runnable Codex CLI without assuming npm installed it on PATH. */
export function findCodex(
  run: Exec = exec,
  candidates: readonly string[] = ["codex", join(homedir(), ".local", "bin", "codex")],
): { executable: string; version: string } | undefined {
  for (const executable of candidates) {
    if (executable.includes("/") && !existsSync(executable)) continue;
    try {
      const version = run(executable, ["--version"]).trim().split("\n")[0]?.trim();
      if (version) return { executable, version: version.slice(0, 128) };
    } catch {
      /* not this one */
    }
  }
  return undefined;
}

/** Codex is usable only with an existing user login; setup never starts a login flow. */
export function codexSignedIn(executable: string, run: Exec = exec): boolean {
  try {
    run(executable, ["login", "status"]);
    return true;
  } catch {
    return false;
  }
}
