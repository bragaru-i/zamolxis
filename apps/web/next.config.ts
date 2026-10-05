import type { NextConfig } from "next";

const config: NextConfig = {
  // The design system ships TypeScript and CSS sources from the workspace.
  transpilePackages: ["@zamolxis/ui"],
};

export default config;
