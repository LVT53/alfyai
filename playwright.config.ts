import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';
import {
  e2eBaseUrl,
  e2eDatabasePath,
  e2eFullSpecs,
  e2eSessionSecret,
  e2eSlot,
  e2eWorkerCount,
} from './tests/e2e/e2e-env';
import {
  loadQuarantine,
  quarantinedFileGlobs,
  quarantinedTitlePattern,
} from './tests/e2e/quarantine';
dotenv.config();
// The specs seed rows through the app's own services, in this process, into the file their
// server also writes: transactions take their write lock at BEGIN (the servers load the same).
import './tests/e2e/sqlite-immediate.cjs';

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

// The release gate (scripts/gates.sh) runs the whole suite minus the quarantine
// list, tests/e2e/quarantine.json. A bare `npx playwright test <file>` still runs
// whatever it is told to.
const quarantine =
  process.env.E2E_APPLY_QUARANTINE === '1'
    ? loadQuarantine()
    : { files: [], tests: [] };
const quarantinedFiles = quarantinedFileGlobs(quarantine);
const quarantinedTitles = quarantinedTitlePattern(quarantine);

// An agent's run (scripts/gates.sh agent): the files it names in full, and the
// @smoke tests of every other file, in one run on the same workers.
const fullSpecs = e2eFullSpecs();
const desktop = { ...devices['Desktop Chrome'] };

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
  projects:
    fullSpecs.length === 0
      ? [
          {
            name: 'chromium',
            use: desktop,
            testIgnore: quarantinedFiles,
            grepInvert: quarantinedTitles,
          },
        ]
      : [
          // What was named: all of it, quarantined or not.
          { name: 'chromium', use: desktop, testMatch: fullSpecs },
          {
            name: 'chromium-smoke',
            use: desktop,
            grep: /@smoke/,
            testIgnore: [...quarantinedFiles, ...fullSpecs],
            grepInvert: quarantinedTitles,
          },
        ],
  globalSetup: './tests/e2e/global-setup.ts',
});
