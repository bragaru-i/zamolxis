import { githubTokenCli, prerequisites, setup } from "./setup";
import { update } from "./update";

const USAGE =
  "Usage: pnpm zamolxis setup [--repair] | update | doctor | github-token [owner/repo] [--remove]";
const [command, ...flags] = process.argv.slice(2);
try {
  if (command === "setup" && flags.every((flag) => flag === "--repair"))
    await setup({ repair: flags.includes("--repair") });
  else if (command === "update" && !flags.length) await update();
  else if (command === "doctor" && !flags.length) prerequisites();
  else if (command === "github-token") {
    const remove = flags.includes("--remove");
    const names = flags.filter((flag) => flag !== "--remove");
    if (names.length > 1 || names.some((name) => name.startsWith("-"))) throw new Error(USAGE);
    // The token is never a command-line argument: it is pasted at a hidden prompt.
    await githubTokenCli({ ...(names[0] ? { repository: names[0] } : {}), remove });
  } else throw new Error(USAGE);
} catch (error) {
  // Do not print remote payloads, native errors or credentials.
  console.error(
    error instanceof Error && !error.message.includes("[Request ID")
      ? error.message
      : "Control-plane request failed; check pairing, deployment and credentials",
  );
  process.exitCode = 1;
}
