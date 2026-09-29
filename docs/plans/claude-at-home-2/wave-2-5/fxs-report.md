# Fix agent P (fxs) · the four defects of the final polish re-check · report

Model: claude-sonnet-5-5. Worktree `.claude/worktrees/art-fxs`, branch `fix/artifacts-panel-swap`, e2e port 5530. Base `29510eb6`.
Status: DONE. Every defect was fixed test-first (each e2e below failed on the previous code, for the reason the re-check gave, before the fix).

Commits (oldest first):

| commit | what |
|---|---|
| `80843792` | D1: the item the panel swaps to gets its own header controls |
| `f7324dc7` | D2: a live Alfy edit is applied once, never on a later re-mount |
| `3eb328e5` | D3: the tab strip's + stays a 44 px target |
| `ace371a0` | D4: a Document made in this turn promises Regenerate in its delete confirm |
| `37d0b3da` | test only: the phone shell's body mount in the D1 walk |
| `46e648c6` | AGENTS.md only: the three rules the fixes rest on |

## D1 (critical) · the header lost its controls after a swap

**Cause.** The body registers its panel actions once, when it mounts (`DocumentBody.svelte`, an effect with no dependency). The workspace
nulled `bodyPanelActions` (and the comment count and "comments shown") from an `$effect` keyed on the open item's id. After a swap
to another item, with a body kept across it (card to card) nothing registered again; and for a body built in the same flush (list to
another row) the header had none either. Only the same item re-opened (A, list, A) worked, because no reset fired.
Checked: with the keyed mount below AND a reset effect (`bodyPanelReport = null` on an item change) put back, the list-to-second-Document
walk still fails at the Comments toggle. So the reset effect runs after a new body's registration in the same flush and wipes it,
and the re-check's one-liner `{#key}` alone would not have been enough (I did not try its other one, reading `artifactId` in the
registration effect; it would sit under the same reset). The fix therefore removes the reset instead of ordering around it.

**Fix** (`DocumentWorkspace.svelte`).
- What a body reports to the header is one record, `bodyPanelReport`, stamped with the item its body was mounted for (`key`), and
  read back through deriveds (`bodyPanelActions`, `documentOpenCommentCount`, `documentCommentsShown` keep their names, so the
  template did not change) only while that key is the open item (`activeBodyKey = artifactId ?? id`). Nothing is ever reset, so no
  effect order matters and the closures of a body that is gone can never be called. A body reports through `reportFromBody(patch)`
  (untracked as a whole, so the body's effects do not come to depend on the record they write).
- Both body mounts (phone shell and desktop shell) are wrapped in `{#key activeBodyKey}`: another item always gets a body of its own
  that registers for itself. The key is the item's id, never the object, so a version change or a Keep keeps the body (G3's undo
  history, caret and pills survive) and never drops what it registered (G1-B's rule). The old identity effect now only closes an
  open delete confirm when the item changes.
- Comments in `artifact-bodies.ts` (`registerPanelActions`) and `DocumentBody.svelte` (the registration effect) say the new contract.

**Tests that failed first.**
- `tests/e2e/artifact-panel-swap.spec.ts` (new), "list → one Document → back → another Document → an App → a Document again":
  failed at `the second Document: the Comments toggle` (element not found); "chat card → another card, with the panel staying open":
  failed at `the second card: the Comments toggle`. Both, once green, also click the three controls (Comments toggles, Download
  and Versions popovers open) and cover Document, second Document, same Document again, App in between, Document after the App.
- `DocumentWorkspace.test.ts`, "gives every item the panel swaps to its own header controls: a second Document, a file in between,
  and back": red at the second Document's Versions button (a `FakeVersionedArtifactBody` registers on mount, like the real one).
- Added after the gate, for the second mount site: "on a phone, a second Document opened from the list has its header controls too"
  (390x844, mobile shell). It fails on the previous workspace at the second Document's Comments toggle (checked by putting the old
  file back, then restoring it), and passes with the fix.

## D2 (important) · a live Alfy edit replayed on every later re-mount

**Cause.** The panel builds a body again on every later open of the Document (the list and back, close and open from the card,
another item and back) and `bodyAlfyActivity` keeps handing each one the panel's settled activity (`alfyActivitySeenOpenKeys` is
never cleared). A body built after the call settled restores the change from the server (`restorePendingReview`, entries keyed by
block id) and then `landAlfyActivity` adds it again (entries keyed by op id): the count doubles, the second copy survives Undo, a
Kept change comes back pending. (`runLoad` resets `handledActivityKey` on every load, so that guard could not stop it.)

**Fix** (`DocumentBody.svelte`, 18 lines). `settledActivityKeyAtMount`, captured once when the body is built: the key of the activity
that had already settled (any status but "running"). The activity effect never lands that key: what the call changed is in the
restored review state (ruling 61). A call is applied live only by a body that was mounted while it was running or before it began.
The workspace's F1/F2 machinery is untouched; a comment there points at the body's rule. With the D1 key, the same rule covers a swap
to a Document that was edited earlier (a new body is built for it).

**Tests that failed first.**
- `artifact-panel-swap.spec.ts`, two walks with a real `edit_artifact` call (fake provider, panel open on the Document when the edit
  lands): "opened again from the list and from the card the change still counts once, and Undo leaves nothing pending" failed with
  the review bar reading `Alfy changed 2 parts. Left 1 alone.  1 / 2`; "a change that was Kept does not come back as pending"
  failed at the review region still present after Keep all, list, open again. Green with the fix (Undo from the pill, then
  re-open, leaves no region and no "change to review" on the card or the row).
- `DocumentBody.test.ts`, "does not land an activity that had already settled when it was built…": red with the guard commented
  out (last reported pending count is not 1), green with it.
- One existing test changed its premise, on purpose: RV-1B ("a call that settles before the lazy editor finishes loading still
  lands") built the body WITH an already-settled activity to model the race. The real race is a body built with nothing that sees a
  call settle while its editor loads; the test now builds it with `alfyActivity: null` and rerenders with the settled call, and asserts
  the same things. A body built with the settled call is the new test above.

**Consequence to know.** A refusal notice / refused-line rule from a call that settled before the body was built no longer
reappears on a re-mount (they are not persisted; the same as after a reload, and the same as opening from the card, which F1/F2
already suppressed).

## D3 (minor) · the tab strip's + shrank to 14x44

**Cause.** `.document-tab-add` is a shrinkable flex item of the scrolling strip; the tabs are `flex: none`, the + was squeezed.
**Fix** (`Tabs.svelte`): `flex: none` on `.document-tab-add`; the strip scrolls instead. Seen in two crops at 390 px (start of the strip;
scrolled to the end, the + is there at full size): `rd/shots/fxs/tabs-start.png`, `tabs-end.png` (not committed).
**Tests that failed first.** `artifact-document-touch-targets.spec.ts`, two new tests ("the + stays 44x44 when 4 tabs overflow the
strip at 390px", "... 3 tabs ... at 360px"): both received `14` for the width; each first asserts that a 44 px + does not fit
beside the tablist (my first version asserted the strip scrolls, which is false before the fix, because the + gave way).

## D4 (minor) · the delete confirm of a live-made Document said "can't be undone"

**Cause.** The page's artifact list is read when the `create_artifact` call finishes and is not read again when the turn ends; the
server marks `regenerable` from the messages it has persisted, and this turn's message was not stored yet. (The turn-end
`hydrateConversationDetail` only runs for receipt-only completions.)
**Fix.** The pure reading of the messages' tool calls moved to `src/lib/shared/artifacts/artifact-calls.ts`
(`artifactCallsFromSegments`, `artifactCallIdsFromMessages`, `regenerableArtifactIdsFromMessages`, moved verbatim, plus
`markRegenerable`, the one place a row gets the mark). `messages.ts` imports/re-exports them (importers and mocks unchanged);
`conversation-detail/read-model.ts` marks through `markRegenerable`; the chat page marks its live `liveArtifacts` from the messages it
holds (`regenerableIdsKey`/`regenerableFromMessages`, keyed by the ids' text so a streaming token derives nothing new), so the panel
list, the header confirm and every row read one flag. AGENTS.md says so in the Regenerate bullet.
**Tests that failed first.** `artifact-chat-card.spec.ts`, "Delete on a Document made in this very turn promises Regenerate, not
'can't be undone', without a reload" (real `create_artifact` call through the fake provider, then Open, then the header Delete): received
"... This can't be undone." Also `page-runtime.test.ts`: the L2 test used to fix "the server's word" as the only source; it is now
three rows (server says yes / neither says / the page's messages carry the create call) and the third fails on the previous code.
`artifact-calls.test.ts` (new) covers the marker.
**Consequence to know.** The promise is now made from the page's own messages, so in the window between the create call finishing
and the turn's message being stored it is slightly early; Regenerate on the deleted card already handled "nothing stored" (it flips to
unavailable). If the owner wants the strict server-only promise instead, the alternative is one more detail read at the end of a turn
that made an artifact (touches the turn runtime and the `hydratingConversation` guard); I chose not to.

## Gates (once, at the end, on `ace371a0`; the two later commits touch only an e2e file and AGENTS.md)

1. `npm run check`: 0 errors, 17 warnings (ToolActivityRow 10, ThinkingBlock 6, RouteItinerary 1: the baseline).
2. `npx biome check src scripts tests`: clean (2182 files).
3. `npm test`: 914 files passed, 1 skipped; 14,217 tests passed, 2 skipped.
4. Playwright on 5530, `artifact*.spec.ts artifacts-*.spec.ts knowledge.spec.ts chat.spec.ts conversation.spec.ts`: 175 passed (8.5 min),
   0 failed. The phone variant added afterwards: 1 passed on its own.
5. Fallow (`rd/fxs-fallow.json`): 124 issues (baseline 124), 4 circular dependencies (baseline 4), no finding names a file I touched.

## Hand-off

- `bodyPanelReport` / `reportFromBody` / `activeBodyKey` in `DocumentWorkspace.svelte`: a new thing a body tells the header goes into that
  record (one more optional field on `BodyPanelReport`, one more `on...Change` prop reported through `reportFromBody`), never a new
  `$state` reset by an effect.
- A body that must not replay something a re-mount already restores: capture it once at mount with `untrack` (see
  `settledActivityKeyAtMount`).
- `shared/artifacts/artifact-calls.ts`: `markRegenerable` for any row list; `regenerableArtifactIdsFromMessages` for any message list.
- `tests/e2e/artifact-panel-swap.spec.ts`: `openList`, `listRow`, `expectDocumentHeader`, `useHeaderControls`, `seedApp`,
  `seedCreateCalls` (one persisted message with N `create_artifact` calls = N chat cards).
- Not done / not touched: the workspace's `alfyActivitySeenOpenKeys` / `staleKeyWhenWatchStarted` state machine is still there
  (now partly redundant with the body's own rule; deleting it is a refactor of the F1/F2 tests, not part of these fixes); the D2 e2e
  and the D4 e2e run at desktop width only; the re-check's "Not verified" list is unchanged.
