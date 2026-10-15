# Two-step sign-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optional authenticator-app codes with one-time backup codes as a second sign-in step, plus five session fixes, in AlfyAI.

**Architecture:** A correct password opens a 5-minute, single-use sign-in attempt held in its own table; a TOTP or backup code completes it and only then is a session created. Second factors live in one table that can hold passkeys later; secrets go through the existing connector vault. Sessions get stored as hashes, expire on the server, and are revoked on password change and when a factor is turned on.

**Tech Stack:** SvelteKit 2 + Svelte 5 (runes), Drizzle + better-sqlite3, bcryptjs, `@oslojs/otp` 1.1.0, `@oslojs/encoding` 1.1.0, `uqr` 0.1.3, Vitest, Playwright.

**Spec:** [`docs/plans/two-step-sign-in/spec.md`](./spec.md), mockups [`mockups.html`](./mockups.html). Read both before starting.

## Global Constraints

- Optional for every account, admins included; never required.
- UI name "Two-step sign-in", Hungarian "Kétlépcsős bejelentkezés"; "2FA" never appears in the UI. Copy from spec §3.4 verbatim; every new string in English and Hungarian; no gendered pronouns in copy.
- No outside service. The QR code is an SVG drawn on the server with `uqr`; never an online QR service.
- TOTP: SHA-1, 6 digits, 30-second step, accepted for the current step and one step either side; a step at or below `last_used_step` is refused.
- Backup codes: 10 per person, 10 characters from Crockford base32 (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`), shown `XXXXX-XXXXX`, stored as HMAC-SHA256 hex with a key derived from `SESSION_SECRET` (HKDF-SHA256, info `alfyai-backup-codes-v1`), single use.
- Sign-in attempt: 5 minutes, 5 wrong codes; cookie `signin_attempt` (`httpOnly`, `secure` in production, `sameSite: "strict"`, `path: "/api/auth"`, `maxAge: 300`); the database holds only its SHA-256.
- Session tokens: the database holds `sha256(token)` hex; the cookie holds the token.
- Service code in `src/lib/server/services/two-step/` behind `index.ts`; routes stay thin; browser calls in `src/lib/client/api/`; account behaviour already in `services/auth.ts` / `user-admin.ts` stays there.
- Svelte 5 runes, Lucide icons only, `DialogShell` for dialogs (a sheet on a phone), design tokens, and a little more space between elements than the first mockup (`mockups.html`).
- `src/lib/server/db/AGENTS.md`: every new table gets a migration and a `_journal.json` entry; user-owned FKs use `onDelete: "cascade"`; `npm run check:migrations`.
- Check the current docs of `@oslojs/otp`, `@oslojs/encoding`, `uqr` and SvelteKit's `cookies` API before using them (AGENTS.md "Mandatory Docs Check").
- Each slice ends with `scripts/gates.sh agent <out-dir> --port <base> <specs>` all green: check 0 errors and 0 warnings, build 0 warnings, Fallow 0 new. Never push. Commits end with the agent's own `Co-Authored-By` line.

## Review Focus

1. **The code typed as it rolls over, or reused.** A code from the step before or after is accepted; the same code a second time within its 90 seconds is refused (Task 6, Task 8).
2. **A double click on Verify.** Two requests with one valid code: exactly one session is created, the other answers "wrong code" with no 500 (Task 9).
3. **A session cookie from before the deploy.** The old raw token finds no row: the person is sent to sign in, never a 500 (Task 2).
4. **A backup code typed loosely.** Lowercase, spaces, no hyphen, `O` for `0`, `I`/`L` for `1`: accepted when it is the right code (Task 6).
5. **Setup abandoned halfway, or a vault that cannot decrypt.** An unconfirmed factor never asks for a code at sign-in; a factor whose secret no longer decrypts (a changed `SESSION_SECRET`) gives a clear "contact your admin" answer, never a 500, and the reset script clears it (Task 8, Task 9).

## Slices and execution

Three Sonnet agents in sequence, each in its own worktree, each branching from the previous slice's branch: **S1** Tasks 1–5 (`feat/two-step-s1-sessions`), **S2** Tasks 6–10 (`feat/two-step-s2-core`), **S3** Tasks 11–14 (`feat/two-step-s3-screens`). Then an Opus security review of the whole S3 branch against `dev`, a fix agent, a re-check, and a merge into `dev`. The release gate (`scripts/gates.sh release`) runs before production.

---

## Slice S1: session hardening

### Task 1: Sessions expire on the server (fix 1)

**Files:**
- Modify: `src/lib/server/services/auth.ts` (`createSession` ~L19–37, `validateSession` ~L55)
- Test: `src/lib/server/services/auth.session-expiry.test.ts` (new)

**Interfaces:**
- Produces: `createSession(userId: string, rememberMe: boolean): Promise<{ token: string; expiresAt: Date }>` (the return type changes from `number` to `Date`; update its callers and `setSessionCookie`).

- [ ] **Step 1: Write the failing test** `"a session is refused once its expiry has passed"`: create a session with `rememberMe: false`, `vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000 + 1000)`, expect `validateSession(token)` to be `null` and the row gone. Also `"a session is valid one minute before its expiry"`.
- [ ] **Step 2: Run** `npx vitest run src/lib/server/services/auth.session-expiry.test.ts`. Expected: the first test FAILS on today's code (the stored milliseconds read back as a far-future date).
- [ ] **Step 3: Implement**: write `expiresAt` as a `Date` through Drizzle (no raw `sql`), compare `expiresAt.getTime() < Date.now()`.
- [ ] **Step 4: Run** the test file. Expected: PASS.
- [ ] **Step 5: Commit** `Sessions expire on the server, not only in the browser`.

### Task 2: Session tokens stored as hashes (fix 4)

**Files:**
- Modify: `src/lib/server/services/auth.ts`, `src/routes/api/auth/logout/+server.ts`, any other caller found by `grep -rn "sessions.id\|validateSession\|invalidateSession" src`
- Create: `drizzle/<next>_clear_sessions_for_hashed_tokens.sql` (+ `_journal.json` entry): `DELETE FROM sessions;`
- Test: `src/lib/server/services/auth.session-hash.test.ts`

**Interfaces:**
- Produces: `hashSessionToken(token: string): string` (SHA-256 hex) in `auth.ts`; `validateSession(token)` and `invalidateSession(token)` keep their signatures and hash inside.

- [ ] **Step 1: Write the failing tests**: `"the stored session id is the token's SHA-256, never the token"` (row id `=== hashSessionToken(token)` and `!== token`); `"the stored hash used as a cookie value finds no session"`; `"a pre-deploy raw-token cookie is treated as signed out"` (insert a row whose id is a raw token, expect `validateSession(raw)` to be `null` with no throw), and for the hooks: a request carrying that cookie is redirected to `/login` (a page) or gets 401 (an API), not 500.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** hashing in create, validate, invalidate; add the migration; `npm run check:migrations`.
- [ ] **Step 4: Run** the tests and `src/hooks.server.test.ts` if it exists. Expected: PASS.
- [ ] **Step 5: Commit** `Store session tokens as hashes, so a database copy holds no live session`.

### Task 3: Changing the password signs out the other devices (fix 2)

**Files:**
- Modify: `src/lib/server/services/auth.ts`, `src/routes/api/settings/password/+server.ts`, `src/lib/server/services/user-admin.ts` (its delete-all-sessions path uses the new helper), `src/routes/(app)/settings/_components/SettingsProfileTab.svelte` (the notice), `src/lib/i18n/settings.ts`
- Test: `src/routes/api/settings/password/password.test.ts` (extend), `src/lib/server/services/auth.revoke.test.ts`

**Interfaces:**
- Produces: `revokeOtherSessions(userId: string, keepToken: string | null): Promise<number>` and `revokeAllSessions(userId: string): Promise<number>` in `auth.ts`.

- [ ] **Step 1: Failing tests**: `"revokeOtherSessions keeps the current session and deletes the rest"`; `"a password change answers signedOutOtherDevices and leaves only the current session"`.
- [ ] **Step 2: Run**. Expected: FAIL.
- [ ] **Step 3: Implement**; the route answers `{ ok: true, signedOutOtherDevices: number }`; the Profile tab shows "You were signed out on your other devices." / "A többi eszközödön kijelentkeztettünk." when it is above 0.
- [ ] **Step 4: Run**. Expected: PASS.
- [ ] **Step 5: Commit** `A password change signs out every other device`.

### Task 4: Changing the email needs the password (fix 5)

**Files:**
- Modify: `src/routes/api/settings/profile/+server.ts` (or the service it calls), `SettingsProfileTab.svelte` (a password field when the email field changes), `src/lib/client/api/settings.ts`, `src/lib/i18n/settings.ts`
- Test: the profile route's test file (extend or create beside it)

- [ ] **Step 1: Failing tests**: `"an email change without currentPassword is refused"` (400, error `password_required`); `"a wrong currentPassword is refused and counted by the login limiter"`; `"the right password changes the email"`; `"a name change needs no password"`.
- [ ] **Step 2: Run**. Expected: FAIL.
- [ ] **Step 3: Implement** with the same bcrypt comparison the login uses and `login-rate-limit.ts` failure recording.
- [ ] **Step 4: Run**. Expected: PASS.
- [ ] **Step 5: Commit** `Ask for the password before an email change`.

### Task 5: Sweep expired sessions; S1 gate

**Files:**
- Modify: `auth.ts` (`sweepExpiredSessions(now: Date): Promise<number>`), the periodic maintenance started from `src/hooks.server.ts` (find its tick with `grep -n maintenance src/hooks.server.ts`)
- Test: `auth.session-expiry.test.ts` (extend)

- [ ] **Step 1: Failing test** `"the sweep deletes expired sessions only"`.
- [ ] **Step 2–4:** run, implement, run.
- [ ] **Step 5: Gate** `scripts/gates.sh agent "$TMPDIR/two-step-s1" --port 5520 --workers 4 tests/e2e/login.test.ts tests/e2e/settings-admin.spec.ts`. Expected: ALL GATES PASSED.
- [ ] **Step 6: Commit** `Sweep expired sessions in maintenance`.

## Slice S2: two-step core (server)

### Task 6: Codes and keys

**Files:**
- Modify: `package.json` / lockfile: `npm install -E @oslojs/otp@1.1.0 @oslojs/encoding@1.1.0 uqr@0.1.3`
- Create: `src/lib/server/services/two-step/codes.ts`
- Test: `src/lib/server/services/two-step/codes.test.ts`

**Interfaces:**
- Produces: `generateTotpSecret(): Uint8Array` (20 bytes); `formatTotpKey(secret: Uint8Array): string` (base32 in groups of 4); `totpUri(secret: Uint8Array, accountName: string): string` (issuer `AlfyAI`); `matchTotpStep(secret: Uint8Array, code: string, now: Date): number | null` (the matching step among current ±1, constant-time); `generateBackupCodes(count?: number): string[]`; `normalizeBackupCode(input: string): string | null`; `hashBackupCode(normalized: string): string`; `renderQrSvg(uri: string): string`.

- [ ] **Step 1: Failing tests**:
  - `"matches the RFC 6238 SHA-1 vectors"`, with secret ASCII `12345678901234567890` and 6-digit codes: T=59 `287082`, T=1111111109 `081804`, T=1111111111 `050471`, T=1234567890 `005924`, T=2000000000 `279037`, T=20000000000 `353130`. `matchTotpStep` returns `Math.floor(T / 30)` for each.
  - `"accepts one step either side, refuses two"`.
  - `"backup codes look like XXXXX-XXXXX in Crockford base32"`, with regex `/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/` and 10 distinct codes.
  - `"a loosely typed backup code normalizes to the same code"`: `"7kq4m 2xwpd"`, `"7KQ4M2XWPD"` and `"7KQ4M-2XWPO"` against `…2XWP0`, and `I`/`L` for `1`.
  - `"the hash is keyed and stable"`.
  - `"the QR is an inline SVG with no external reference"`: starts with `<svg`, contains no `http`.
- [ ] **Step 2: Run**. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** with `@oslojs/otp` and `@oslojs/encoding`, `uqr`'s SVG renderer, `node:crypto` (`randomBytes`, `hkdfSync`, `createHmac`, `timingSafeEqual`). Read `SESSION_SECRET` the way `connections/vault.ts` does.
- [ ] **Step 4: Run**. Expected: PASS.
- [ ] **Step 5: Commit** `Two-step codes: TOTP, backup codes and the QR, with the RFC vectors`.

### Task 7: Tables, migration and the account lifecycle

**Files:**
- Modify: `src/lib/server/db/schema.ts` (`userSecondFactors`, `userBackupCodes`, `signInChallenges`, columns per spec §5.1); `account-lifecycle/user-scoped-tables.ts` (3 entries, `erasure: "cascade"`, `resets: []`); `account-lifecycle/account-lifecycle.test.ts` (name list, seed rows); `account-data-archive/index.ts` (`EXCLUSION_NOTES`)
- Create: `drizzle/<next>_two_step_sign_in.sql` + journal entry

- [ ] **Step 1: Run** `npx vitest run src/lib/server/services/account-lifecycle` after adding the tables to `schema.ts` only. Expected: FAIL (the schema-derived guard names the unregistered tables).
- [ ] **Step 2: Implement** the registry entries, seed rows, archive notes, migration; `npm run check:migrations`.
- [ ] **Step 3: Run** the lifecycle and archive tests. Expected: PASS.
- [ ] **Step 4: Commit** `Tables for two-step sign-in, removed with the account and left out of its archive`.

### Task 8: The two-step service

**Files:**
- Create: `src/lib/server/services/two-step/index.ts` (facade), `store.ts`
- Test: `src/lib/server/services/two-step/store.test.ts`

**Interfaces:**
- Consumes: Task 6 functions; `connections/vault.ts` encrypt/decrypt.
- Produces (from `index.ts`):
  - `getTwoStepStatus(userId): Promise<{ enabled: boolean; since: Date | null; backupCodesLeft: number }>`
  - `beginTwoStepSetup(userId, email): Promise<{ qrSvg: string; key: string }>`
  - `confirmTwoStepSetup(userId, code, now): Promise<{ ok: true; backupCodes: string[] } | { ok: false; reason: "wrong_code" | "no_setup" }>`
  - `verifySecondFactor(userId, input: { code?: string; backupCode?: string }, now): Promise<{ ok: true; usedBackupCode: boolean; backupCodesLeft: number } | { ok: false; reason: "wrong_code" | "unreadable_secret" }>`
  - `disableTwoStep(userId, input, now): Promise<{ ok: boolean }>`
  - `regenerateBackupCodes(userId, input, now): Promise<{ ok: true; backupCodes: string[] } | { ok: false }>`
  - `resetTwoStepForUser(userId): Promise<void>`
  - `sweepTwoStep(now): Promise<{ challenges: number; unconfirmed: number }>`

- [ ] **Step 1: Failing tests**:
  - `"a wrong code does not confirm"`, `"the right code confirms and returns 10 codes"`
  - `"the same code is refused the second time"`
  - `"two racing verifications with one code: exactly one succeeds"` (`Promise.all`)
  - `"a backup code works once and the count drops"`
  - `"an unconfirmed factor leaves two-step off"`
  - `"an unreadable secret answers unreadable_secret"` (corrupt the ciphertext)
  - `"disable needs a valid code"`, `"reset clears factor and codes"`
  - `"the sweep removes unconfirmed factors older than 15 minutes"`
- [ ] **Step 2: Run**. Expected: FAIL.
- [ ] **Step 3: Implement**. The replay and single-use guards are conditional `UPDATE`s that report the rows they changed. Log content-free `[AUTH]` lines (spec §5.5).
- [ ] **Step 4: Run**. Expected: PASS.
- [ ] **Step 5: Commit** `The two-step service: setup, verification, backup codes and reset`.

### Task 9: The sign-in attempt and its routes

**Files:**
- Create: `src/lib/server/services/two-step/challenges.ts`, `src/routes/api/auth/login/two-step/+server.ts`
- Modify: `src/routes/api/auth/login/+server.ts`, `src/hooks.server.ts` (`PUBLIC_PATHS` + `/api/auth/login/two-step`)
- Test: `src/routes/api/auth/login/two-step/two-step.test.ts`, the login route's test

**Interfaces:**
- Produces:
  - `createSignInChallenge(userId, rememberMe, now): Promise<{ token: string; expiresAt: Date }>`
  - `consumeSignInChallenge(token, input, now)`, returning one of:
    - `{ ok: true; userId; rememberMe; usedBackupCode; backupCodesLeft }`
    - `{ ok: false; reason: "wrong_code"; triesLeft: number }`
    - `{ ok: false; reason: "restart"; why: "expired" | "too_many" | "missing" }`
    - `{ ok: false; reason: "unreadable_secret" }`
  - `SIGN_IN_ATTEMPT_COOKIE = "signin_attempt"`
  - Constants: `MAX_TRIES = 5`, `ATTEMPT_TTL_MS = 300_000`.
- The login route answers `{ twoStep: true }` (JSON) or redirects 303 to `/login?step=two-step` (form) when the account has a confirmed factor, and sets no session cookie then.

- [ ] **Step 1: Failing tests**:
  - `"an account without a factor signs in as before"`
  - `"an account with a factor gets twoStep and no session cookie"`
  - `"the right code creates the session and clears the attempt cookie"`
  - `"five wrong codes end the attempt"`
  - `"an expired attempt answers restart"`
  - `"a backup code signs in and reports codes left"`
  - `"a double submit with one code yields exactly one session"`
  - `"wrong codes are counted by the login limiter"`
  - `"the attempt cookie has the spec's flags"`
  - `"PUBLIC_PATHS gained exactly /api/auth/login/two-step"`
- [ ] **Step 2: Run**. Expected: FAIL.
- [ ] **Step 3: Implement**. The attempt token is 32 random bytes; the row id is its SHA-256. `unreadable_secret` answers 409 `{ error: "two_step_unavailable" }`.
- [ ] **Step 4: Run**. Expected: PASS.
- [ ] **Step 5: Commit** `Sign-in asks for the second step before it creates a session`.

### Task 10: Settings and admin routes, revoke on turn-on, recovery script; S2 gate

**Files:**
- Create: `src/routes/api/settings/two-step/{setup,confirm,disable,backup-codes}/+server.ts`, `src/routes/api/admin/users/[id]/two-step/reset/+server.ts`, `scripts/reset-two-step.ts`
- Modify:
  - the settings page's server load (`twoStep` status)
  - `user-admin.ts` (`listManagedUsers` gains `twoStepEnabled`; the detail gains `since` and `backupCodesLeft`)
  - the maintenance tick (`sweepTwoStep`)
  - `package.json` (`"auth:reset-two-step": "tsx scripts/reset-two-step.ts"`)
  - `.fallowrc.json` (entry)
  - `README.md` (the reset script, and that a changed `SESSION_SECRET` needs it, beside the existing warning)
- Tests: one test file per route, beside it

- [ ] **Step 1: Failing tests**:
  - `"confirm signs out the other sessions and returns the codes"`
  - `"setup needs a session"`
  - `"disable and new codes need a valid code"`
  - `"the admin reset refuses the admin's own account"`
  - `"the admin reset refuses a wrong admin password"`
  - `"the admin reset asks for the admin's code when the admin has a factor"`
  - `"the admin reset clears the factor, the codes and every session of the person"`
  - `"the reset script clears a person by email"` (test its exported `resetTwoStepByEmail(email)`)
- [ ] **Step 2–4:** run, implement (thin routes over the service), run.
- [ ] **Step 5: Gate** `scripts/gates.sh agent "$TMPDIR/two-step-s2" --port 5530 --workers 4 tests/e2e/login.test.ts tests/e2e/settings-admin.spec.ts`. Expected: ALL GATES PASSED.
- [ ] **Step 6: Commit** `Settings and admin routes for two-step sign-in, and the recovery script`.

## Slice S3: the screens

### Task 11: The code step on the sign-in card

**Files:**
- Modify: `src/routes/login/+page.svelte`, the login strings' i18n file (`grep -rn '"login.signIn"' src/lib/i18n`), `src/lib/client/api/auth.ts` (`verifyTwoStepSignIn(input: { code?: string; backupCode?: string })`)
- Test: the login page's component test (create beside it if none)

- [ ] **Step 1: Failing tests**:
  - `"after a twoStep answer the card asks for the code"`
  - `"six digits submit by themselves"`
  - `"the backup link switches the field"`
  - `"a wrong code shows the tries left"`
  - `"restart returns to the password step with the spec's message"`
  - `"?step=two-step opens the code step"`
  - `"the field has autocomplete one-time-code and a numeric keyboard"`
  - `"after a backup code the next page says how many are left"`
- [ ] **Step 2–4:** run, implement per spec §3.1 and `mockups.html` §1, run.
- [ ] **Step 5: Commit** `The sign-in card asks for the second step`.

### Task 12: Settings: the Account row and the setup dialog

**Files:**
- Create: `src/routes/(app)/settings/_components/TwoStepSetupDialog.svelte`
- Modify: `SettingsProfileTab.svelte`, `src/lib/client/api/settings.ts`, `src/lib/i18n/settings.ts`
- Test: `TwoStepSetupDialog.test.ts`, `SettingsProfileTab` tests

- [ ] **Step 1: Failing tests**:
  - `"the row shows Off and Turn on"`
  - `"step 2 does not finish on a wrong code"`
  - `"Done stays off until the box is ticked"`
  - `"the codes can be copied and downloaded as a .txt"`
  - `"turning it on shows the other-devices notice"`
  - `"Turn off and New backup codes ask for a code"`
  - `"with two or fewer codes left the row suggests new ones"`
- [ ] **Step 2–4:** run, implement per spec §3.2 and `mockups.html` §2, run.
- [ ] **Step 5: Commit** `Turn two-step sign-in on and off in Settings`.

### Task 13: Admin: the column, the detail row and the reset dialog

**Files:**
- Modify: `settings/_components/users/UsersTable.svelte`, `users/UserDetailPanel.svelte`, `src/lib/client/api/admin.ts`, `src/lib/i18n/settings.ts`
- Create: `users/ResetTwoStepDialog.svelte`
- Test: beside each component

- [ ] **Step 1: Failing tests**:
  - `"the table shows On or Off"`
  - `"the reset action appears only when it is on and never for yourself"`
  - `"the dialog copy uses the person's name and neutral pronouns"`
  - `"the dialog asks for the admin's code when the admin has one"`
- [ ] **Step 2–4:** run, implement per spec §3.3 and `mockups.html` §3, run.
- [ ] **Step 5: Commit** `Show and reset two-step sign-in in the admin Users pane`.

### Task 14: End-to-end spec; S3 gate

**Files:**
- Create: `tests/e2e/two-step-sign-in.spec.ts` (accounts of its own; it computes codes from the key shown in setup step 1 with `@oslojs/otp`; it puts back what it changes, per `tests/AGENTS.md`)

- [ ] **Step 1: Write the spec**, covering:
  - turn on, through all three steps
  - sign out, then sign in with a code
  - sign in with a backup code
  - five wrong codes, then a restart
  - turn off
  - the admin resets a second account
  - the main screens in English and Hungarian
- [ ] **Step 2: Run** `E2E_PORT=5540 npx playwright test tests/e2e/two-step-sign-in.spec.ts` on a fresh build. Expected: PASS.
- [ ] **Step 3: Gate** `scripts/gates.sh agent "$TMPDIR/two-step-s3" --port 5540 --workers 4 tests/e2e/two-step-sign-in.spec.ts tests/e2e/login.test.ts tests/e2e/settings-admin.spec.ts`. Expected: ALL GATES PASSED.
- [ ] **Step 4: Commit** `End-to-end coverage for two-step sign-in`.

## After S3

- [ ] An Opus security review of `dev...feat/two-step-s3-screens`, adversarial, against spec §4–§5 and this plan's Review Focus.
- [ ] A Sonnet fix agent for its findings, then a re-check by the reviewer.
- [ ] A trial merge onto the current `dev` with the full agent gate; fast-forward `dev`; remove worktrees.
- [ ] Before production: `scripts/gates.sh release`, then deploy to ai.dev and production with the owner. Everyone signs in once (the sessions table is emptied).
