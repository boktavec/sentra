import { defineConfig } from "vitest/config";

// `pnpm test` runs unit tests only; integration tests need `task stack:up` + `task stack:bootstrap`.
export default defineConfig({
  test: {
    include: process.env["INTEGRATION"] ? ["src/**/*.integration.test.ts"] : ["src/**/*.test.ts"],
    exclude: process.env["INTEGRATION"] ? [] : ["src/**/*.integration.test.ts"],
    fileParallelism: false,
  },
});
