import { prerequisites, setup } from "./setup";

const [command, ...flags] = process.argv.slice(2);
try {
  if (command === "setup" && flags.every((flag) => flag === "--repair"))
    await setup({ repair: flags.includes("--repair") });
  else if (command === "doctor" && !flags.length) prerequisites();
  else throw new Error("Usage: pnpm zamolxis setup [--repair] | doctor");
} catch (error) {
  // Do not print remote payloads, native errors or credentials.
  console.error(
    error instanceof Error && !error.message.includes("[Request ID")
      ? error.message
      : "Control-plane request failed; check pairing, deployment and credentials",
  );
  process.exitCode = 1;
}
