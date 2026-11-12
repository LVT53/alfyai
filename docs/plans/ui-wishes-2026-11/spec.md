# UI wishes batch — November 2026 (spec)

Status: **spec, agreed by the owner on 2026-11-12 (W10 held back; W14 added the same day).** The
behaviour contract for nine items: W2, W3, W5, W6, W7, W11, W12, W13 and W14 of
[the wishlist](../../agent-memory/claude/alfyai-feature-backlog-owner-order.md) ("Intake 2026-11-12").
The wishlist stays the authority on *what* the owner asked for; this file is the authority on *how it
behaves*. The implementation plan and the slice/task breakdown are in [plan.md](./plan.md).

Orchestrator: the session that wrote this. Implementers and reviewers are subagents; the orchestrator
writes no feature code, reviews every diff, and runs the one final gate. An **impartial judge** reviews
the finished work against this file before the gate.

## 1. Goal

Eight small, user-visible repairs and one picture-card defect land in one batch: jumping to a message
stops landing mid-answer; tool and skill dialogs say in plain words what Alfy did; the Ask-me card can
explain its question under the title; the phone's artifact counter becomes a real floating touch target; a
picture made from several sources lists all of them; and the App panel looks like the rest of the app —
correct icon gap, consistent popup, even tabs, centred row time, no sandbox notice.

Nothing here changes a stored format, a schema column, a route contract, or a tool's capability.

## 2. Non-goals

- **Not this batch:** W1 (document-edit refusals), W4 (landing page load), W8 (markdown marks), W9 (raw
  Markdown editing, deferred), **W10 (collapsible headings — held back by the owner on 2026-11-12 to keep
  this batch simple; it stays noted in the wishlist)**.
- **No** change to the canonical Document Markdown, block ids, block hashes, patches, or the serializer.
- **No** new database column or migration; no new tool; no new top-level `src/lib/server/services/*.ts`.
- **No** re-styling outside the App panel popup and the touched controls; no redesign of the rail, the
  composer, or the panel shell.
- **No** change to W7's popup *contents* (the owner deferred that until after the restyle).
- **No** push, deploy, admin-setting change, or live test.

## 3. The contract, per item

Each item names today's behaviour (as it stands on 2026-11-12), the behaviour that replaces it, and what
proves it. The implementer re-reads the file before editing and says so if it moved.

### W2 — Jump to message lands at the top of the message

- **Today:** `scrollToMessage` in `src/lib/components/chat/MessageArea.svelte` (~1261) computes
  `targetRect.top - containerRect.top - (clientHeight - targetRect.height) / 2` — it **centres** the
  message, so a reply taller than the viewport starts above the viewport and the reader sees its middle.
- **Must become:** the target message's first line sits at the top of the reading area (a small fixed
  gap below the container's top edge), with the existing jump highlight. Clamped naturally at the ends of
  the list. Never mid-message unless the list cannot scroll further.
- **Rules:** one scroll owner. Read `src/lib/components/AGENTS.md` ("scroll ownership") first. Keep
  `releaseHeldPosition()`, `shouldAutoScroll = false`, the smooth-scroll behaviour and the reduced-motion
  branch. Extract the offset maths into a pure helper beside the component so it is unit-testable.
- **Acceptance:** from the jump rail, from a workspace-search result, and on a chat opened at a message
  (`?message=`); a long answer, a one-line answer, the first and the last message; desktop and phone; a
  second jump to the same message repositions it; the list does not snap back afterwards.
- **Proves it:** the helper's unit test (red first: the centring formula fails the top-alignment case);
  e2e `chat-scroll-on-load.spec.ts`, `chat-scroller.spec.ts`, `search-modal.spec.ts`.

### W3 — Tool and skill dialogs say what happened

- **Today:** pressing a tool/skill row expands its body (`ToolActivityRow.svelte`), which is empty or a
  couple of words.
- **Must become:** the expanded body opens with a short, plain-language account for the person reading
  it, in 1–3 sentences:
  1. **what happened** — reuse the row's own human label ("Alfy searched the web");
  2. **on what** — the identifying argument (query, file name, chat title, address, person), clipped;
  3. **what came back** — one clause plus the outcome line ("found 12 results", "could not reach it",
     "took 4.2 s").

  A generic fallback must read sensibly for a tool the map does not know. Raw arguments and result JSON
  move behind a closed "Details" disclosure and are never the primary text — **except a failure's
  reason**, which stays visible: a person opens a failed row to learn why, so the reason is primary text
  and only the raw material goes behind the disclosure.
- **Rules:** the summary is computed by a pure module beside the components (e.g.
  `tool-call-summary.ts`) that returns **structured parts** (action key, target, outcome kind, detail),
  never composed sentences — the component composes them with `$t`, so the module stays i18n-free and
  testable. Frame strings and any per-tool noun live in `src/lib/i18n/chat.ts`, English and Hungarian.
- **Acceptance:** a successful search, a failed call, a call still running, a call with no readable
  target, an unknown tool name; long arguments clip rather than widen the row; Hungarian reads as short
  natural Hungarian.
- **Proves it:** `tool-call-summary.test.ts` (red first), a component test on the expanded body, e2e
  `chat-failed-tool-row.spec.ts` plus one happy path in `chat.spec.ts`.

### W5 — Ask-me card: a description under the title

- **Today:** a question is one string capped at 160 characters (`questionChars` in
  `src/lib/shared/ask-user.ts`), drawn as the card's title by
  `src/lib/components/chat/AskQuestionCard.svelte`; options carry `note`s of 100 characters.
- **Must become:** an optional `detail` string, up to **280 characters**, drawn under the title in the
  card's muted body style, wrapping across lines, above the options. Empty or absent draws nothing. The
  title keeps its 160-character cap.
- **Decided by this spec (overturnable):** a new `detail` field, not a longer question, because a
  scannable title and a long explanation are two different jobs and the card needs both.
- **Rules:** the cap lives once in `ASK_LIMITS` and is read by the shown schema
  (`askUserToolSchema`) and the check (`checkAskQuestions`/`problemsOf`); the card renders a stored value
  whole and enforces no cap of its own (it has no input). It is stored with the
  question row and survives a reload; the folded one-line form shows the title only. The app writes no
  English into model text (ruling 79): the detail is the model's own words in the conversation's language.
- **Cost:** one more field in a shown tool schema. The tool catalogue sits at its measured ceiling, so
  this slice re-baselines `CATALOGUE_TOKEN_CEILING` with a **measured** number and a history comment, or
  pays for it by cutting wording elsewhere — the orchestrator reports which, and the owner may refuse a
  raise.
- **Acceptance:** a card with a detail and one without; a detail at the cap and one over it (refused in
  the model's own words, not the SDK's); reload shows it; phone width wraps without clipping; the
  answered card folds to one line.
- **Proves it:** `src/lib/shared/ask-user.test.ts` (cap and refusal), `AskQuestionCard` component test,
  e2e `ask-me-first.spec.ts`.

### W6 — The phone's artifact counter floats

- **Today:** `(+page.svelte)` draws two buttons — the desktoppable one in the title bar and a compact one
  in a `lg:hidden` row (~5264), both 32 px high and inline in the header.
- **Must become:** under the phone breakpoint the compact counter is a **floating pill** in the same
  corner and visual family as the jump-to-latest capsule (elevated surface, border, shadow), with a touch
  target of at least 44×44 px, safe-area aware, never covering the composer, the jump rail or a toast.
  While the artifact panel is open it is **hidden but still in the DOM** (so its pressed state stays
  readable to assistive tech and to tests), not unmounted. It opens the same list and keeps its badge
  count, its pending dot and its aria label. Above the breakpoint nothing changes.
- **Rules:** one placement helper + one component path; no second list; the "never draw a bare 0" rule
  stands.
- **Acceptance:** 375×667 and 390×844 portrait; with and without artifacts pending; with a long chat and
  the composer focused; no overlap at the smallest height; keyboard/AT label unchanged.
- **Proves it:** placement helper unit test, component test, e2e `chat-header-room.spec.ts` plus the
  phone case in `chat.spec.ts`.

### W7 — "Change this app": the icon gap and the popup's styling

- **Today:** in `src/lib/components/artifacts/app/AppBody.svelte` the regenerate button (~618, ~732) has
  no space between icon and label, and its popover (custom-positioned, `regeneratePopoverStyle`) is
  visibly plainer than every other AlfyAI popover.
- **Must become:** the icon-to-label gap matches the app's other icon buttons (measured against a
  neighbour, not guessed), and the popover uses the family's shell and rhythm — `AnchoredPopover`'s
  border, radius, surface, shadow, row height, padding and type scale. Its contents stay as they are.
- **Acceptance:** popup not clipped at the panel edge or the phone breakpoint; focus trap, Escape and
  outside-press unchanged; both languages; no new inline `<svg>`.
- **Proves it:** `AppBody.test.ts`, e2e `artifact-app.spec.ts`.

### W11 — "Preview – Code" switcher padding

- **Today:** the segmented control exists twice — `AppBody.svelte` (~576, `app-seg`) and
  `AppVersionPreview.svelte` (~271, `seg`) — and the selected "Preview" segment is missing its right
  padding.
- **Must become:** both segments have equal horizontal padding and equal width in both controls; no shift
  when switching; the selected state is symmetric across its left and right edge.
- **Acceptance:** both states, narrow panel, phone; accessible name (`artifacts.app.tabs.a11y`) kept.
- **Proves it:** component tests on both controls, a Playwright bounding-box check (segments equal) in
  `artifact-app.spec.ts`.

### W12 — "What this chat made": the time is vertically centred

- **Today:** `ArtifactCard.svelte`'s row (`chrome="row"`): `.artifact-row-end` is a column holding the
  time above either the review pill or the hover chevron, so with no pill the time sits about 10 px above
  the row's centre.
- **Must become:** the time is vertically centred when **no review pill is drawn** — the chevron is a
  hover hint and may leave the flow so the time is the column's only in-flow child. When a pill is drawn
  the stack stays exactly as today: time above the pill, the block centred as a block. It must not become
  a row, must not widen the end column, and must not move the chevron's visual place.
- **Acceptance:** a row with no review marker: the time's centre within 2 px of the row's centre, and the
  end block no wider than the time; rows with Reviewed and pending pills keep their stacking and width; a
  long wrapping title still centres the block against the row; phone width.
- **Proves it:** component test on the row's structure, a bounding-box check in
  `artifact-panel-rows.spec.ts`.

### W13 — Remove the sandbox notice row

- **Today:** `AppFrame.svelte` (~495-505) draws `.app-frame-sandbox-bar` with a lock icon and
  "Runs sandboxed · no internet · keeps your data" (or its preview variant).
- **Must become:** the row is gone in the normal **and** the preview state; both strings
  (`artifacts.app.sandboxBar`, `artifacts.app.sandboxBarPreview`) are removed from English and Hungarian
  with no unused key left; the frame keeps its position and nothing fills the gap. If the preview state
  needs to say it is not editable, that belongs to the preview's own chrome, not to a resurrected row.
- **Acceptance:** normal and preview states; no leftover space; phone width; parity test green.
- **Proves it:** `AppFrame.test.ts`, e2e `artifact-app.spec.ts`.

### W14 — A picture made from several sources shows them all

- **Today:** the card's "Made from" row (`ImageCardBody.svelte`, `madeFromIds`) is built from
  `shown.sourceFileIds`, which the read model (`read-model.ts`) fills from the take's **reference**
  inputs only, and the numbering starts at 1 for the first reference. A take given a base picture plus
  references therefore draws one fewer thumbnail than it had sources, and its numbers disagree with the
  `<image1>`, `<image2>` labels the prompt used. That is the shape of the defect as read, **not yet
  proven**: the request may already lose a picture, either way the row is wrong.
- **Must become:** the row lists **every source picture the take was given, in the order the prompt
  addresses it** — base first, then the references — numbered to match `<image1>` … `<imageN>`, so a
  result made from N pictures draws N thumbnails. Nothing else about the card changes.
- **Diagnosis first:** a failing test establishes which link loses the picture — the take request's
  `inputs` (assembly in `images/inputs.ts`/`requests.ts`), the read model's field, or the card's
  derivation. The fix goes where the test fails. **If the request itself carries only one reference, the
  slice stops and reports**: that would mean a result silently made from fewer pictures than the person
  gave, which is a P1 the owner must hear before any display fix.
- **Rules:** one source of truth for the list. Prefer the read model exposing the take's full source
  list in prompt order (base + references) over the component concatenating two fields, which would drift
  the first time either side changes.
- **Acceptance:** 2 pictures → 2 thumbnails (1, 2); 3 → 3; an in-place change with one reference shows
  base + reference; no row for a words-only or photo card; the thumbnails are the right pictures, not
  duplicates; phone width wraps; the ten-picture cap clips sanely.
- **Proves it:** `read-model.test.ts` (the full ordered list), a request-level test in
  `requests.test.ts` (N named → base + N−1 references), the card component test, e2e `images.spec.ts`.

## 4. Cross-cutting rules

- **English and Hungarian** for every new or changed user-facing string, confirmation, empty state and
  aria string, in both dictionaries, short and natural in Hungarian; the parity test is part of every
  slice's focused checks.
- **Svelte 5 runes only**: callback props, `$props()`, event attributes (`onclick`), `{@render}`. No
  `createEventDispatcher`, `on:`, `<slot>`, `afterUpdate`/`beforeUpdate`.
- Icons from `@lucide/svelte`; no new hand-written `<svg>`.
- **Feature Guide (root `AGENTS.md`, rule added 2026-11-12):** a change that adds, removes, renames or
  moves a user-facing feature or a pictured control updates the guide in the same change —
  `src/lib/components/guide/guide-content.ts` and `src/lib/i18n/guide.ts` in English and Hungarian, and
  the section's drawing under `src/lib/components/drawings/` when a pictured control changes. A moved
  control keeps its spotlight marker so Show me still finds it, and `tests/e2e/feature-guide.spec.ts`
  stays green. Each slice reports whether its item appears in the guide, and what it changed there.
- Logic at the right boundary: pure helpers beside their components; no route-local copies, no second
  store, no new server service, no overrides bypassing `config-store.ts`.
- `bind:this` refs that an effect or handler reads later are declared with `$state(...)`.
- Touch handlers needing `preventDefault()` attach a non-passive listener; no legacy modifiers.
- **Docs check before code:** every worker checks current docs for any API it has not already used here
  (Svelte 5 runes, Playwright, and the popover/segmented-control patterns for the panel slice) and records
  what it checked.
- Each worker runs **focused** tests only (`npx vitest run <file>`). The orchestrator runs
  `npm run check` once per slice as it lands, one at a time and never beside a build (both run
  `svelte-kit sync`). Workers never run `npm run build`; one e2e run per worktree, started only by the
  orchestrator.
- Workers do not push, deploy, change admin settings, delete data, or run destructive git commands.

## 5. Slices

Five slices, disjoint write scopes, one owner each. They run in parallel; the orchestrator reviews each
diff before the next round.

| # | Items | User-visible outcome | Owner | Write scope |
|---|---|---|---|---|
| S1 | W7, W11, W12, W13 | The App panel looks and reads like the rest of the app | worker-panel | `src/lib/components/artifacts/` (`app/`, `ArtifactCard.svelte`), `src/lib/i18n/artifacts.ts` |
| S2 | W2, W6 | A jump lands at the message's top; the phone's counter is a real floating target | worker-chatnav | `src/lib/components/chat/MessageArea.svelte`, `ConversationJumpRail.svelte`, `src/routes/(app)/chat/[conversationId]/+page.svelte`, a new offset helper |
| S3 | W3 | Opening a tool or skill call says what happened, in one short paragraph | worker-tools | `src/lib/components/chat/ToolActivityRow.svelte`, new `tool-call-summary.ts`, `src/lib/i18n/chat.ts` |
| S4 | W5 | The Ask-me card can explain its question under the title | worker-askcard | `src/lib/shared/ask-user.ts`, `src/lib/server/services/normal-chat-tools/ask-user.ts`, `src/lib/components/chat/AskQuestionCard.svelte`, the catalogue test |
| S5 | W14 | A picture made from several sources shows every one of them | worker-pictures | `src/lib/server/services/images/` (`inputs.ts`, `requests.ts`, `read-model.ts`), `src/lib/components/artifacts/image/ImageCardBody.svelte`, their tests |

**Shared files:** `src/lib/i18n/artifacts.ts` belongs to S1; `src/lib/i18n/chat.ts` belongs to S3 (S4
needs no app string — if it turns out to, the worker asks the orchestrator). The chat page
`(+page.svelte)` belongs to S2 only. **S5 owns `src/lib/components/artifacts/image/`; S1 must not edit
it**, and S5 does not touch `ArtifactCard.svelte` (it renders the row chrome, not the picture card body).

## 6. Acceptance of the batch

- Every item's acceptance line holds, on desktop and on a phone where it applies.
- Both dictionaries complete; parity test green; no unused key after W13.
- A test that fails without each fix; five slices reviewed and accepted; the judge's report has no open
  "fail" and every "uncertain" is explained.
- The final gate (in [plan.md](./plan.md) §6) is green, with its numbers in the report.
- One local commit per logical change, message stating the why; no push, no deploy.
