import { defineConfig, devices } from "@playwright/test"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const authFile = path.join(__dirname, "e2e/.auth/session.json")

const port = process.env.PORT || "4000"
const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: "./e2e",
  timeout: 20_000,
  expect: {
    timeout: 5_000
  },
  use: {
    baseURL,
    trace: "retain-on-failure"
  },
  webServer: {
    command: `cd .. && PHX_SERVER=true PORT=${port} mix phx.server`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  },
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.mjs/
    },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: [
        /auth\.setup\.mjs/,
        /editor_load\.spec\.mjs/,
        /wasm\.spec\.mjs/,
        /preview\.spec\.mjs/,
        /redesign\.spec\.mjs/,
        /fork_flow\.spec\.mjs/,
        /search_panel\.spec\.mjs/,
        /editor_gutter\.spec\.mjs/,
        /collab\.spec\.mjs/
      ]
    },
    {
      name: "chromium-authenticated",
      use: {
        ...devices["Desktop Chrome"],
        storageState: authFile
      },
      testMatch: [/editor_load\.spec\.mjs/, /wasm\.spec\.mjs/, /preview\.spec\.mjs/, /redesign\.spec\.mjs/, /fork_flow\.spec\.mjs/, /search_panel\.spec\.mjs/, /editor_gutter\.spec\.mjs/, /collab\.spec\.mjs/],
      dependencies: ["setup"]
    }
  ]
})
