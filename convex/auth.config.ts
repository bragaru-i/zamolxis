import type { AuthConfig } from "convex/server";
const issuer = process.env.ZAMOLXIS_AUTH_ISSUER;
const audience = process.env.ZAMOLXIS_AUTH_AUDIENCE;
if (Boolean(issuer) !== Boolean(audience))
  throw new Error("Configure both ZAMOLXIS_AUTH_ISSUER and ZAMOLXIS_AUTH_AUDIENCE");
export default {
  providers: issuer && audience ? [{ domain: issuer, applicationID: audience }] : [],
} satisfies AuthConfig;
