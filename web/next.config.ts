import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Server code reads these at runtime through computed paths (deployments,
  // repo root marker, attack fixtures), which the tracer cannot follow.
  outputFileTracingIncludes: {
    "/**": ["../deployments/*.json", "../pnpm-workspace.yaml", "../packages/agent/pages/**"],
  },
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
