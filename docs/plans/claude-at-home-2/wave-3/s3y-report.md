# S3-Y report · three known fixes before the Canvas review

Agent S3-Y, model `claude-sonnet-5-5`. Worktree `.claude/worktrees/art-s3y`, branch `fix/artifacts-w3-small`
(from `be284abf`), e2e port 5520. Status: **DONE_WITH_CONCERNS** (one S3-Z assertion changed with the storage model, §Deviations 1).
No dependency added, no migration, nothing pushed, `docs/plans/**` and AGENTS.md untouched, no subagent, no live model call.

Commits (`be284abf..1f32c627`, all with the `Co-Authored-By` trailer):

| commit | what |
|---|---|
| `151ab577` | Fix 1: the tab remembers a panel per chat (module + unit tests) |
| `63529678` | Fix 1: three e2e cases beside S3-Z's four |
| `2a2dc167` | a comment on S3-Z's unit block that said "ONE tab-wide record" |
| `41aa4f0b` | Fix 2: the Canvas edit rule says a block keeps its kind; the refusal names the ops; ceilings + both frozen snapshots |
| `1f32c627` | Fix 3: the App verifier counts its tokens |

## Fix 1 · each chat remembers its own panel

**What was wrong.** One record per tab: visiting chat B overwrote A's panel, and a chat with an empty panel
(the save effect runs on every mount) removed the record altogether. So A → B → A never gave A its panel back.

**What it is now** (`src/lib/client/document-workspace-state.ts`; the chat page is unchanged, the function names and
required arguments are unchanged):
- The tab keeps a panel per chat, the **last 20** it saw (`MAX_PERSISTED_PANELS`), the chat visited longest ago going
  first. Saving a chat's panel makes it the newest; a chat restored and re-saved on every visit is therefore an LRU.
- Stored value: the newest panel at the top level exactly as before, the earlier chats' panels under `others` (newest
  first). A value written by the previous build is one panel and reads as one; the e2e helper that reads
  `record.documents` still gets the chat on screen's panel; a rollback to the previous build reads the newest panel.
- **Rules kept (all S3-Z's tests pass, one assertion aside):** a chat restores its own panel whole (a parent's item
  included); a chat with none takes only what belongs to it plus library/search opens from the chat visited last
  (`carriesUnownedOpens`, never into an incognito chat); if the item on screen was not carried the panel stays closed and
  docked; a panel that does not say whose it is (legacy) gives only the asker's own items.
- **Incognito, stronger than before, in one invariant:** whenever any chat *loads*, every other incognito chat's panel
  is removed from storage on the spot (only that entry now, not the whole record); whenever any chat *saves*, no other
  incognito chat's panel is written back; leaving an incognito chat (`onDestroy`) and deleting one drop only its entry;
  an incognito chat never receives a normal chat's opens; a normal chat's panel survives an incognito detour.
- Decisions the tests pin: (a) **a chat with a panel of its own gets only that panel** (the library opens of the chat
  visited last do not follow into it); (b) an **emptied panel is kept as an empty panel** (it counts toward the 20), so
  what a chat closed is not handed back to the next new chat by an older chat that still has it open; when nothing is
  open anywhere the key is removed as before; (c) deleting a chat drops its own panel whole and takes its items out of the
  others' (a panel that was closed stays closed; the old code forced `isOpen` true for any remainder).
- Signatures: `loadPersistedWorkspaceDocumentState`, `discardPersisted…OfIncognitoConversation` and
  `removeConversationFrom…` now take storage with `getItem`/`setItem`/`removeItem` (they may write back what they keep);
  `savePersisted…` needs `getItem` too. `window.sessionStorage` and every test adapter already had all three.

**Tests (first, seen failing).** `document-workspace-state.test.ts` 18 → 38: 12 of the 20 new tests failed on the
single-record module (the other 8 are guards that pass on both: stale age-out, garbage values, "another chat's save
drops an incognito panel"). They cover: A → B → A whole (active id, presentation); a chat visited with nothing open does
not wipe A; the bound (25 chats → the newest 20 remain, exactly); LRU (a chat saved again outlives an older one); a
week-old panel is forgotten and the rest kept; own panel wins over the carry; a closed open is not resurrected; the five
incognito rules above; a stamped legacy value keeps its chat's panel beside a new one, an unstamped one is dropped on the
next save; non-JSON / non-panel / `null` / `others` that is not a list or has junk in it read as nothing or as the valid
newest panel, never throw; and the stored shape (newest top-level, others below).
E2E `artifacts-panel-scope.spec.ts` 4 → 7 (S3-Z's four pass unchanged): A → B → A in the app with B keeping its own;
a reload in B in between; a visit to an incognito chat in between (A's board is back, and neither the private board's
id nor its title is anywhere in what the tab stores). All three failed on the single-record module (A's panel never came
back). I swapped the old module in for that run and back.

## Fix 2 · the edit tool says a block keeps its kind

- `kind-prose.ts`, Canvas edit rule (the one sentence set both `edit_artifact`'s description and the `@Alfy` comment
  prompt use, `editArtifactRuleClause`), appended:
  EN "A block's kind cannot change: remove it and add a new one."
  HU "Egy blokk típusa nem változtatható: töröld, és adj hozzá újat." (vocabulary of the UI's "blokktípus" and the HU rule's
  "blokk"). No op name in the prose (the header's rule: op names live in the schema; the existing "names no op in prose
  that the schema does not have" test still guards the ones that are there).
- The refusal for `update_node` with a different `data.kind` already named the fix in words ("Remove it and add the new
  one"); it now also names the two ops: "…: remove_node, then add_node." (ruling 62: a refusal names the valid ops). A test
  checks the two names are in `BOARD_OP_NAMES`.
- **Catalogue (ruling 62/23), measured with the tripwire's own estimator (`ceil(chars / CHARS_PER_TOKEN)`, summed over
  descriptions):**

  | | before | after | spent | ceiling before → after |
  |---|---|---|---|---|
  | en | 5,002 | 5,017 | +15 | 5,028 → **5,043** |
  | hu | 8,117 | 8,139 | +22 | 8,144 → **8,166** |

  Each ceiling = new measurement + the same margin (26 en / 27 hu). `edit_artifact` alone: 426 → 441 en, 678 → 700 hu
  (per-tool ceiling 750 untouched). Both frozen snapshots re-written in the same commit; each differs by exactly one line
  (edit_artifact's description) and that one clause. The numbers are in the commit message and in the test's history comment.
- Tests first: `canvas-handlers.test.ts` (the rule says it in both languages) and `board-ops.test.ts` (the refusal row
  now expects `remove_node` and `add_node`) failed before; then the two snapshot tests until `-u`.

## Fix 3 · the App verifier counts its tokens

- **Where.** `services/artifacts/app/verify.ts`: the verifier call and the re-verification go through
  `runPlainNormalChatModelRun`, whose usage is `{inputTokens, outputTokens, totalTokens, cache…}`; `toModelCallUsage`
  read `promptTokens`/`completionTokens`, so both rows written to the ledger (`app_verification_verifier`,
  `app_verification_reverify`) had 0 prompt and 0 completion tokens and priced at 0 (`calculateCostUsdMicros` prices those
  two). It compiled because the param type is all-optional and `totalTokens` matched by name. The classifier goes through
  the control-model helper (prompt/completion already) and was right; the comment paths use the same helper and are right;
  `runPlainNormalChatModelRun` has no other caller outside the chat turn (which uses the mapper).
- **Fix.** The run's usage goes through `mapNormalChatModelRunUsageToProviderSnapshot`, the mapper the generator's cost
  record already uses (`toModelRunUsage`); `AppModelCallUsage`, `sumUsage` and `recordVerificationCost` carry
  `cacheHitTokens`/`cacheMissTokens` too, so a cache-priced model is priced like the generator's call (this also fixes the
  classifier's row, which dropped them). A run that reports only a total or nothing still counts as a call (zero row, no
  NaN); `AppVerification.usage` stays non-null whenever any call ran.
- **Tests first.** The test fixtures gave the run the classifier's vocabulary (`promptTokens`…), which is how this went
  unseen; `verifierResult` now uses the run's own, the module mock gains the mapper (mirrored, as `generate.test.ts` does),
  and four tests read what is recorded per call and the summed `usage`: verifier 500/100/600, re-verification 700/30/730,
  the classifier 50/10/60, the sum 1250/140/1390 with a repair; the cache breakdown passes through; total-only / nothing.
  Three failed on the old code (`promptTokens: 0`), the fourth is a guard.
- **The cost the user sees.** The conversation's cost readout (`totalCostUsdMicros` on the chat page, from
  `getConversationCostSummary` in `conversation-detail/read-model.ts` and `context-status`) is `SUM(usage_events.cost_usd_micros)`
  for the conversation, and `recordControlModelUsage` writes those verification rows with the conversation id, so once the
  tokens are right the dollars are included; **there is no per-card cost figure** (the App card/body read only
  `metadata.verification`, verdict and reason). The token totals were always right; only the dollar cost under-reported, and
  only for a priced model. What I did **not** do: a live or DB-backed priced run (the price-rule lookup needs the config's
  model name and a decryptable provider row; the argument-level tests plus the unchanged analytics pricing cover it).

## Gates (final tree `1f32c627`, one run each)

| gate | result |
|---|---|
| `npm run check` | 0 errors, 17 warnings (baseline: ToolActivityRow 10, ThinkingBlock 6, RouteItinerary 1) |
| `npx biome check src scripts tests` | clean (2,339 files) |
| `npm test` | 965 files passed (1 skipped), **15,238 tests passed** (2 skipped) |
| `npm run build` | exit 0, 32 `Unused CSS selector` + 2 `must have an ARIA role` (= baseline) |
| Playwright, 25 artifact/knowledge/chat/conversation files, 288 tests, port 5520 | 287 passed, 1 failed: `artifact-canvas.spec.ts:291` "moves between the menu's rows with the arrow keys, one tab stop" (`menuitem.first()` not focused after ArrowDown; a Canvas Insert-menu test I did not touch). **The whole `artifact-canvas.spec.ts` rerun alone: 27/27 passed** (a combined-run focus-timing flake) |
| Fallow | 124 issues, 4 circular (= baseline), 0 new (no new export anywhere) |
| `npm run check:migrations` | passes unchanged |

Screenshots: none (the brief asked for none; nothing here has a visual surface).

## Deviations from the brief, and why

1. **One S3-Z assertion changed.** In "keeps whose panel it is when a deleted chat's items are removed, and drops a deleted
   incognito chat's panel whole" the last line was `expect(storage.isEmpty()).toBe(true)` after saving chat A's panel,
   saving the incognito chat's and deleting the incognito chat. With a per-chat map chat A's panel is legitimately still
   there, so the assertion cannot hold by construction. It now says the same thing the way the new model can: no `chat-i`,
   no `made-in-i`, no `library-open-in-i` in the stored value, and chat A's own panel is intact. Every other S3-Z unit and
   e2e assertion passes unchanged (the e2e helper `storedPanelItemIds` too, thanks to the top-level shape). The literal
   alternative would be "an incognito chat's save wipes every normal chat's panel", which makes A → incognito → A lose A's
   panel, i.e. the reported bug on one path; if you want that instead, the change is small in the module (`save` drops all
   other panels when the saver is incognito) and that one assertion goes back to `isEmpty()`, but my own incognito-detour
   tests (one unit, one e2e) assert the opposite and would flip. Two comments (the e2e header and the unit block's) that
   said "ONE record per tab" were corrected; no logic in S3-Z's tests changed.
2. The kind_mismatch refusal was already fixed in words; I also named `remove_node`/`add_node` (ruling 62's letter).
3. Fix 3 also passes the cache breakdown (not only prompt/completion), because the generator's cost record does and a
   cache-priced model would otherwise still be mis-priced.

## Open questions and concerns

1. Read the Hungarian clause once: "Egy blokk típusa nem változtatható: töröld, és adj hozzá újat."
2. The `@Alfy` comment path's system prompt is English only, so only the EN clause reaches it; the HU one is for the tool
   description on a Hungarian turn.
3. The panel's owner-facing semantics changed in one place worth a look: a chat that has a panel of its own no longer
   receives the previous chat's library/search opens (they still follow into a chat with no panel, as S3-Z pinned).
4. `artifact-canvas.spec.ts:291` flaked once in the combined run (S3-R1's area).
5. Not done: a live model check that the clause saves the wasted call (the brief asked for none).

## Hand-off (and a paragraph for AGENTS.md's Artifacts section, replacing S3-Z's suggested one)

"The tab remembers a panel per chat, the last 20 (`document-workspace-state.ts`; the newest panel at the stored value's top
level, the others under `others`), and each says whose it is: a chat restores its own panel whole; a chat with none takes
only what belongs to it plus library/search opens from the chat visited last; an emptied panel stays as an empty one so a
closed open is not handed on by an older chat; another incognito chat's panel is removed from storage whenever any chat
loads, never written back when another chat saves, dropped alone when the chat is left or deleted, and never enters an
incognito chat. Nothing else reads or writes the key."

- `document-workspace-state.ts`: unchanged names; `MAX_PERSISTED_PANELS = 20` (module-private). To read one chat's stored
  panel in a test, load it with that chat's `WorkspaceConversation`; the newest is `JSON.parse(value).documents`.
- `verify.ts`: `toModelRunUsage(usage: NormalChatModelRunUsage)` is the pattern for anyone who records the cost of a
  `runPlainNormalChatModelRun` (always via `mapNormalChatModelRunUsageToProviderSnapshot`, never `promptTokens` off the
  run). The Slides verifier (S4-V) reads the right names per its own report.
- `CATALOGUE_TOKEN_CEILING` is `{ en: 5043, hu: 8166 }`; the next raise starts from 5,017 / 8,139 measured.
