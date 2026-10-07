import { defineConfig } from "@playwright/test";

// Needs `task stack:up` + `task stack:bootstrap`. Starts the API and web app if they aren't running.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  workers: 1,
  use: { baseURL: "http://localhost:3000", trace: "retain-on-failure" },
  webServer: [
    {
      command: "pnpm --dir ../api run start",
      url: "http://localhost:4000/readyz",
      reuseExistingServer: true,
    },
    { command: "pnpm run dev", url: "http://localhost:3000/auth/login", reuseExistingServer: true },
  ],
});
