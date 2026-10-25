import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Loaded by Node as published: the agent runtime resolves its deployment files relative to its own modules.
  serverExternalPackages: ["@leash/agent", "@leash/sdk"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
