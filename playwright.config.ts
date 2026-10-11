import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';
import {
  e2eBaseUrl,
  e2eDatabasePath,
  e2eSessionSecret,
  e2eSlot,
  e2eWorkerCount,
} from './tests/e2e/e2e-env';
dotenv.config();

// One server and one database per worker. This file is evaluated again in every
// worker process, after Playwright has set `TEST_PARALLEL_INDEX` (the worker's
// stable slot), so each worker computes ITS slot's base URL and database file
// here; the runner (no index) is slot 0. The servers and the database files are
// made by `tests/e2e/global-setup.ts`; what a slot is, in `tests/e2e/e2e-env.ts`.
const SLOT = e2eSlot();

// Some specs import `$lib/server/db` directly into the Playwright process
// (e.g. to seed rows the server will list). That singleton resolves its file
// from DATABASE_PATH at import time, so each worker must point at the same file
// ITS server uses — otherwise it opens ./data/chat.db and cannot see the seeded
// admin/user. (`E2E_DATABASE_PATH` stays the slot-0 base the other slots derive
// from, so it is not rewritten here.)
process.env.DATABASE_PATH = e2eDatabasePath(SLOT);
process.env.SESSION_SECRET = e2eSessionSecret();

export default defineConfig({
  testDir: './tests/e2e',
  // Files go to workers whole and their tests keep their order; flip a file to
  // fully parallel only after proving it safe.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // E2E_WORKERS, else the default for the server mode (several on the built app,
  // one on `vite dev`). Each worker has a server and a database of its own.
  workers: e2eWorkerCount(),
  reporter: process.env.E2E_JSON_REPORT
    ? [['list'], ['json', { outputFile: process.env.E2E_JSON_REPORT }]]
    : 'list',
  use: {
    baseURL: e2eBaseUrl(SLOT),
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  timeout: 60000,
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  globalSetup: './tests/e2e/global-setup.ts',
});
