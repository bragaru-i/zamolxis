import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Operator utility: generate separate human and device keys outside the repo.
// Never prints secrets, overwrites an existing directory, or deploys anything.
const destination = process.argv[2];
if (!destination)
  throw new Error("Usage: node scripts/generate-auth-keys.mjs /absolute/private/key-directory");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(destination);
const within = relative(root, target);
if (!isAbsolute(destination) || within === "" || (!within.startsWith("../") && !isAbsolute(within)))
  throw new Error("Choose an absolute key directory outside the repository");
mkdirSync(target, { mode: 0o700 });
for (const [privateName, publicName] of [
  ["JWT_PRIVATE_KEY", "JWKS"],
  ["ZAMOLXIS_DEVICE_PRIVATE_KEY", "ZAMOLXIS_DEVICE_JWKS"],
]) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(
    resolve(target, `${privateName}.pem`),
    privateKey.export({ format: "pem", type: "pkcs8" }),
    { mode: 0o600, flag: "wx" },
  );
  writeFileSync(
    resolve(target, `${publicName}.json`),
    JSON.stringify({
      keys: [
        { ...publicKey.export({ format: "jwk" }), kid: randomUUID(), use: "sig", alg: "RS256" },
      ],
    }),
    { mode: 0o600, flag: "wx" },
  );
}
console.log(
  `Keys saved privately in ${target}. Add their contents to the matching Convex environment variables. No deployment changed.`,
);
