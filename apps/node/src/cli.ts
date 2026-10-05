import { prerequisites, setup } from "./setup";

try {
  if (process.argv[2] === "setup") await setup();
  else if (process.argv[2] === "doctor") prerequisites();
  else throw new Error("Usage: pnpm zamolxis setup | doctor");
} catch (error) {
  // Do not print remote payloads, native errors or credentials.
  console.error(
    error instanceof Error && !error.message.includes("[Request ID")
      ? error.message
      : "Control-plane request failed; check pairing, deployment and credentials",
  );
  process.exitCode = 1;
}
