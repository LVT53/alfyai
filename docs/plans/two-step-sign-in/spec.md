# Two-step sign-in: spec

Status: design approved by the owner on 2026-10-15, part by part (sign-in step, Settings, admin, data and security). Mockups: [`mockups.html`](./mockups.html). The owner asked for a little more space between elements than the first mockup had; that applies to every screen here.

## 1. Goal

A stolen password is enough to get into an AlfyAI account today, and an account holds the person's email, calendar, files and memory connectors. Two-step sign-in adds a second factor: a code from an authenticator app, with one-time backup codes for a lost phone. It is optional for every account.

The same project fixes five weaknesses in sessions that the second factor would otherwise lean on (section 4).

UI name: **Two-step sign-in**, Hungarian **Kétlépcsős bejelentkezés**. The word "2FA" does not appear in the UI.

## 2. Owner decisions

- Each person turns it on for their own account. It is never required, for admins either.
- Factor: authenticator-app codes (TOTP) plus 10 one-time backup codes. Passkeys come later on the same design, so storage holds "a second factor of some kind", not TOTP alone.
- No SMS, no email, no outside service: AlfyAI is self-hosted and sends no system mail.
- A lost phone never locks anyone out for good: backup codes, an admin reset, and a server script for the last admin.
- The code is asked once per sign-in on a device. There is no "remember this device" list.
- Turning it off and making new backup codes need a current code (or a backup code).
- The internal signed service path (`/api/chat/files/produce`) and the admin drain key keep working without a second factor.
- Every string exists in English and Hungarian.
- Approach: a second step on the same sign-in card, held on the server (section 5.3). Rejected: a stateless signed cookie with in-memory limits, and replacing the auth layer with a library.

## 3. What the person sees

### 3.1 The code step at sign-in

The email and password step is unchanged. When the account has two-step sign-in, the same card changes in place (no new page):

- Title "Enter your code", line "Open your authenticator app and type the 6-digit code for AlfyAI."
- One code field: `autocomplete="one-time-code"`, `inputmode="numeric"`, six digits. It submits by itself on the sixth digit; a Verify button also submits. It may be drawn as six boxes, but it is one input, so password managers can fill it.
- "Use a backup code instead" switches the card to "Enter a backup code" with one text field (format `XXXXX-XXXXX`, case and hyphen ignored) and "Use your authenticator app instead".
- "Back to sign in" returns to the password step.
- A wrong code: "That code didn't work. N tries left." After 5 wrong codes the attempt ends: "Too many tries. Sign in again." and the card returns to the password step. After 5 minutes: "That took too long. Sign in again."
- "Remember me" from the password step still decides the session length.
- After signing in with a backup code, a notice: "You used a backup code. N left." With 2 or fewer left, the Settings row suggests making new ones.

### 3.2 Settings: Profile → Account

A row in the Account card (`SettingsProfileTab.svelte`, beside Password):

- Off: "Two-step sign-in", "Off. Ask for a code from your phone when you sign in.", button **Turn on**.
- On: "Two-step sign-in" with an On badge, "Since 15 Oct. 8 of 10 backup codes left.", buttons **New backup codes** and **Turn off**.

**Turn on** opens a three-step dialog (`DialogShell`; the bottom sheet on a phone):

1. "Scan this code": a QR code drawn on the server, the line "Open your authenticator app (Google Authenticator, Apple Passwords, 1Password) and scan it.", and "Can't scan? Enter this key:" with the key in groups of four and a copy button. Cancel / Next.
2. "Enter the code from your app": the same code field as at sign-in. Nothing is turned on until a code works. Cancelling at any step leaves it off.
3. "Save your backup codes": the 10 codes in two columns, Copy and Download (a `.txt` file), a checkbox "I've saved them somewhere safe", and **Done**, enabled once the box is ticked. Turning it on signs out every other device of the account (the current one stays) and says so: "You were signed out on your other devices."

**Turn off** asks for a current code or a backup code, then deletes the factor and the backup codes. **New backup codes** asks for a current code or a backup code and shows 10 new codes the way step 3 does; the old codes stop working.

Two of the session fixes live in this card: changing the password signs out the other devices (same notice), and changing the email asks for the current password.

### 3.3 Admin: Settings → Administration → Users

- The users table gets a quiet column "Two-step" with On (a small badge) or Off.
- The user detail panel gets a row "Two-step sign-in": "On since 2 Oct · 6 backup codes left" or "Off".
- When it is on, and never on the admin's own account, the panel offers **Reset two-step sign-in**. The dialog: "Reset Dóra's two-step sign-in?", "This turns it off, deletes their backup codes and signs them out everywhere. They can sign in with their password, then turn it on again.", a field "Your password" (and the admin's own code when the admin has two-step sign-in on), Cancel / Reset. Copy never assumes a person's pronouns.

### 3.4 Copy

| Key idea | English | Hungarian |
|---|---|---|
| Feature name | Two-step sign-in | Kétlépcsős bejelentkezés |
| Code step title | Enter your code | Add meg a kódot |
| Code step line | Open your authenticator app and type the 6-digit code for AlfyAI. | Nyisd meg a hitelesítő alkalmazást, és írd be az AlfyAI 6 jegyű kódját. |
| Verify | Verify | Ellenőrzés |
| Backup link | Use a backup code instead | Inkább tartalékkódot használok |
| Back | Back to sign in | Vissza a bejelentkezéshez |
| Status | Off / On | Kikapcsolva / Bekapcsolva |
| Actions | Turn on / Turn off | Bekapcsolás / Kikapcsolás |
| Setup step 1 | Scan this code | Olvasd be ezt a kódot |
| Key line | Can't scan? Enter this key: | Nem tudod beolvasni? Írd be ezt a kulcsot: |
| Setup step 3 | Save your backup codes | Mentsd el a tartalékkódokat |
| Checkbox | I've saved them somewhere safe | Elmentettem őket biztonságos helyre |
| Other devices | You were signed out on your other devices. | A többi eszközödön kijelentkeztettünk. |
| Admin column | Two-step | Kétlépcsős (Be / Ki) |
| Admin action | Reset two-step sign-in | Kétlépcsős bejelentkezés kikapcsolása |
| Admin dialog | Reset Dóra's two-step sign-in? | Kikapcsolod Dóra kétlépcsős bejelentkezését? |
| Admin field | Your password | A jelszavad |

The remaining strings (errors, notices, the email-change password field) follow the same voice: short, plain, Hungarian that does not crowd a row.

## 4. Session hardening (in scope, owner's decision)

1. **Sessions expire on the server.** `createSession` (`services/auth.ts`) writes `Date.now() + duration` (milliseconds) as raw SQL into `sessions.expires_at`, an `integer` column in Drizzle's `timestamp` mode (seconds). Read back, it is multiplied by 1000, so the expiry check never fires and only the cookie's `maxAge` ends a session. Write the expiry through Drizzle as a `Date`, compare correctly, and prove it first with a test that fails on today's code.
2. **Changing the password signs out the other devices** (`PATCH /api/settings/password`): delete every session of the user except the current one.
3. **Turning on two-step sign-in does the same** (section 3.2).
4. **Session tokens are stored hashed.** `sessions.id` holds the SHA-256 (hex) of the token; the cookie holds the token. Validation, logout and revocation hash before they look up. Tokens are 32 random bytes, so a plain SHA-256 is enough.
5. **Changing the email asks for the current password** (`PATCH /api/settings/profile`), checked with the same bcrypt comparison and counted by the login limiter.

Plus: maintenance sweeps expired sessions, expired sign-in attempts and unconfirmed factors older than 15 minutes.

## 5. Server design

### 5.1 Tables (new migration; `db/AGENTS.md` rules: text UUID ids, unixepoch timestamps, `onDelete: "cascade"`)

- `user_second_factors`: `id`, `user_id`, `kind` (`"totp"`; `"passkey"` later), `label` (nullable), `secret_ciphertext`, `secret_iv`, `secret_auth_tag` (TOTP), `last_used_step` (nullable integer, replay guard), `confirmed_at` (nullable; null until setup step 2 succeeds), `created_at`, `updated_at`. Version 1 allows one TOTP factor per user; two-step sign-in is on when a confirmed factor exists.
- `user_backup_codes`: `id`, `user_id`, `code_hash`, `used_at` (nullable), `created_at`.
- `sign_in_challenges`: `id` (SHA-256 of the attempt token), `user_id`, `remember_me`, `attempts`, `expires_at`, `created_at`.

All three join `account-lifecycle/user-scoped-tables.ts` with `erasure: "cascade"` and `resets: []` (Clear Workspace and the memory resets do not touch account security), with the registry tests updated. The data archive leaves them out and says so in `EXCLUSION_NOTES`.

### 5.2 Codes and secrets

- **TOTP**: `@oslojs/otp` (SHA-1, 6 digits, 30-second step) with base32 from `@oslojs/encoding`; check their current docs before coding (AGENTS.md "Mandatory Docs Check"). A code is accepted for the current step and one step either side. Replay guard: find the step that matched and accept it only when it is greater than `last_used_step`, written in the same statement (`UPDATE … WHERE last_used_step IS NULL OR last_used_step < ?`), so two racing requests cannot both win.
- **Secret**: 20 random bytes, encrypted with `connections/vault.ts` (AES-256-GCM, key derived from `SESSION_SECRET`), shown to the person only during setup.
- **QR**: the `otpauth://totp/AlfyAI:<email>?secret=…&issuer=AlfyAI` URI drawn as an SVG on the server with `uqr`, returned inline. Never an online QR service.
- **Backup codes**: 10 codes of 10 characters from Crockford's base32 alphabet, shown as `XXXXX-XXXXX`, compared ignoring case, spaces and hyphens. Stored as HMAC-SHA256 with a key derived from `SESSION_SECRET` under its own label, so a copy of the database alone cannot be used to guess them. A code is spent with `UPDATE … SET used_at = ? WHERE id = ? AND used_at IS NULL`.
- Every comparison of a code or hash is constant time.

### 5.3 Sign-in flow

- `POST /api/auth/login` (JSON or form): the password check, decoy hash and limiter are unchanged. An account without a confirmed factor gets its session as today. An account with one gets no session: the server stores a `sign_in_challenges` row (5 minutes, `remember_me` kept) and sets the cookie `signin_attempt` (httpOnly, `secure` in production, `sameSite: "strict"`, `path: "/api/auth"`, 300 s). JSON callers receive `{ twoStep: true }`; a form post is redirected to the login page's code step.
- `POST /api/auth/login/two-step` (`{ code }` or `{ backupCode }`): looks the attempt up by the hashed cookie. Success creates the session (remember-me from the attempt), deletes the attempt and clears its cookie; a backup code also returns how many are left. A wrong code increments `attempts` and answers with the tries left; the fifth wrong code deletes the attempt. An expired or missing attempt answers "start again". Every wrong code also counts in `login-rate-limit.ts` for the account's email.
- The new route joins `PUBLIC_PATHS` in `hooks.server.ts` (exact match). No other public path is added.
- The login page keeps its current markup for the password step and swaps the card's body for the code step on `{ twoStep: true }`.

### 5.4 Settings and admin endpoints (all through the existing auth helpers; routes stay thin, logic in a service)

- `POST /api/settings/two-step/setup`: replaces any unconfirmed factor, returns `{ qrSvg, key }`.
- `POST /api/settings/two-step/confirm` `{ code }`: confirms the factor, creates 10 backup codes (returned once, in clear), signs out the other sessions.
- `POST /api/settings/two-step/disable` `{ code | backupCode }`: deletes the factor and the backup codes.
- `POST /api/settings/two-step/backup-codes` `{ code | backupCode }`: replaces the codes, returns the new ones once.
- The settings page load adds `{ twoStep: { enabled, since, backupCodesLeft } }`.
- `POST /api/admin/users/[id]/two-step/reset` `{ password, code? }`: admin only; refuses the admin's own account; checks the admin's password (and the admin's code when the admin has a factor); deletes the target's factor, backup codes and sessions.
- The admin users list gains `twoStepEnabled` (and the detail its `since` and `backupCodesLeft`).
- Browser calls live in `src/lib/client/api/` (`settings.ts`, `admin.ts`, an `auth` call for the code step), per `client/AGENTS.md`.

The service: `src/lib/server/services/two-step/` (a folder with an `index.ts` facade), not a new top-level `services/*.ts` file. Account behaviour that already lives in `user-admin.ts` and `auth.ts` stays there and calls into it.

### 5.5 Logging

Content-free `[AUTH]` lines with the user id only: two-step turned on, turned off, reset by an admin (both ids), a backup code used (codes left), an attempt that ran out of tries or time. Never a code, a secret, a key or an email address.

### 5.6 Recovery

`scripts/reset-two-step.ts`, run on the server as `npm run auth:reset-two-step -- --email <address>`: deletes that account's factor, backup codes and sessions and prints what it did. It is registered as a Fallow entry and documented in the README. It also covers a changed `SESSION_SECRET`, which makes every stored TOTP secret unreadable exactly as it does the connector credentials (document this beside the existing `SESSION_SECRET` warning).

## 6. Unchanged

The service assertion path, the admin drain bearer, the e2e `login()` helper for accounts without a factor, the password rules, and every page that does not mention two-step sign-in.

## 7. Migration and deploy

One migration adds the three tables and empties `sessions` (its ids become hashes and its expiry values change unit), so everyone signs in once after the deploy. The owner tells the family beforehand. `npm run db:prepare` runs it, as every deploy does.

## 8. Testing

- Unit: TOTP against the RFC 6238 appendix vectors (SHA-1), the one-step window, the replay guard (including two racing confirmations), backup code format, hashing and single use, attempt expiry and the five-try limit, the vault round trip, the session expiry test that fails before fix 1, token hashing on create, validate, logout and revoke, signing out other sessions on password change and on turning the factor on, the email change refusing without the password, the admin reset refusing the admin's own account and a wrong admin password.
- Integration: the whole sign-in through the API for an account with and without a factor; the public-path list.
- E2E (`tests/e2e/two-step-sign-in.spec.ts`, plus the existing `login.test.ts` and `settings-admin.spec.ts`): turning it on with the key shown in step 1 (the spec computes codes with the same library), signing in with a code and with a backup code, the wrong-code limit, turning it off, the admin reset. Both languages for the main screens.
- `scripts/gates.sh agent` with those specs at the end of every slice.

## 9. Review and rollout

An independent Opus security review of the whole diff before it merges into `dev`, then a fix round and a re-check. Before production: the release gate (`scripts/gates.sh release`), then the deploy to ai.dev and production together with the owner.

## 10. Not in this project

Passkeys (the factor table is ready for them), "remember this device", SMS or email codes, making it required, and password reset by email (there is no system mail).
