import type { NextConfig } from "next";

const config: NextConfig = {
  // The design system ships TypeScript and CSS sources from the workspace.
  transpilePackages: ["@zamolxis/ui"],
  // Bake the released commit into the build so /api/bootstrap can report it.
  env: { ZAMOLXIS_COMMIT: process.env.ZAMOLXIS_COMMIT ?? "" },
};

export default config;
