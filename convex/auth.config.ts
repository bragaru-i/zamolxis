import type { AuthConfig } from "convex/server";

const issuer = process.env.ZAMOLXIS_AUTH_ISSUER;
const audience = process.env.ZAMOLXIS_AUTH_AUDIENCE;
if (Boolean(issuer) !== Boolean(audience))
  throw new Error("Configure both ZAMOLXIS_AUTH_ISSUER and ZAMOLXIS_AUTH_AUDIENCE");
export default {
  providers: [
    ...(issuer && audience ? [{ domain: issuer, applicationID: audience }] : []),
    ...(process.env.CONVEX_SITE_URL && process.env.ZAMOLXIS_DEVICE_JWKS
      ? [
          {
            type: "customJwt" as const,
            issuer: process.env.CONVEX_SITE_URL,
            applicationID: "zamolxis-node",
            algorithm: "RS256" as const,
            jwks: `data:application/json;base64,${btoa(process.env.ZAMOLXIS_DEVICE_JWKS)}`,
          },
        ]
      : []),
  ],
} satisfies AuthConfig;
