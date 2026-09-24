# Wave 1 adversarial review — Slice A and Slice B

**Date:** 2026-09-24. **Reviewers:** one per slice, each in its own worktree, neither of them the implementer.
**Branch under review:** `feat/workspaces` = `98a34dfd` (dev) + Slice A + Slice B.

Slice A and Slice B were implemented in parallel and their changed-file sets are disjoint (`comm -12` of the two
name lists is empty). Each was reviewed separately, and each review produced fixes that were merged into
`feat/workspaces`.

---

## Slice A — the removals, the data migration and the docs

Review branch `feat/workspaces-a-review`; five commits merged.

### Defects found and fixed

| # | Defect | Evidence |
|---|---|---|
| 1 | `FinalizeChatTurnParams.linkedSources` was declared and never read. The whole dead chain went with it: `CompleteStreamTurnParams.linkedSources`, the pass-through in `stream-orchestrator.ts`, and the two `finalizeChatTurn({ …, linkedSources })` arguments in the send route. The genuinely live `snapshotAtlasLinkedSources(...)` reader/writer was kept. | guard `context-sources-removal.test.ts` 1 failed \| 20 passed before, 21 passed after |
| 2 | `listTaskEvidenceLinks` and its row mapper `mapTaskEvidenceLink` had no caller left. **Found by a hand sweep for orphaned exports, not by Fallow** — `.fallowrc.json` ignores exports under `src/lib/server/services/**`, so the tool is blind exactly where this slice worked. | guard 1 failed \| 20 passed before, 21 passed after |
| 3 | `getContextDebugState`'s `pinnedEvidence`/`excludedEvidence` could only ever be `[]` — their only writer was deleted with the panel — so the ring's two rows could never render. Fields, producers, both `{#if}` rows, 4 i18n lines and the fixtures went. `selectedEvidence` and every other live field stayed. | guard 6 failed \| 15 passed before, 21 passed after |
| 4 | **`CONTEXT.md:646` asserted a false cause**: that the surface was removed *because* message bubbles never read the props. `git show 1aeea62e` shows the *effect* chain was live. Corrected in place; the commit history was deliberately not rewritten. | see the retraction recorded in `decisions.md` |
| 5 | A test comment still named the deleted `EvidencePreferenceControl` as if it rendered the app's only `<select>`. Reworded into a regression guard. | — |

### Deliberately kept, and removing it would be wrong

`TaskEvidenceRole` still lists `"pinned" | "excluded"`: those remain legal values of the
`task_state_evidence_links.role` column (no schema change ships with the migration, and the column still holds
`checkpoint_source`/`selected` rows), the migration only deletes `origin='user'` rows, and
`task-state-learning.test.ts` is now a negative test that seeds exactly such rows and asserts selection ignores
them. There is no surviving pinned/excluded scoring branch.

### Cleared

- **The migration's `WHERE` clause, both directions.** `upsertEvidenceRole`'s role parameter was the literal
  union `"pinned" | "excluded"` and both its DELETE and its INSERT were gated on `origin = 'user'`, so the clause
  matches its write set exactly. `origin` is NOT NULL defaulting to `'system'`, so a NULL origin is impossible.
  The deleted `document-preferences.ts` kept its rows in this same table, so no orphan rows were left elsewhere.
  The migration's own test seeds the boundary (pinned/user and excluded/user deleted; pinned/system,
  selected/system and selected/user survive — 3 of 5).
- **The keep-list**, each item by a live consumer: `/document` and `/source` still parsed, `linked-context-sources.ts`
  and `linked_context_source` links intact, the atlas snapshot still written by the send route, the compaction
  indicator and `contextStatus` intact, the `contextDebug` fallback chain intact, the read model still assembling
  its other fields.
- **The streaming-contract change**, with the consequence reasoned out: a pre-change frame still carrying
  `contextSources` is mapped through a whitelist, so it looks *more* receipt-only, which routes the browser to
  refetch durable detail. That is the safe direction — the removed field could only ever suppress hydration.
- **i18n:** 117 orphaned entries exist in `chat.ts`, but **none newly orphaned by this slice** (proven by diffing
  the literal key sets). All 33 `AUDITED_PREFIXES` still match at least one key, so the parity auditor is still
  honest.
- **The ADR edits:** ADR-0043's dated in-place correction is true (`git log -S` finds no Knowledge-library pin
  surface), and the ADR-0004/0006 superseded notes are attached to the right slices.
- **Incognito containment:** the 30 containment tests pass; the slice adds no `ALLOWED_WITHOUT_SCOPE` entry, no
  scope marker and no new table or route, and it only narrows the API surface.

### Reported, not fixed (out of scope)

- Pre-existing inertness of `conversation_task_states.locked` (`task-state.ts:738`, `:781`, the always-inert
  `taskDebug.taskLocked` and its now-orphan i18n keys). Predates the slice and touches task-routing determinism.
- Four pre-existing unused locals/imports (`MessageInput.svelte:15`, `:522`, `MessageBubble.svelte:374`,
  `chat/[conversationId]/+page.svelte:20`). Traced to commits on `origin/main`; biome disables
  `noUnusedImports`/`noUnusedVariables` for `**/*.svelte`, which is why they are machine-invisible.

### Not verified

No dry run of the `DELETE` against a copy of the production database — the verdict rests on the writer's source,
the schema constraints, a repo-wide search for other preference tables and the migration's boundary test. The
real row count will be read from the dev deploy. No rendered visual pass: the change is removal-only and no
§M1–§M9 mockup depicts the removed surface, so "no layout regression" rests on that argument, not on a render.

---

## Slice B — the Parallel free monthly allowance

Review branch `feat/workspaces-b-review`; two commits merged.

### Defects found and fixed

| # | Defect | Evidence |
|---|---|---|
| 1 | **The admin allowance field rewrote the digits as they were typed.** With the field pre-filled `5.00`, selecting it and typing `2.5` produced `2.005`: the live draft was reformatted on every keystroke, so `2` became `2.00`, the `.` keystroke was swallowed (a bare trailing `.` is invalid, so the input reports `""`) and the `5` landed after the zeros. The number stored was not the number typed. Fixed so a dirty row shows the draft verbatim while a settled value still reads as money. | Playwright, `E2E_PORT=5192`: failed `Expected "2.5", Received "2.005"`, then 10 passed |
| 2 | `docs/configuration.md:163` claimed the allowance "can be changed in admin config and takes effect on the next call". True for the env path, false for the admin path: saving in admin config **also replays the running month** (`admin/config/+server.ts:183-193`). That is the sentence an operator reads to decide whether lowering it mid-month re-charges the month. Corrected. | two code sites; no doc-assertion harness exists in the repo |

### Cleared

- **The arithmetic at the boundary.** Negatives, fractions, `NaN`, `Infinity` clamped; a month exactly equal to
  the allowance bills 0; `allowance 0` bills everything; the crossing call books only its remainder; a series
  summed one call at a time equals the one-pass total with 0 mismatches, so there is no float drift. USD→micros
  happens exactly once per site with the identical expression, verified by reading every getter call site.
- **Races across two turns, two users, one month.** `recordParallelUsage` is the only writer of `parallel:*`
  rows — every write path was enumerated independently — and its count-plus-insert runs inside one synchronous
  `db.transaction` (better-sqlite3, single process, no `await` between read and insert). Retry, reconnect,
  resume and the stream route all funnel through that same recorder.
- **The retroactive recompute:** identical rule to booking, month-scoped, never larger than unallowed, never
  negative, unaffected months untouched, second `--apply` reports `changed=0`.
- **Config plumbing:** all six touch points present, no `process.env` read outside `env.ts`, the getter honours
  admin overrides, and hostile input was enumerated (`-1`, `NaN`, `Infinity`, `5.`, `1e3`, `1e-7`, `2.5.5`,
  `1,5`, `+2.5`, `0x10`, blank, `1000001`, `0`).
- **The replay script:** idempotent, dry-run by default, refuses to guess a database, correct on a second
  `--apply`. Re-verified against a scratch database the reviewer built itself.
- **The `.fallowrc.json` change** is the documented standalone-script case, not a suppression hiding dead code —
  proven by measurement (the base tree's `unused_files` set is unchanged).
- **"No user-visible change"**: the diff touches only admin surfaces, server config/analytics, docs and tests.
- **i18n parity**, **Svelte 5 reactivity** elsewhere in the admin UI, and **mobile at 390×844** vs §M9 (the
  analytics-chassis scroll at 609/356 is pre-existing and reproduces on untouched code).

### Reported, not fixed (needs a design call)

`src/lib/config/admin-config-registry.ts:938-941` — the `number` validator accepts `"0.0000001"`, canonicalizes
it via `String(parsed)` to `"1e-7"`, and then the same validator's `/^-?\d*\.?\d+$/` rejects that on the next
save, so a PATCH echoing the stored value returns 400. Fixing it means either accepting exponent notation —
which this slice's own test explicitly pins as rejected (`1e3` → not-a-number) — or adding a new validation
reason plus EN/HU strings. Pre-existing validator behaviour, inherited by the new key; reachable only by
deliberately entering a sub-micro-dollar allowance. **Owner decision needed if it is to be fixed.**

Observation with no money effect: per-row attribution among same-second rows follows `(createdAt, id)` where `id`
is a random UUID and `createdAt` has one-second resolution. Totals are order-independent and the replay is
idempotent.

---

## The `git log -S` line decision 6 asked for

The "Manage context sources" surface had **not** gone inert. Only its display chain was dead — the pinned/
excluded props handed to the message bubbles were never read. Its effect chain was live end to end: the panel's
writes reached `prepareTaskContext`, which dropped excluded artifacts from the candidate set
(`1aeea62e:src/lib/server/services/task-state.ts:1180-1207`) and passed pinned ids to `context-selection.ts`,
which force-included and boosted them (`:1708`, `:1985`, `:2084`). The removal therefore takes a working
capability away, and it stands on the owner's "I never used it" — not on the feature being dead. `decisions.md`
decision 6 carries the retraction.

---

## Gate results

### On the reviewers' own branches (as reported by them)

| Gate | Slice A review | Slice B review |
|---|---|---|
| `npm run check` | 0 errors, 17 warnings, no new | 0 errors, 17 warnings, no new |
| `npx biome check src scripts tests` | 1 pre-existing warning | 1 pre-existing warning |
| `npm test` | 771 files, 11 648 passed / 2 skipped | 775 files, 11 695 passed / 2 skipped |
| `npm run build` | exit 0, the same 17 pre-existing warnings | exit 0, 17 unique warnings (34 lines) |
| `npm run check:migrations` | passes | passes |
| Fallow | 124 issues, 4 cycles — byte-identical to baseline | 124 issues, 4 cycles — identical issue sets to a base run |
| Playwright | chat 11 passed; streaming + conversation 21 passed | settings-admin-system 10 passed |

**A note for whoever reads the build log next:** `vite-plugin-svelte` prints the 17 warnings with no
"warning"/"warn" anywhere in the line, so counting by that word reports zero. Count `Unused CSS selector` plus
`must have an ARIA role`; each warning appears twice, once per build pass.

### On the integrated `feat/workspaces` (orchestrator's own measurement)

Slices A and B plus both review branches merged, at `66a37cbc`:

| Gate | Result |
|---|---|
| `npm run check` | 7666 files, **0 errors, 17 warnings**, 3 files — all pre-existing, none touched by this wave |
| `npx biome check src scripts tests` | 1836 files, **1 warning** (`MessageEvidenceDetails.svelte:298`), pre-existing |
| `npm test` | **774 files passed / 1 skipped (775); 11 692 tests passed / 2 skipped (11 694)** |
| `npm run build` | exit 0, **34 warning lines = the same 17 pre-existing warnings × 2 build passes** |
| `npm run check:migrations` | passes |
| Fallow | **124 issues, 4 circular dependencies** — identical to both reviewers' baseline runs. `stale_suppressions` 0, `policy_violations` 0, `boundary_violations` 0: no new suppressions were added anywhere. |

**Deployed to the dev environment** as `66a37cbc` (`dev` pushed, `98a34dfd..66a37cbc`).

**Dev database, measured before the deploy:** `task_state_evidence_links` holds 33 rows, all
`selected | system`. The migration's `WHERE role IN ('pinned','excluded') AND origin='user'` therefore matches
**zero rows on dev** — it is a no-op there, which independently corroborates the owner's "I never used it".

**Pre-cutover check for the owner:** nobody has counted the same rows on **production**. The classifier correctly
blocked me from reading prod's database, and I did not work around it. Before the cutover someone with authority
should run, read-only, on `langflow-chat/shared/data/chat.db`:

```sql
SELECT role, origin, COUNT(*) FROM task_state_evidence_links GROUP BY role, origin;
```

If that returns `pinned|user` or `excluded|user` rows, the cutover will delete them — which is the intended
one-way behaviour, but the owner should see the number first.
