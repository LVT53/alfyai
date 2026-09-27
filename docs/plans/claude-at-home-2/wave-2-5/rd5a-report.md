# Agent 5a report — task-item fix, in-chat cards (Step 14 not started)

Branch `feat/artifacts-rd5a-cards`, worktree `art-rd5a`. Commit range `9b5e1049..82e70f72`
(7 commits, all on top of agents 1+2's merged work). Budget-stopped by the orchestrator after
Step 12; Step 14 (Knowledge chips) was **not started** — handed to agent 5b or a later agent.

```
b2a3442f fix(artifacts): make inline task-item CSS actually match the live DOM        [Step 0]
6a2ffdad fix(artifacts): drop the timing on artifact cards and pluralize the tab count [Step 12.1/12.2]
56115dbb feat(artifacts): restyle ArtifactCard's standalone chrome as a real card      [Step 12.3]
67417725 feat(artifacts): move the in-chat artifact card out of the joined tool-row box [Step 12.4]
92784a57 feat(artifacts): wire the live pending-review signal into the in-chat card    [Step 12.6]
6661471b feat(artifacts): the composer placeholder names the item open in the panel   [Step 12.5]
82e70f72 fix(test): update the live create_artifact e2e for the card's own head        [gate fixup]
```

## Step 0 · Inline task items (a defect from agent 1)

**Root cause found, not just patched.** Agent 1's CSS already had the right idea
(`li[data-type='taskItem'] { display: flex; ... }` in `DocumentBody.svelte`) but it never
matched the real DOM. Tiptap's `TaskItem` node renders through a custom `addNodeView()`, and a
NodeView's HTML attributes come only from `getRenderedAttributes()` — each attribute's own
`renderHTML` (here just `checked` → `data-checked`). The literal `'data-type': this.name` baked
into `TaskItem`'s schema-level `renderHTML()` is a separate code path used only when there is
**no** NodeView, so `data-type="taskItem"` never reached the live `<li>` and every rule keyed on
it was dead — the browser fell back to default block layout: `<label>` (inline, holding only the
checkbox) stacked above the `<div>` (block, holding the text). Verified by reading
`@tiptap/extension-list`'s actual `task-item.ts` source in `node_modules`, not by guessing.

**Fix**: rekeyed the five selectors onto `li[data-checked]` (always rendered, `"true"` or
`"false"`), in `src/lib/components/artifacts/document/DocumentBody.svelte`. No JS/extension
change — CSS-only, as the brief asked.

**Test first**: added two Playwright tests to `tests/e2e/artifact-document.spec.ts`
(`inline task items (Wave 2.5 Step 0)` describe block, 1440×900 and 390×844) asserting the
checkbox and its first text line's vertical centres are within 6px. Ran them against the
unfixed code first — both failed with a ~28.8px offset (one line-height), confirming the bug;
then passed clean after the fix.

## Step 12 · In-chat cards

### 12.1 — No millisecond timing (`src/lib/utils/tool-activity.ts`)

Both the settled (`hasCard`) and running branches of the `iconType === "artifact"` case now set
`meta: ""` instead of `elapsed ?? ""`. Added a test proving suppression even when the call
carries a real `durationMs`, plus asserted it on the running-card test.

### 12.2 — Plural fix (`src/lib/i18n/artifacts.ts`)

`artifacts.document.cardSubtitle` (EN): `"Document · {count} tabs"` →
`"Document · {count} {count, plural, one {tab} other {tabs}}"`. Hungarian **unchanged on
purpose** (commented why): Hungarian nouns stay singular after a numeral ("1 fül", "3 fül"), so
there was never a bug there. Updated the one e2e assertion that pinned the old always-plural
text (`artifact-document.spec.ts`); this key is shared by both the panel-row and in-chat card,
so one fix covers both surfaces.

### 12.3 — `ArtifactCard.svelte` chrome="full" restyle

Turned the dead, header-only `chrome="full"` (unused since agent 2 moved the panel list to
`chrome="row"`) into the mockup's `.a-card`: a real bordered/shadowed card whose **head is one
button** (icon, title, subtitle/version line, and a trailing affordance), never a separate
"Open" control beside a non-interactive header — mirrors the whole-element-is-the-button shape
`chrome="row"` already established. States wired: ready ("Open ›"), open-in-panel (accent
outline + ring, "Open in panel"), to-review ("N changes to review" pill + "Review ›", reusing
`ArtifactCardView.pendingReviewCount`/`current` — both fields already existed for `chrome="row"`,
now documented as shared). 44px task-tick touch targets on phones via a media query on the
shared `.artifact-card-tick-row` (used by both chrome values). `chrome="body"` markup and CSS
are byte-for-byte untouched — the tickable-list markup is shared through one `{#snippet}` so
`chrome="body"`'s own rendering never changed shape.

Updated 3 existing tests that pinned the old bare-header/exact-"Open"-button shape (the new
shape is a deliberate, spec-driven change, not a regression); added 2 new tests for the
open-in-panel and to-review states.

### 12.4 — Standalone placement (`ToolActivityRow.svelte`)

The card no longer renders inside `.act-body` (the row-joined grey box every other tool
call's detail uses) — it's a sibling `<div class="act-standalone-card">` right after the row,
using `chrome="full"` instead of `"body"`. The row itself stops getting the "joined" background/
radius treatment for this one body kind (`isJoinedOpen` vs `isOpen`); every other body kind,
**including file-job**, is untouched. This intentionally reintroduces the title on the card's
own head alongside the row's compact line — the approved mockup shows both, and it's what makes
the card read as a deliverable instead of a nested log entry (§5.1 problem 7). Updated the two
component tests that pinned the old "title exactly once" contract for this chrome specifically
(chrome="body"'s own File-kind "exactly once" contract elsewhere in the same file is untouched).

### 12.6 — Live `pendingReviewCount` wiring

Threaded the same ephemeral `DocumentAlfyActivity` signal (`liveDocumentAlfyActivity`) that
already feeds `DocumentWorkspace.svelte`'s panel-list rows down through `+page.svelte` →
`ChatMessagePane` → `MessageArea` → `MessageBubble` → `ThinkingBlock` → `ToolActivityList` →
`ToolActivityRow`, which computes `pendingReviewCount` with the **exact same**
artifactId-matched formula `DocumentWorkspace.svelte`'s `artifactCardViewFor` uses
(`Math.max(alfyActivity.appliedCount, 1)` when `alfyActivity.artifactId` matches and status is
`applied`/`refused`). New prop `alfyActivity?: DocumentAlfyActivity | null` on all 6
intermediate components, `null`-default everywhere so no other caller (tests, other pages) needs
updating. 2 new tests in `ToolActivityRow.test.ts` (matches own artifact → pill shows; matches a
different artifact → ignored).

### 12.5 — Composer placeholder

`+page.svelte` derives `activeWorkspaceDocumentTitle` from its own `workspaceDocuments`/
`activeWorkspaceDocumentId` state (never from `DocumentWorkspace.svelte`'s internal
`activeDocument` resolution, which the page has no access to), gated on `workspaceOpen &&
!artifactListOpen` — null while the panel is closed *or* showing the list, since neither has one
specific "open item" to name. Feeds `MessageInput`'s existing `placeholder` prop (the same
mechanism the project page already uses) through a new `placeholder` prop threaded through
`ChatComposerPanel.svelte`. New EN/HU key `artifacts.chat.composerPlaceholder`: "Ask about
{title}" / "Kérdezz erről: {title}" (colon sidesteps a Hungarian case suffix that would depend on
the title's own ending — commented in the dictionary). 2 new Playwright tests: names the
document once open and reverts once the panel closes; stays generic while only the list is
showing.

## Deviations from the spec, with reasons

All of these are real gaps I chose not to build, given the budget — not oversights:

- **"Creating" skeleton-card state** (§7 row 25: shimmering lines, "Alfy is writing…") — not
  built. While `create_artifact` is running, `segment.input` *does* carry `artifactType`/`title`,
  so a skeleton is feasible, but while `edit_artifact` is running neither is known (only
  `artifactId` + patches) without a `conversationArtifacts` lookup — a second, less-clean path.
  The row's existing spinner + "Creating/Editing <title>" line still communicates progress; no
  card appears until the tool call actually settles. Would need a new `ToolActivityBody`
  variant, an `ArtifactCardView.creating` flag, and shimmer CSS.
- **"Failed" card state** ("Couldn't create the document", Retry) — not built. A hard transport
  failure (`segment.status === "failed"`) already gets a reasonable treatment (red row + error
  body). A *soft* refusal (`ok: false`, e.g. a validation error) currently falls through to the
  generic identity/body — this is `tool-activity.test.ts`'s own existing, deliberately-asserted
  behaviour ("never renders a card for a refused edit_artifact — the row shows the refusal, not a
  deliverable"), not a bug I introduced. Giving it a styled card is plausible but a working Retry
  button has no backing mechanism anywhere in the codebase for artifact tool calls (unlike file
  production's real job-retry architecture) — a Retry that does nothing would be worse than the
  status quo.
- **"Deleted" card state** ("This document was deleted", muted, no Open) — not built. No signal
  for it exists anywhere: `ArtifactCardSummary` has no `deleted`/`status` field, and deriving one
  from "not present in `conversationArtifacts`" is unreliable (also true for "no preview yet,
  live mid-turn" and for every non-Document kind). Needs real backend plumbing, not a card change.
- **"1 part left alone" pill** — not built. The mockup's `updateCardPending()` treats it as a
  count of undismissed refusal notes, independent from the pending-change count — a different
  signal than the single `DocumentAlfyActivity` event this session's data model carries. Only
  the "N changes to review" pill (`pendingReviewCount`) is wired.
- **"Reviewed" pill-ok state** — not built (transient, moment-of-Keep/Undo confirmation; the
  durable review-state work is explicitly future Wave 2.5 territory per rd2's own hand-off note).
- **App card's fact-check line / App preview field** — left as the generic bare-header view, as
  the brief pre-authorized ("add it only if small... otherwise leave it and say so"). The App
  feature itself (Step 13: `AppBody.svelte`/`AppFrame.svelte`) hasn't landed yet — there is no
  "facts checked" concept anywhere server-side to project through the read-model facade.
- **`current` (open-in-panel) live wiring for the in-chat card** — the card supports and tests
  this state (outline + "Open in panel"), but it isn't wired to a live signal the way
  `pendingReviewCount` now is. The page only has `activeWorkspaceDocumentId`, which is the
  workspace *item* id (`"artifact:" + realArtifactId` for the four new kinds, minted in
  `ToolActivityRow.svelte`'s own `handleOpenArtifact`), not the bare `artifactId` the card's
  `view.id`/`body.artifactId` carry — matching it correctly needs one more small lookup through
  `workspaceDocuments`' own `.artifactId` field, deferred for budget.
- **Step 14 (Knowledge chips)** — not started at all. Only read the spec sections (§6.1/6.2, no
  code touched); `DocumentsList.svelte` is unmodified. Handing this to agent 5b/a later agent.

## Tests added (new files: none; all in existing files)

- `tests/e2e/artifact-document.spec.ts`: 2 (task-item alignment) + 2 (composer placeholder) = 4
  new Playwright tests; 2 existing assertions updated (plural text, none pinning old duplication).
- `tests/e2e/artifact-chat-card.spec.ts`: 0 new tests, 2 assertions fixed during the final gate
  run (title-count and Open-click, both legitimately changed by Step 12's design).
- `src/lib/utils/tool-activity.test.ts`: 1 new test (no timing with a real duration), 1 existing
  test extended with a `meta` assertion.
- `src/lib/components/artifacts/ArtifactCard.test.ts`: 2 new tests (open-in-panel, to-review), 3
  existing tests rewritten for the new one-button head.
- `src/lib/components/chat/ToolActivityRow.test.ts`: 2 new tests (`alfyActivity` matched / not
  matched), 2 existing tests rewritten (title-duplication contract, Open-click target).
- `src/lib/components/chat/ThinkingBlock.test.ts`: 1 existing test's Open-click target fixed.

## Gates (all run at the end, in this worktree)

1. `npm run check` — **0 errors, 17 warnings**, exactly the documented baseline (`ToolActivityRow`
   10, `ThinkingBlock` 6, `RouteItinerary` 1). Re-verified after every step; clean throughout.
2. `npx biome check src scripts tests` — **clean**, 2129 files, no fixes needed on the final pass
   (a few formatting auto-fixes applied along the way after individual edits).
3. `npm test` (full vitest) — **13533 passed, 2 skipped, 0 failed** (892 files passed, 1 skipped
   of 893).
4. Playwright, port 5440, the 5 specs the orchestrator's stop message named (`knowledge.spec.ts`
   skipped — Step 14 never touched it): `artifact-document.spec.ts artifact-chat-card.spec.ts
   artifacts-panel.spec.ts chat.spec.ts conversation.spec.ts` — **48 passed, 0 failed** (2.2 min),
   clean on the final run. One real failure surfaced on the first run and was fixed:
   `artifact-chat-card.spec.ts`'s live create_artifact test still pinned the pre-Step-12
   "title exactly once" / bare-"Open"-button contracts (see the `82e70f72` commit) — the same
   class of update already made in the component tests, just not runnable until the real
   fake-provider harness executed at gate time.
5. `npx fallow --no-cache --format json --quiet --score --output-file /tmp/fallow-rd5a.json` —
   **124 total issues, 4 circular dependencies** — exactly the documented baseline, **zero new
   findings**.

## Screenshots (Hungarian, not committed — capture script deleted before this commit)

Captured via a throwaway `tests/e2e/zz-capture-rd5a.spec.ts` (route-mocked `ConversationDetail`
for the in-chat card shots, real DB-seeded document for the task-item shot; deleted after use,
never staged). Saved to `scratchpad/rd/shots/rd5a/`:

- `chat-cards-hu-desktop-light.png` (1440×900) — the redesigned standalone card: bordered card,
  icon tile, "Dokumentum · 3 fül · v6" subtitle line, "Megnyitás ›", checklist with a struck-through
  completed item, sitting below (not joined to) the compact "Létrehozva **Bécsi hétvége**" row.
- `chat-cards-hu-phone-light.png` (390×844) — same card, phone width, reflows cleanly.
- `document-tasks-hu-desktop-light.png` (1440×900) — confirms **two** fixes at once: the Document
  panel's task items now sit inline with their checkboxes (Step 0), and the composer placeholder
  reads "Kérdezz erről: Csomagolási lista" (Step 12.5) once the document is open.

I looked at each once; no visual defects against the mockup.

## Hand-off — reuse these

- **`ArtifactCard.svelte` chrome="full"`**: the standalone in-chat card, now a real card
  (`.artifact-card-full` modifier class — the bare `.artifact-card` class stays minimal for
  `chrome="body"`). Its head (`data-testid="artifact-card-head"`) is one button; click it, don't
  look for a `{name: "Open"}` role query — use `getByRole("button", {name: /Title/})` or the
  testid directly, exactly like `chrome="row"`'s own established pattern. `ArtifactCardView`'s
  `current`/`pendingReviewCount` fields are now shared by both `chrome="row"` and `chrome="full"`
  (doc comments updated accordingly) — reuse them rather than inventing new fields for the same
  concepts on Canvas/Slides/App cards later.
- **`alfyActivity` prop chain**: `+page.svelte` → `ChatMessagePane` → `MessageArea` →
  `MessageBubble` → `ThinkingBlock` → `ToolActivityList`/`ToolActivityRow`, all typed
  `DocumentAlfyActivity | null`, default `null` throughout. Whoever eventually replaces
  `liveDocumentAlfyActivity` with a durable "pending review survives a reload" signal (rd2's own
  hand-off note) only needs to change what feeds `+page.svelte`'s end of this chain — every prop
  and every consumer downstream stays the same.
- **`act-standalone-card`** (`ToolActivityRow.svelte`): the pattern for "this body kind stands
  outside the joined `.act-body` box" — `isStandaloneCard`/`isJoinedOpen` derived split. If a
  future kind (e.g. a Canvas/Slides/App card, or the deferred creating/failed states) also needs
  to stand alone, extend the `isStandaloneCard` condition rather than adding a third rendering
  path.
- **Composer placeholder**: `ChatComposerPanel.svelte`'s new `placeholder` prop is generic (not
  artifact-specific) — any future "the composer should say X" need can reuse it the same way,
  same as the project page already does for its own use.
- **Deferred work, if anyone picks it up**: see "Deviations" above for exactly what's missing and
  why for creating/failed/deleted card states, the "1 part left alone" pill, and `current`'s live
  wiring — each has a concrete, scoped starting point already identified.
- **Step 14 (Knowledge chips)**: entirely unstarted. `src/routes/(app)/knowledge/_components/DocumentsList.svelte`
  is untouched. Brief's own pointers: `redesign.md` §6.1/§6.2 (538–569 skim, 605–616), §6.3–6.5
  (617–648), §9.2's `DocumentsList.svelte` row (791); ruling 60 (`docs/plans/claude-at-home-2/decisions.md`
  lines 579–585) for the file-family two-tier chip design.
