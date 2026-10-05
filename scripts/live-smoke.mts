import assert from "node:assert/strict";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

// Uses an actual approved Convex Auth session. Never replaces signing keys,
// impersonates a user, grants access, or changes deployment environment variables.
const url = process.env.CONVEX_URL;
const token = process.env.ZAMOLXIS_SMOKE_TOKEN;
assert(
  url && token,
  "Set CONVEX_URL and ZAMOLXIS_SMOKE_TOKEN locally (do not log or commit the token)",
);
const user = new ConvexHttpClient(url);
user.setAuth(token);
const anonymous = new ConvexHttpClient(url);
const viewer = await user.query(makeFunctionReference<"query">("profiles:viewer"), {});
assert.equal(
  viewer?.accessStatus,
  "allowed",
  "The smoke account must have database-approved access",
);
assert.equal(await anonymous.query(makeFunctionReference<"query">("profiles:viewer"), {}), null);
await assert.rejects(() =>
  anonymous.query(makeFunctionReference<"query">("supervisor:products"), {}),
);
const corrupted = new ConvexHttpClient(url);
corrupted.setAuth(`${token.slice(0, -10)}AAAAAAAAAA`);
await assert.rejects(() =>
  corrupted.query(makeFunctionReference<"query">("supervisor:products"), {}),
);
const products = await user.query(makeFunctionReference<"query">("supervisor:products"), {});
assert(Array.isArray(products));
console.log(
  "PASS deployed human access smoke: approved session, anonymous denial, invalid signature denial. No device/runtime E2E claimed.",
);
