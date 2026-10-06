import path from "node:path";
import type { NextConfig } from "next";

// Preview harness (dev only): `ZAMOLXIS_PREVIEW=1 pnpm --filter @zamolxis/web dev` swaps the
// Convex hooks for in-memory fixtures (see preview/store.ts) so the real app can be opened in a
// browser or driven by Playwright without sign-in or a deployment.
const preview = process.env.ZAMOLXIS_PREVIEW === "1";
const previewAliases = {
  "convex/react": path.resolve(process.cwd(), "preview/convex-react.tsx"),
  "@convex-dev/auth/react": path.resolve(process.cwd(), "preview/auth-react.tsx"),
};

const config: NextConfig = {
  // The design system ships TypeScript and CSS sources from the workspace.
  transpilePackages: ["@zamolxis/ui"],
  // Bake the released commit into the build so /api/bootstrap can report it.
  env: {
    ZAMOLXIS_COMMIT: process.env.ZAMOLXIS_COMMIT ?? "",
    ...(preview ? { NEXT_PUBLIC_CONVEX_URL: "preview" } : {}),
  },
  ...(preview
    ? {
        turbopack: { resolveAlias: previewAliases },
        webpack: (webpackConfig) => {
          webpackConfig.resolve.alias = { ...webpackConfig.resolve.alias, ...previewAliases };
          return webpackConfig;
        },
      }
    : {}),
};

export default config;
