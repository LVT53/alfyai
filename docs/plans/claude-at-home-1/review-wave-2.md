# Wave 2 adversarial review — Slice C (Personal Instructions)

**Date:** 2026-09-24. **Reviewer:** one, in its own worktree, not the implementer.
**Branch under review:** `feat/workspaces-c` (seven commits, 52 files, +3 044 / −22).
**Review branch:** `feat/workspaces-c-review`, merged as part of `57bec090`.

## Outcome: no production defect found

The reviewer hunted the full list and cleared every target. The only defects it found were **gaps in test
coverage**, closed by three test-only commits. That is a materially different result from Wave 1 (which found
five real defects including a stored-number-vs-typed-number bug) and worth stating plainly: Slice C's
implementation was sound, not merely under-examined — the reviewer reproduced the risky behaviours itself and
tightened the assertions until they had teeth, including deliberately re-tightening a bound to confirm a test
would fail.

## Cleared, with the evidence that matters

| Target | Verdict |
|---|---|
| Decision 2 — no new DB reads in prompt assembly | **Cleared.** `resolveTurnInstructions` runs once per turn in `chat-turn/shared-normal-chat-model-run-helpers.ts:330-353`, outside assembly; `prepareOutboundChatContext` receives instructions as data. |
| Decision 3 — protection by ordering, not sanitisation | **Cleared.** All three stripper triggers survive inside user text, and a user's own `## Project Instructions` survives as indented literal text. Only indentation/whitespace is touched — no escaping or rewriting anywhere in the path. |
| Decision 1 — the order assertion replaced, not deleted | **Cleared, and not vacuous:** the assertion fails if instructions precede Response Style, and the dropped `endsWith` clause is named in the commit message. |
| The 2 000-code-point limit | **Cleared** at 2 000 / 2 001 / astral emoji / accents / whitespace-only / 2 001-with-trailing-spaces. Browser and server both use `countInstructionChars(normalizeInstructionText(...))`. Over-limit is a `400` that writes nothing. |
| Prefix-cache contract | **Cleared.** Byte-identical system message across repeated turns *and* across two different conversations by the same user; nothing turn-varying smuggled into the section. |
| Audit row | **Cleared**, including the negative cases: nothing set, cleared mid-conversation, and clearing stops application on the next turn. Both regeneration paths replace the message with a fresh placeholder, so a stale claim cannot be resurrected. |
| `''` vs NULL parity | **Cleared** for every reader, including the archive and erasure paths. |
| Auth / ownership | **Cleared.** `requireAuth` plus `eq(users.id, userId)`; no cross-user path. |
| Incognito | **Cleared.** Incognito gates memory recall only; instructions still apply, as intended. |
| i18n EN/HU | **Cleared.** 13 keys, identical sets, parity audits green. |
| Mobile 390×844 (§M2, §M7) | **Cleared.** Dialog is a bottom sheet inside the viewport; the §M7 row is covered by the existing spec. |
| `services/instructions.ts` as a new boundary | **Judged a genuine boundary, not a file that grew** — a distinct read concern consumed independently by prompt assembly, the audit row and the archive, and it already returns `null` for the project scope without touching the DB, which is Slice D's seam. |

## Test gaps closed (the review's three commits)

- `23d4b312` — the dialog's re-seed on reopen: an abandoned edit (Cancel then reopen) and a re-seed after save
  were untested and would have regressed silently. The new tests fail if `applySeed()` is removed from the
  `$effect`, so they have teeth.
- `5acb6ab6` — clearing, prompt byte-identity, and cross-conversation identity.
- `ac460aa1` — the dialog's phone presentation. The test first failed measuring the sheet mid-slide
  (`Received: 1154.19`) — a race in the test, not a product defect — and was fixed with `expect.poll`; the bound
  was then tightened to 700 to prove the assertion would fail if the sheet really overflowed.

## Reported, not fixed (out of scope)

- `ScopeToken.svelte:16-17` — a comment claims the Settings row uses `size="md"`; that row uses no `ScopeToken`.
  Comment-only mismatch, in Slice D's contract surface.
- `chat/[conversationId]/_helpers.ts:875-876` — the `instructionsApplied` merge is asymmetric with the guarded
  `userIntent` form above it. Currently unreachable for staleness (no placeholder builder emits the field), so an
  observation, not a live defect.
- Fallow advisories only: an 8-line dupe group between two test files, and `buildSeed` CRAP 37.1.

## Not verified

- No live-provider prefix-cache-hit measurement; byte-identity of the assembled system message is the strongest
  in-process proxy.
- Slice D's project-scope path through the same dialog (the scope switch, the `appendedLine` highlight,
  `switchTo`/`stripPending`) was exercised only by unit fixtures — the real project entry point did not exist yet
  at review time. **This is the one thing Wave 3 must re-check once Slice D lands**, and it is called out in the
  Slice D review brief.

## Gate numbers (reviewer's branch)

`npm run check`: 0 errors, 17 pre-existing warnings. Biome: 1 pre-existing. `npm test`: **11 780 passed / 2
skipped**, 781 files. `npm run build`: exit 0, 34 warning-shaped lines = the pre-existing 17 × 2. Migrations
pass. Fallow: 124 issues, 4 cycles, no Slice C file among the findings. Playwright: `instructions-dialog` 4
passed, `settings-profile-redesign` 13 passed.

## Deployed

`dev` pushed `66a37cbc..57bec090` and deployed to `ai.dev.alfydesign`.
