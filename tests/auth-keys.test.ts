import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("generates separate matching human/device keys privately outside the repository without overwriting", () => {
  const root = mkdtempSync(join(tmpdir(), "zamolxis-key-test-"));
  const directory = join(root, "keys");
  try {
    const output = execFileSync(process.execPath, ["scripts/generate-auth-keys.mjs", directory], {
      encoding: "utf8",
    });
    expect(output).not.toContain("PRIVATE KEY");
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    const moduli: string[] = [];
    for (const [privateName, publicName] of [
      ["JWT_PRIVATE_KEY", "JWKS"],
      ["ZAMOLXIS_DEVICE_PRIVATE_KEY", "ZAMOLXIS_DEVICE_JWKS"],
    ]) {
      const path = join(directory, `${privateName}.pem`);
      const key = createPrivateKey(readFileSync(path));
      const publicKey = createPublicKey(key).export({ format: "jwk" });
      const jwks = JSON.parse(readFileSync(join(directory, `${publicName}.json`), "utf8"));
      expect(jwks.keys[0]).toMatchObject({
        n: publicKey.n,
        e: publicKey.e,
        alg: "RS256",
        use: "sig",
      });
      expect(jwks.keys[0].kid).toBeTruthy();
      expect(statSync(path).mode & 0o777).toBe(0o600);
      moduli.push(jwks.keys[0].n);
    }
    expect(moduli[0]).not.toBe(moduli[1]);
    expect(() =>
      execFileSync(process.execPath, ["scripts/generate-auth-keys.mjs", directory], {
        stdio: "pipe",
      }),
    ).toThrow();
    expect(() =>
      execFileSync(
        process.execPath,
        ["scripts/generate-auth-keys.mjs", join(process.cwd(), "unsafe-test-keys")],
        { stdio: "pipe" },
      ),
    ).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
