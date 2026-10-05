import type { AuthConfig } from "convex/server";
const siteUrl = process.env.CONVEX_SITE_URL;
export default {
  providers: [
    ...(siteUrl ? [{ domain: siteUrl, applicationID: "convex" }] : []),
    ...(siteUrl && process.env.ZAMOLXIS_DEVICE_JWKS
      ? [
          {
            type: "customJwt" as const,
            issuer: siteUrl,
            applicationID: "zamolxis-node",
            algorithm: "RS256" as const,
            jwks: `data:application/json;base64,${btoa(process.env.ZAMOLXIS_DEVICE_JWKS)}`,
          },
        ]
      : []),
  ],
} satisfies AuthConfig;
