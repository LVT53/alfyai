# RV-SC — independent review of the Document×App merge and the in-chat artifact card

**Scope:** (A) the merge that integrated the Document slice with the App slice — `27a614e6` ("Merge Slice 1
(Document) into the artifact chat-card branch") plus its follow-up gate-gap fix `220ad0ab`. (B) the new in-chat card
for `create_artifact`/`edit_artifact` — `45027cce` ("the in-chat card for create_artifact/edit_artifact") plus its
e2e coverage `302e8bfc`. Branch `feat/artifacts-chatcard-review`, from `feat/artifacts-chatcard` `302e8bfc`. Reviewed
against `AGENTS.md` (the chat flow; the Artifacts section), `docs/plans/claude-at-home-2/slice-0.md` (Task S6, the
card's chrome contract), `slice-2.md` (Task A7, A7.4), and `decisions.md` rulings 43, 47, 48, 49, 50, 51, 55. Not
touched: the Document slice's own engine/editor code (`src/lib/shared/artifact-document/**`,
`src/lib/components/artifacts/document/**`), which two other reviewers are covering on their own branches.

**Method:** every defect below was reproduced red first (the red line is quoted), fixed with the smallest change,
and re-verified with the affected suites; one commit per defect, plus one immediate style fixup a lint pass caught
in the defect's own diff.

## Verdict: **merge, with one fix already applied**

**(A) is clean.** The merge commit's own description of how it resolved each conflicted file matches what is
actually on disk: `record.ts` took Slice 1's `updateArtifactBody` in full, and it really is byte-for-byte the union
of both sides' independent (and, on the `metadataPatch` shallow-merge, identically-shaped) additions — verified by
diffing both parents against the merge result and against their shared merge-base, not just reading the commit
message. Every exported function and every named test in `client/api/artifacts.ts`/`.test.ts` and
`cases.ts`/`cases.test.ts` from both parents survives in the merge result (`comm -23` against both parents' symbol
lists is empty both ways). `document`, `app` and `verification` all register in `EVAL_CASES` and `SUITE_SCORERS`,
and `run.ts`'s `--suite all` resolves them dynamically (`Object.keys(EVAL_CASES)`), not from a stale hardcoded list.
`limits.ts` carries both `ARTIFACT_KV_TOTAL_MAX_BYTES` (ruling 48) and `ARTIFACT_USER_VERSION_COALESCE_MS` (ruling
47) with the exhaustive-exports test pinning both. `i18n/artifacts.ts` has zero keys lost from either side and
EN/HU parity holds (`artifacts.test.ts`'s `Object.keys(hu).sort() === Object.keys(en).sort()`, run and green).
`artifact-tools/create.ts` has both `document` and `app` entries in `CREATE_ARTIFACT_HANDLERS`, both reading
ruling 55's `language` param. Coalescing semantics are correct at every call site I found
(`grep -rn "updateArtifactBody("`): every Alfy-authored write (`document-ops.ts`'s patch-apply, `app/regenerate.ts`)
omits `coalesceUserEdits`, `restoreVersion` passes `author: "user"` but never `coalesceUserEdits` (ruling 47's own
carve-out — a restore must not merge into the edit it sits beside), and the one route that opts in
(`PATCH /api/artifacts/[id]/body`) does so only alongside `author: "user"`; `updateArtifactBody` itself
double-guards with `params.author === "user"` regardless. `220ad0ab`'s own three fixes (the four missing
`language` fields, one JSDoc wording that tipped `no-ad-hoc-maps.test.ts`'s threshold, and a biome reformat) are
exactly what its message says and nothing more. No leftover conflict markers anywhere in the tree.

**(B) had one real defect**, matching exactly the shape `slice-0.md`'s own Task S6 warned about by name. Found,
proven red, and fixed on this branch (commit table below).

## Findings

| # | Where | What breaks, for whom | Test (red line) | Commit |
|---|---|---|---|---|
| B.1 | `components/artifacts/ArtifactCard.svelte` (chrome dispatch, `:145-198` pre-fix), called from `components/chat/ToolActivityRow.svelte:349-354` | `ToolActivityRow`'s row line already renders the tool call's own icon and title for every call ("Created Weekend plan" — status glyph, tool icon, verb, object — the same shape every other tool row uses). `45027cce` changed `ArtifactCard.svelte` so `chrome="body"` ALSO draws the full icon+title+kind-label+version header for every kind but File, so a `create_artifact`/`edit_artifact` card in chat shows the artifact's icon and title **twice** — once on the row, once again inside the "body." This is the literal regression `slice-0.md` Task S6 Step 1.1 named and pinned a test against before this feature existed: *"chrome='body' renders no title of its own... this is the regression a naive split causes."* File was kept on its original, unaffected branch (`chrome==='body' && kind==='file'`); the other four kinds were not so lucky — they fell into the `{:else}` branch that draws the full header regardless of `chrome`. | `ToolActivityRow.test.ts`, new: *"does not repeat the title inside the body..."* — red: `AssertionError: expected [ <span …(1)></span>, …(1) ] to have a length of 1 but got 2` (the row's `.act-object` span and the card's own `.artifact-card-title` span both showing "Weekend plan") | `7b67b293` |

No schema, migration, dependency, `biome.json`, `ALLOWED_WITHOUT_SCOPE`, or Fallow-config change. No new i18n key.
`f3daf328` is a same-diff format-only follow-up (`npx biome check` wanted a different line wrap in the e2e file
`7b67b293` touched); no semantic change, not a separate finding.

### The fix, precisely

`chrome="body"` once again renders **no** header (icon, title, kind label, version pill) for any kind — restoring
the invariant the component's own doc comment stated before `45027cce` touched it, and which is still true today:
every host that uses `chrome="body"` (only `ToolActivityRow`) already draws its own icon+title line. Body content
the header never owned — subtitle, tickable checklist items, the Open button — is unchanged and still renders
under `chrome="body"`, so the Document preview/checklist and the Open action this same card feature introduced are
unaffected; `chrome="full"` (the panel list, `DocumentWorkspace.svelte:913`, the feature's only other caller) is
untouched. Updated the tests that had pinned the buggy behaviour to match: `ArtifactCard.test.ts`'s own
chrome="body" test (now asserts no header, plus a new `chrome="full"` counterpart proving the panel path still
gets the full header), `ToolActivityRow.test.ts`'s per-kind and reload tests (title asserted on the row, not
re-found inside the card body), `ThinkingBlock.test.ts`'s two-cards-in-one-turn test (same reasoning).

While re-running `tests/e2e/artifact-chat-card.spec.ts` against a real `create_artifact` call to verify this end to
end, I hit and fixed two unrelated, pre-existing test-reliability issues in the same file (bundled into `7b67b293`
since they blocked getting a clean signal on the actual defect, same as `220ad0ab`'s own bundled gate-gap fixes):
the Document workspace's content check used the 5s implicit default while its neighbours already carry an explicit
30s budget (a cold dev-server run compiling the workspace's lazy preview chunk on first open can outrun 5s under
load — reproduces identically on unmodified `302e8bfc`, so it predates this fix); and a page-wide "title appears
exactly once" check after the post-reload Open was wrong on its own terms, because the workspace panel from the
*first* Open legitimately persists across the reload and correctly re-shows the title in its own, distinct region
— not a duplicate card body. Replaced with the same row-scoped assertion used during the live turn.

## Hunt list — what checked out clean

**(A)**
1. **No silently lost line or test.** See Verdict above — checked by symbol/test-name diff against both parents,
   not just by reading the merge commit's own description.
2. **No handler or suite that stopped registering.** `document`/`app`/`verification` all present in `EVAL_CASES`
   and `SUITE_SCORERS`; `document`/`app` both present in `CREATE_ARTIFACT_HANDLERS`; App's `edit_artifact` refusal
   ("Apps are not edited in place...") is a deliberate per-kind message on the shared "no handler registered"
   fallback path (`edit.ts`'s `UNSUPPORTED_KIND_MESSAGES`), not a missing entry — Task A8's requirement that the
   refusal specifically says to regenerate is met without needing a full `EDIT_ARTIFACT_HANDLERS.app` entry.
3. **No wrong coalescing semantics.** Every call site checked individually (see Verdict); the two new
   `record.test.ts` cases the merge commit's message claims (`a coalesced in-place user save still applies its
   metadataPatch`, `an Alfy write with a metadataPatch appends a new version rather than coalescing`) exist and
   pass.

**(B)**
1. **No regression for existing tool rows beyond the one fixed above.** File's card is provably unaffected — it
   never enters the `{:else}` branch my fix touches (`chrome==='body' && view.kind==='file'` is checked first and
   returns early in both the buggy and the fixed version); `FileProductionCard.test.ts` (unmodified, 0 changes)
   still passes in full. Every other tool body kind (`sources`, `page`, `python`, `map`, `atlas`, `text`,
   `bullets`, `actions`, `error`, `generic`) is untouched code, verified by running their component suites
   (`ToolActivityRow.test.ts`, `ToolActivityList.test.ts`, `MessageArea.test.ts`, `MessageBubble.test.ts`) alongside
   the fix — all green, none touched by this diff.
2. **Correctness of when a card appears.** `tool-activity.test.ts` (unmodified by my fix, still green) already
   covers: a card only from `metadata.ok === true` with all three fields present; a running create shows
   "Creating <title>" with `body: null` (no chevron, no stale card); a refusal or malformed metadata falls through
   to the generic identity/body, never fabricating a card; edit's card carries the edited item's own
   id/kind/title from that call's metadata. `ThinkingBlock.test.ts`'s "renders one card per successful call when a
   turn makes several artifacts" (updated for the fix, still asserts two distinct cards for two distinct calls) —
   green.
3. **Ownership/incognito.** `conversationId` reaches the card's Open action through the same, already-existing,
   page-scoped prop MessageBubble already threads for attachments (`MessageArea → MessageBubble → ThinkingBlock →
   ToolActivityList → ToolActivityRow`, all plain prop-forwarding, no second source of truth) — never a new,
   independently-sourced value that could drift from the page's actual conversation. The preview enrichment
   (`ThinkingBlock.svelte`'s `buildEnrichedToolActivityItem`) matches `conversationArtifacts` — itself
   `ConversationDetail.artifacts`, already scoped to this conversation by the read model — by exact id, so it
   cannot attach another conversation's preview even if ids collided across conversations (they don't; they're
   UUIDs).
4. **Ticking.** The card's `tickable.onToggle` (`ToolActivityRow.svelte`'s `artifactCardView`) calls
   `onToggleDocumentTask?.(body.artifactId, blockId, checked)`, threaded from the chat page's existing
   `handleToggleDocumentTask` — the exact same function reference the panel's own list already uses, updating the
   same `artifacts` state both read. Not a reimplementation; genuinely one write path.
5. **Streaming performance — measured, not just reasoned.** `buildEnrichedToolActivityItem`'s only new cost over
   the pre-existing (and already inline-per-render, by the file's own design comment) `buildToolActivityItem` call
   is one `conversationArtifacts.find(...)` per artifact-kind row. Microbenchmarked the added cost directly
   (plain `Array.prototype.find`, the realistic shape): 10 rows × 50 conversation artifacts × 200 re-renders =
   0.70ms total (0.0035ms/re-render); the review's own stress case, 300 segments × 300 artifacts × 200
   re-renders = 36ms total (0.18ms/re-render); a deliberately pathological 1000×1000×500 = 625ms total
   (1.25ms/re-render). All comfortably sub-frame even at the pathological end, and reasoning bursts (the file's
   own `REASONING_STALL_MS` comment: "the server batches reasoning text in >=20-char bursts") arrive far less often
   than per-token. Concluded: a real but bounded incremental cost on top of an already-accepted pattern, not a new
   asymptotic problem — not a defect.
6. **a11y/i18n.** The card body (everything inside `.artifact-card` outside the Open button and the tick
   `<input>`s) has no `tabindex`; Open is a real `<button type="button">`; each tick item is a real
   `<input type="checkbox">` inside a `<label>`, so Space toggles it natively. "Created"/"Creating"/"Edited"/
   "Editing" are EN + natural HU (`Létrehozva`/`Létrehozás` already existed; `Szerkesztve`/`Szerkesztés` follow the
   identical past-participle/action-noun pattern `45027cce` added). No dictionary value anywhere contains the word
   "Artifact" (checked every `toolActivity.*` value, and `artifacts.test.ts`'s own repo-wide check, both green).
   The row's new "artifact" icon type is Lucide's `LayoutGrid` with `aria-hidden="true"`, matching the icon policy.

## Open questions (no code — a shared-code observation, not this branch's to fix)

1. **A refused/conflicting tick's checkbox may not visually revert (shared with the panel, not new here).**
   `handleToggleDocumentTask` (pre-existing, Slice 1's) does nothing to the `artifacts` state on `!result.ok`; the
   tick `<input>`'s `checked={tickItem.done}` is a plain (not `bind:`) binding, so if the boolean value genuinely
   never changes, there is no guaranteed re-assertion of the DOM `checked` property back over whatever the
   browser's own native click already flipped. If real, this affects the panel's list identically — it is the
   exact same markup and the exact same handler, not something the chat card introduces — so it belongs to the
   Document slice's own review, not this one. I did not attempt to prove or disprove it further, since doing so
   would mean auditing Slice 1's own tick UI rather than this merge or this card.

## Gate summary

Full gate run at this branch's HEAD (`gates.sh … rv-sc 5670 rv-sc tests/e2e/artifact-chat-card.spec.ts
tests/e2e/artifact-document.spec.ts tests/e2e/artifact-app.spec.ts tests/e2e/artifacts-panel.spec.ts
tests/e2e/streaming.spec.ts`, which also runs `chat.spec.ts` and `conversation.spec.ts`; biome ran as
`npx biome check src scripts tests` per the known nested-worktree `npm run lint` issue):

```
gates rv-sc at 7b67b293 fix(artifacts): stop the in-chat card from repeating its own ti — start 14:40:53
check      exit=0 :: COMPLETED 7936 FILES 0 ERRORS 17 WARNINGS 3 FILES_WITH_PROBLEMS
biome      exit=1 :: (ran against 7b67b293, before the f3daf328 format-only follow-up — see below)
migrations exit=0 :: All schema tables have corresponding migrations.
test       exit=0 ::  Test Files 886 passed | 1 skipped (887)  Tests 13226 passed | 2 skipped (13228)
build      exit=0 :: unused-css=32 aria=2 (baseline 32/2)
fallow     exit=0 :: total=124 circular=4 new_vs_baseline=0 gone_vs_baseline=0
playwright exit=1 ::  1 failed  62 passed (4.0m)
done 14:47:32
```

The gate script's own biome step ran against `7b67b293`, one commit before the format-only follow-up; rerun
directly at `f3daf328`: `npx biome check src scripts tests` → `Checked 2115 files … Found 2 warnings` (the
pre-existing `extensions.ts` dead-code pair, unrelated to this branch).

The one Playwright failure — `artifact-document.spec.ts:471` *"the More sheet opens without scrolling the
document, and Escape returns focus to its trigger"* — timed out in `createConversation`'s own setup (`send-button`
never became enabled inside 60s, under four other reviewer worktrees' gate runs hammering the same machine
concurrently: `rv-1a`, `rv-1b`, `art-focus` and others were all mid-`vitest`/mid-`playwright` at the same moment).
Not a file this branch touches — Document mobile-toolbar layout, outside both (A) and (B). Reran alone,
per the brief's own instruction for exactly this situation: **passed in 12.0s**
(`E2E_PORT=5670 npx playwright test tests/e2e/artifact-document.spec.ts -g "the More sheet opens..."`). Treated as
the same class of shared-machine flake as the two Docker-sandbox tests named in the brief, not a defect.

Containment suite, run directly: `npx vitest run tests/cross-cutting/incognito-artifact-containment.test.ts` →
**30 passed (30)**, unchanged (the file, and `ALLOWED_WITHOUT_SCOPE`, are untouched by this branch).

| Gate | Implementer's baseline (`302e8bfc`) | Now (`f3daf328`) |
|---|---|---|
| `npm run check` | 0 errors / 17 warnings | 0 errors / 17 warnings — unchanged |
| biome | 2 warnings (`extensions.ts`, pre-existing) | 2 warnings (same pair) — unchanged |
| `check:migrations` | clean | clean — unchanged |
| `npm test` | 13,223 passed / 2 skipped | **13,226 passed** / 2 skipped (+3, this review's new/updated cases; 0 failed) |
| `npm run build` | 32 unused-CSS + 2 ARIA | 32 + 2 — unchanged |
| Fallow | 124 / 4 circular, 0 new | 124 / 4 circular, 0 new — unchanged |
| Playwright (this gate's 7 specs) | n/a (different spec set than the implementer's own baseline run) | 63/63 (62 green outright, 1 confirmed a shared-machine flake, green alone) |
| containment suite | 30/30 | 30/30 — unchanged |

## Branch

`feat/artifacts-chatcard-review`, worktree `.claude/worktrees/rv-sc`, from `feat/artifacts-chatcard` `302e8bfc`.
Two commits on top: `7b67b293` (the fix, test-first) and `f3daf328` (its own format fixup), then this file. Not
pushed, not merged.
