import type { NextConfig } from "next";

const config: NextConfig = {
  // Lets the browser tests run a second dev server (pointed at an unavailable API) beside the main one.
  distDir: process.env["NEXT_DIST_DIR"] ?? ".next",
  // Shared workspace package ships TypeScript source.
  transpilePackages: ["@sentra/ts-platform"],
  poweredByHeader: false,
  // The repo-level AGENTS.md is the single source of agent guidance; don't let Next generate its own.
  agentRules: false,
};

export default config;
