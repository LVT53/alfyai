# Artifacts redesign: panel, comments, editing with Alfy, App, Knowledge

Design pass for Feature 2 (Artifacts), 2026-09-27. Branch `design/artifacts-redesign`, based on `5390a445`
(the code running on dev). No product code changes. The owner's brief, in their words: *"It appears the
new components have no animation implemented and they feel rough to interact with. Not to mention the way
the sidebar inside the document panel looks like is very rudimentary and a wall of text. Compared to the
other parts of the UI it feels under-designed and hard to follow at a glance. It's also not clear there
what's a button and how things influence each other with actions."*

What is in this folder:

| File | What it is |
|---|---|
| `index.html` | The click-through mockup. Open it in a browser (no network needed). The top bar switches surface (c, a, b, d), Desktop/Phone frame, Light/Dark, EN/HU and Reduced motion; the right column lists what to try, each with a Play button. |
| `redesign.md` | This spec: audit, redesign per surface, every state, a11y, Hungarian allowance, motion spec, implementation map, build plan. |
| `current/` | 47 screenshots of the build as it runs today (1440×900 and 390×844, light and dark), plus the best existing surfaces (chat with tool row, Settings, Knowledge). |

The mockup uses the app's real tokens (copied from `src/app.css`), the real fonts (Nimbus Sans L,
Libre Baskerville, inlined) and real Lucide icons (built from `@lucide/svelte` 1.17 in `node_modules`).
Tokens this redesign adds are marked `proposed` in the mockup's stylesheet and listed in
[§9.1](#91-tokens-to-add).

---

## 1. The five problems that matter most, and the fix for each

1. **The document itself has no typography, and Alfy's change mark has no style.** The editor content
   renders as unstyled text: headings look like body text, paragraphs have no spacing, every checkbox sits
   on its own line above its label, the table has no borders, status chips are raw native selects
   ([a1](current/a1-document-margin-desktop-light.png), [a5](current/a5-document-mobile-light.png)).
   Nothing styles the text inside `.document-content` (its one rule removes the focus outline), and
   `marks.ts` emits `<span class="alfy-change">` with no CSS anywhere, so the change Alfy just made is invisible
   ([b5](current/b5-change-bar-zoom-desktop-light.png)). This is most of why it "feels under-designed".
   **Fix:** a prose layer that matches the chat (Libre Baskerville body, Nimbus Sans headings, inline
   checkboxes, a bordered tracker table, status pills), a visible Alfy mark (accent tint plus a 2 px
   underline), and an amber highlight on commented words.

2. **The comment margin is a wall of text with no buttons and no link to the words.** Each thread stacks
   an implementation label (`EXACT`, `MOVED`, `ORPHANED`), an italic quote, a name, the body and two
   unstyled words ("Reply Resolve" use `.btn-text`, a class that exists nowhere). Resolved threads keep
   full height. The words a thread is about are not highlighted, so you cannot see what it refers to
   without reading the quote. The margin's scroll is driven by the editor's, which leaves 300 px gaps and
   can put the last threads out of reach. On phones there are no comments at all
   ([a1](current/a1-document-margin-desktop-light.png), [a2](current/a2-margin-bottom-orphaned-desktop-light.png),
   [a5](current/a5-document-mobile-light.png)).
   **Fix:** thread cards with a clear anatomy (the quoted words as a link, avatar, name, time, text,
   Reply and Resolve as real buttons), no jargon, resolved threads fold to one line, comments on removed
   text wait in a folded group, the margin scrolls with the text, hover and click link card and words
   both ways, and a Comments sheet on phones.

3. **Cause and effect are invisible in the editing chain.** "Ask Alfy" only prefills `@Alfy` in a
   comment box ([b2](current/b2-ask-alfy-composer-desktop-light.png)). After sending, nothing shows where
   the request went. "Alfy is writing" is a grey banner above the text (and in practice never paints for
   a fast call). The Keep/Undo bar is absolutely positioned on top of the next line, covering "Book the
   flight.", the very line the refusal notice is about; the refusal notice is a detached box at the top
   of the document ([b4](current/b4-change-marks-refusal-desktop-light.png),
   [b7](current/b7-kept-notice-zoom-desktop-light.png)).
   **Fix:** one chain in one colour. The composer says what will happen; the request flies to the
   margin; Alfy's progress shows in the thread and on the block; the change arrives marked with an
   inline Keep/Undo pill after the words; a review bar counts what is waiting; a refusal is pinned to the
   line it concerns.

4. **The panel shell does not explain itself and duplicates its controls.** "ACTIVE DOCUMENT" labels
   every kind (an App too), a "Knowledge Base" pill means nothing here, all actions are unlabelled
   icons, the header's History clock is permanently disabled ("History arrives with documents.") while
   a second, working clock sits in the toolbar, Download appears twice, the old "Open documents" rail
   (showing a truncated internal `UNSUPPOR…` status) competes with the new list, every tab carries a pencil and a
   cross, and clicking a tab does nothing but move the highlight (`handleTabActivate` only sets
   `activeTabId`) ([c3](current/c3-panel-header-tabs-toolbar-desktop-light.png),
   [c4](current/c4-file-in-panel-desktop-light.png), [d1](current/d1-app-preview-desktop-light.png)).
   **Fix:** one header for every kind (breadcrumb back to the list, kind, title, a version button that
   opens Versions, labelled actions), no second list, one-line list rows that are themselves buttons,
   tabs that switch sections, a grouped toolbar.

5. **Nothing animates, so every change is a jump.** The panel fades in from the wrong side (it slides
   20 px from the left into a right-hand column) while the chat column snaps; list and item swap
   instantly; the bubble, the Keep/Undo bar, sheets and popovers pop; threads jump when re-measured.
   **Fix:** a small motion system (the three existing duration tokens plus a 700 ms "settle"), where
   every movement goes from a cause to its effect, with a reduced-motion alternative for each
   ([§7](#7-motion-spec)).

---

## 2. Design language for artifact surfaces

These rules apply to every surface below and to Canvas and Slides later.

### 2.1 What is a button, and how it looks

| Role | Style (existing class) | Used for |
|---|---|---|
| Primary action, at most one per region | `btn-primary` (accent tint, accent border, `--accent-text`), icon first | Ask Alfy, Keep all, Change this app…, Restore |
| Filled confirm inside running text | `--accent-fill` background, `--on-accent` text (new tokens, [§9.1](#91-tokens-to-add)) | Keep in the inline change pill |
| Secondary action | `btn-secondary` (neutral outline) | Undo all, Ask again, Download as .html (in sheets) |
| Tertiary action | `btn-ghost btn-sm` **with an icon**, hover fills `--surface-elevated` | Reply, Resolve, Reopen, Cancel |
| Icon-only action | `btn-icon-bare` with `aria-label` and a visible tooltip; only for universal verbs | Close, Download, Expand, the Comments toggle (with a count) |
| Navigation link | `--accent-text`, underline on hover | See change, Left 1 alone, the quoted words in a thread |
| Selectable chip | rounded pill with a border; pressed = accent tint | Knowledge filters, Open/All filter, suggestion chips |
| Status pill | rounded pill, no border, tinted by meaning | "1 change to review", "Facts checked", "To book" |
| Plain label | muted text, never accent, never bordered | kind names ("Document"), times, counts |

Two rules keep this legible: nothing that is not clickable uses the accent colour or a border, and
every clickable thing has a hover fill and the 2 px `--focus-ring`. `.btn-text` is removed; its three
users (Reply, Resolve, Reopen) become `btn-ghost btn-sm` with icons.

### 2.2 Two colours that carry meaning

- **Alfy's work is terracotta with the sparkle** (`Sparkles` icon, `--accent`): the Ask Alfy button,
  the writing state, the change mark, the Keep/Undo pill, the review bar, Alfy's avatar in threads.
  Following the colour from the bubble to the bar is following the request.
- **Comments are amber** (`--caution`-based `--comment-mark`): the highlight on commented words, the
  rule beside a thread's quote, the badge on tabs. Amber never means "Alfy did something".
- Warnings (a refusal) use `--warning` with a triangle and a dashed rule, never a fill on the text.

### 2.3 Type and spacing

- Long-form content (document text, chat prose, quoted words) is Libre Baskerville; everything around
  it is Nimbus Sans L, as in `AGENTS.md`.
- Panel title: Libre Baskerville 22 px (19 px on phones). Eyebrows: 11 px, bold, 0.08 em tracking, muted.
- Document: 16 px / 1.72, measure about 62 ch, headings Nimbus Sans bold 20/16 px.
- Rail and cards: 13 px body, 12.5 px meta. Everything on the 4 px scale (`--space-*`).

### 2.4 Reading the design next to the current screenshots

| Surface | Mockup | Current build |
|---|---|---|
| a · comments | top bar → **a · Comments** | [a1](current/a1-document-margin-desktop-light.png) [a2](current/a2-margin-bottom-orphaned-desktop-light.png) [a3](current/a3-reply-composer-desktop-light.png) [a4](current/a4-versions-desktop-light.png) [a5](current/a5-document-mobile-light.png) |
| b · editing | **b · Editing with Alfy** | [b1](current/b1-selection-bubble-desktop-light.png) [b2](current/b2-ask-alfy-composer-desktop-light.png) [b4](current/b4-change-marks-refusal-desktop-light.png) [b5](current/b5-change-bar-zoom-desktop-light.png) [b7](current/b7-kept-notice-zoom-desktop-light.png) |
| c · shell and cards | **c · Panel & cards** | [c1](current/c1-panel-list-desktop-light.png) [c2](current/c2-chat-with-cards-desktop-light.png) [c3](current/c3-panel-header-tabs-toolbar-desktop-light.png) [c4](current/c4-file-in-panel-desktop-light.png) [c5](current/c5-mobile-more-sheet-light.png) |
| d · App and Knowledge | **d · App & Knowledge** | [d1](current/d1-app-preview-desktop-light.png) [d2](current/d2-app-code-desktop-light.png) [d3](current/d3-knowledge-two-chip-rows-desktop-light.png) |
| best existing surfaces | n/a | [chat with tool row](current/e1-chat-tool-row-expanded-desktop-light.png), [Settings](current/e2-settings-desktop-light.png), [Knowledge](current/e3-knowledge-library-desktop-light.png) |

The existing surfaces set the bar: Settings uses a serif page title, an eyebrow with a one-line
description, bordered cards, label-plus-description rows with the control on the right, segmented
pickers, and a primary action with an icon ([e2](current/e2-settings-desktop-light.png)). Knowledge uses
chips with counts and section rows with accent icons ([e3](current/e3-knowledge-library-desktop-light.png)).
The artifact surfaces should look like the same product.

---

## 3. Surface a · the Document panel sidebar

### 3.1 Problems observed

1. **Wall of text.** Threads have no container; each repeats a status pill, a quote, a name line, the
   body and actions at nearly the same weight, separated by a hairline
   ([a1](current/a1-document-margin-desktop-light.png)).
2. **System vocabulary in the UI.** Every thread shows its anchor resolution (`EXACT`, `MOVED`,
   `ORPHANED`; in Hungarian `PONTOS`, `ELMOZDULT`, [h1](current/h1-document-hungarian-desktop-light.png)).
   The removed-text group says it twice (heading "No longer in the document" plus an `ORPHANED` pill,
   [a2](current/a2-margin-bottom-orphaned-desktop-light.png)).
3. **Actions do not look like buttons.** Reply / Resolve / Reopen use `.btn-text`, which is not defined
   in `app.css`: 12 px text, no hover, about 16 px tall.
4. **Resolved threads do not recede.** The resolved €540 thread and its reply take 180 px at full
   contrast with a small "Resolved" badge ([a1](current/a1-document-margin-desktop-light.png)).
5. **No link between a thread and its words.** The anchored words are not highlighted; hovering a thread
   or clicking its quote does nothing.
6. **Scroll-synced placement.** `MarginPanel` sets its `scrollTop` from the editor's on every editor
   scroll. Threads land beside their block, but with 300 px empty gaps, and anything anchored near the
   end, plus the removed-text group, can sit below what the editor lets you scroll to. [a2](current/a2-margin-bottom-orphaned-desktop-light.png)
   needed a scripted scroll to show it.
7. **Alfy's replies look like yours** apart from the name, and the reply that changed the text
   ("I moved the evening visit to Thursday") does not point at the change.
8. **The reply box explains nothing**: a bare textarea with Cancel/Post; that `@Alfy` will trigger an
   edit is only revealed by the button label after you click ([a3](current/a3-reply-composer-desktop-light.png)).
9. **Dark mode:** the `MOVED` pill uses `--status-warning-text/-surface`, which are defined nowhere, so it
   falls back to hard-coded light yellow ([b4 dark](current/b4-change-marks-refusal-desktop-dark.png)).
   Native checkboxes and selects stay light because nothing sets `color-scheme: dark`.
10. **Phones have no comments.** `.document-margin` is `display: none` below 900 px, and neither the mobile
    toolbar nor its More sheet has a Comments entry ([a5](current/a5-document-mobile-light.png),
    [c5](current/c5-mobile-more-sheet-light.png)). The selection bubble still appears on phones, so you
    can post a comment you then cannot see.
11. **Version history** opens from the toolbar clock (the header's clock is disabled). Every row has a
    Restore button, "Alfy · Alfy moved the late museum visit" repeats the author, and the popover has no
    Escape or focus handling: it stayed open under the selection bubble
    ([a4](current/a4-versions-desktop-light.png), [b1](current/b1-selection-bubble-desktop-light.png)).

### 3.2 Redesign

> **Superseded in part by the owner's walk (2026-09-29, `docs/plans/claude-at-home-2/progress.md` → "Wave 2.5 polish"):**
> the comment list stays in view while the text scrolls — a sticky column with its own scroll, cards in document order,
> the thread nearest the reading position highlighted and followed — instead of cards placed at their words' height;
> the header's comment icon toggles the one comments surface (column, narrow-panel drawer, phone sheet); the column
> narrows to 240–300 px and becomes a drawer below a 720 px panel. The card anatomy, filter and linking below still hold.

**Layout.** The comment rail is a 300 px column inside the *same* scroll container as the text (a
two-column grid inside `.document-content`'s scroller). Cards are still placed beside their anchors with
`margin-layout.ts`, but there is one scroll, so nothing is out of reach and the scroll-sync effect goes.
Below a panel width of 820 px the rail becomes a 280 px drawer over the right edge of the text, toggled
by the header's Comments button; highlights and tab badges stay.

**Rail header** (sticky): "Comments" and a two-option filter, **Open 4 | All 6** (counts included).
Default is All, so a resolved thread stays visible, folded, where you left it.

**Thread card** (the shared `CommentCard`/`CommentThread`, [§8](#8-shared-parts-for-canvas-and-slides)):

```
┌───────────────────────────────────────┐
│ ▍“one proper concert”        · moved │  quote: a button that scrolls to the words and flashes them;
│                                       │  "· moved" only when the anchor moved
│ (L) You · 12 min ago                  │  avatar, name, relative time
│     Anna says the Musikverein sells   │  body, 13 px; "@Alfy" in accent
│     out early. Can we lock a date?    │
│  │                                    │  thread line joins avatars
│ (✦) Alfy · 11 min ago       GUESS     │  Alfy: sparkle avatar; "Guess" on judgement calls
│     It's open until 21:00 on…         │
│     ┌ ✦ Edited · waiting for you  See change ┐   change chip when this message edited the text
│ ↳ Reply   ✓ Resolve                   │  btn-ghost btn-sm with icons
└───────────────────────────────────────┘
```

- **Reply** opens an inline composer (height animates). Placeholder "Reply, or ask @Alfy…". The submit
  button reads "↳ Reply" (secondary) and turns into "✦ Ask Alfy" (primary) the moment the text contains
  `@Alfy`, with the hint "Alfy answers here and can edit the text. You keep or undo the change."
  ⌘/Ctrl+Enter sends.
- **Resolve** folds the card to one dashed line, `✓ Is €540 still the rate… · +1  ⌄`; the highlight on
  its words fades out. Clicking the line peeks the full thread, with **Reopen**.
- **Comments on removed text** collect in a folded group at the end of the rail,
  `▸ 1 comment on text that was removed`; inside, the quote is struck through and the rule is dashed.
- **In other tabs**: a short list at the bottom, one row per other tab with "1 open · 1 resolved"; each
  row is a button that switches tab. Tabs also carry an amber badge with their open count.
- **Linking.** Commented words carry `--comment-mark` (amber 24 %) and a 2 px `--comment-rule` underline.
  Hovering or focusing a card deepens its words to `--comment-mark-active` and shifts the card 6 px
  towards the text; clicking highlighted words pins that card active; Enter on a focused highlight does
  the same.
- **Alfy's own notes** (judgement calls, [spec decision 8](../../plans/claude-at-home-2-artifacts-spec.md))
  are threads whose first message is Alfy's, tagged "Guess".
- **Refusal notes** from an edit are cards of the same family pinned beside the refused line
  ([§4.2](#42-redesign-one-chain)).

**Phone.** The header's Comments button (with the open count) opens a bottom sheet
(`DialogShell` with `phonePresentation="sheet"`): refusal notes first, then threads grouped by tab, then
the removed-text group. Tapping highlighted words opens the same sheet scrolled to that thread.

**Versions** open from the version button in the header (`v6 ▾`). Desktop: a popover anchored to it;
phone: a sheet. Each row: avatar, `v5 · 24 min ago`, the summary on one line. Restore appears on hover
or focus (always shown on touch) and asks inline: "Restore v4? Your current text stays as a version.
[Cancel] [Restore]". A restore ends with a toast, "Restored v4 as v10 · Undo". Escape closes and returns
focus to the version button.

### 3.3 States

| State | What the rail shows |
|---|---|
| Empty (no threads on this tab) | "No comments on this tab. Select text to start one." plus the "In other tabs" list |
| Loading | two 72 px skeleton cards with the shimmer; header counts hidden |
| Load failed | inline line "Comments didn't load." with a Retry ghost button |
| Posting | the new card appears at once, time reads "Sending…"; on failure the card keeps the text and shows "Not sent · Retry" in `--warning-text` |
| Alfy busy | the Alfy message shows typing dots with "Alfy is reading…", then "Alfy is writing…" |
| Alfy refused (`ALFY_REFUSED_MARKER`) | Alfy's message: "I left the text as it is…" with a circle-slash icon on a warning tint, and **Ask again** |
| Alfy partly refused | the reply plus one muted line, "Part of this could not be applied safely." |
| Alfy changed text | change chip "Edited · waiting for you / kept / undone" with **See change** |
| Resolved | folded one-liner, dashed border, success check; peek to read, Reopen |
| Moved | quote line ends in "· moved"; nothing else changes |
| Orphaned | in the folded group, quote struck through, dashed rule; Reply and Resolve still work |
| Offline | composer disabled with "You're offline. Your reply is kept." |
| Filter = Open | resolved one-liners leave (fade, height to 0); counts stay |
| Narrow panel | drawer over the text, opened by the Comments button |
| Phone | sheet from the header button or a tapped highlight |

### 3.4 Accessibility

- The rail is `<aside aria-label="Comments">`; each thread is an `<article>` named "You on ‘one proper
  concert’". The quote button is named "Show ‘one proper concert’ in the text".
- Focus order: filter → threads in document order (quote → Reply → Resolve, composer when open) → the
  removed-text group → other tabs. Focusing a thread activates its highlight, so keyboard users get the
  same link as hover.
- Highlights are focusable (`role="button"`, `tabindex="0"`) only while their thread is open.
- Visible focus: 2 px `--focus-ring`, 2 px offset, on every button, chip and highlight.
- Contrast: body text on the amber highlight is above 13:1; muted text 5.1:1; links and accent labels use
  `--accent-text` (5.4:1). The raw accent `#c15f3c` is only 4.0:1 on the page, which fails AA for small
  text, so it is kept for icons, rules and tints. The comment rule `#a07a02` is 3.8:1 (non-text 3:1).
- Targets: ghost buttons are 28 px on desktop (above WCAG 2.5.8's 24 px) and 44 px in the phone sheet.
- Live region: "Comment added", "Comment resolved", and Alfy's reply are announced politely.

### 3.5 Hungarian allowance

Measured from `src/lib/i18n/artifacts.ts` and the mockup's HU view: "Reopen" → "Újranyitás" (+67 %),
"Comments" → "Megjegyzések" (+50 %), "Ask Alfy" → "Alfy megkérdezése" (+113 %), "See change" →
"Módosítás mutatása" (+80 %). Rules: no fixed widths on buttons or chips; the change chip may wrap to
two lines; the rail header fits "Megjegyzések" plus "Nyitott 4 | Összes 6" at 300 px (checked); the
rail never goes below 280 px.

---

## 4. Surface b · editing feedback

### 4.1 Problems observed

1. **The change mark is invisible**: `.alfy-change` has no CSS ([b5](current/b5-change-bar-zoom-desktop-light.png)).
   Spec decision 4 ("Alfy's change arrives highlighted") is not met.
2. **Keep/Undo covers text.** `ChangeBar` is absolutely positioned at the mark's bottom-left and sits on
   the next line; in b5 it hides "Book the flight."; after Keep, "Kept." still covers it
   ([b7](current/b7-kept-notice-zoom-desktop-light.png)).
3. **Keep and Undo are 11 px accent links** separated by dots: equal weight, no icons, about 18 px tall,
   4.0:1 contrast. Undo shows "Undone — your text is back." for 1.5 s and offers no Redo.
4. **The refusal notice is far from its line**: a box above the text that pushes the document down by
   90 px; "See what Alfy did" scrolls to the *applied* change, not the refused line; it has no dismiss
   ([b4](current/b4-change-marks-refusal-desktop-light.png)).
5. **Chat, thread and document do not connect.** The chat card under "Edited Vienna trip plan" shows the
   checklist instead of what changed; the thread reply has no link to its change; the version in the
   header does not move.
6. **"Alfy is writing" is detached and fleeting**: a grey pill above the scroll area (not at the block,
   as `slice-1.md` specified), and for a fast call the tool-call and result frames arrive together, so
   it never paints. It could not be captured even with a throttled network (hence no b3 screenshot).
7. **The selection bubble is a vertical menu** that opens under the selection and covers the next lines
   ([b1](current/b1-selection-bubble-desktop-light.png)). "Ask Alfy" only prefills `@Alfy ` in a comment
   box ([b2](current/b2-ask-alfy-composer-desktop-light.png)): no suggestions, no statement of what will
   happen.
8. **Pending decisions vanish on reload.** Marks are session-only by design (`marks.ts`; the "T8 live"
   test in `artifact-document.spec.ts` asserts that the bar and the notice are gone after a reload), so a
   reload before Keep/Undo drops the decision without a word.
9. **Phones**: after an edit sent from the chat, the document has to be reopened and there is no summary
   of what changed ([b6](current/b6-chat-after-edit-mobile-light.png),
   [b4 phone](current/b4-change-marks-refusal-mobile-light.png)).

### 4.2 Redesign: one chain

Each step shows where its effect lands. Try it in the mockup: **b · Editing with Alfy** → "Select it
for me" → Ask Alfy → "Less like a list" → Ask Alfy; then "Send from the chat".

1. **Select.** A horizontal pill appears above the selection (below it when there is no room):
   `[✦ Ask Alfy | 💬 Comment]`, 38 px tall, `--surface-overlay`, `--shadow-lg`.
2. **Compose.** The pill grows into a 340 px composer anchored to the same spot; the selection keeps a
   dashed amber "pending" highlight so you still see what you are asking about.
   - Ask mode: header `✦ Ask Alfy about “Two adults; museums…”`, a textarea ("What should Alfy do with
     this text?"), suggestion chips (Less like a list, Shorter, Friendlier, In Hungarian),
     `[Cancel] [✦ Ask Alfy]`, and the effect line: *"Alfy replies in the margin and marks its change
     here, for you to keep or undo."*
   - Comment mode: `[Cancel] [💬 Comment]` and the hint *"Mention @Alfy to get an answer and an edit."*;
     typing `@Alfy` turns the button into `✦ Ask Alfy`.
   - ⌘/Ctrl+Enter sends; Escape cancels and restores the selection.
3. **Send.** The composer box travels to the new thread's place in the margin and becomes the card; the
   pending highlight becomes the amber comment highlight.
4. **Alfy works.** The thread shows "Alfy is reading…" then "Alfy is writing…" with typing dots. The
   target block gets a 3 px accent bar in the gutter with a moving gradient, its text dimmed to 45 %, and
   an inline tag `✦ Alfy is writing…` at the end of the block. A new section (create, insert) shows the
   dashed "planned" box from the approved mockup: "Alfy is writing: museums in the morning, cafés after".
   The state is shown for at least 600 ms even when the call is faster, so it is seen.
5. **The change lands.**
   - The new words fade in with the Alfy mark: `--alfy-mark` tint plus a 2 px accent underline,
     arriving at `--alfy-mark-arrive` (34 %) and relaxing to 15 % over `--duration-settle`.
   - An inline pill follows the changed words, `[✦ Alfy | ✓ Keep | ↶ Undo]` (Keep filled, Undo ghost).
     It is a ProseMirror widget decoration, so it flows with the text and never covers another line.
   - The **review bar** rises at the bottom of the text column: `✦ Alfy changed 1 part. Left 1 alone.`,
     a `‹ 1 / 2 ›` stepper, `[↶ Undo all] [✓ Keep all]`. "Left 1 alone." is a link to the refused line.
   - The thread's Alfy reply gets the change chip "Edited · waiting for you · See change".
   - The version button bumps (`v6` → `v7`); the chat card says "1 change to review"; if the panel is
     closed, the chat header's count button shows a dot.
6. **Decide.**
   - Keep: the pill becomes "✓ Kept" for 1.4 s and fades; the tint settles to nothing over 700 ms; the
     thread chip says "kept".
   - Undo: the words cross-fade back; the pill shows "↶ Undone · Redo" for 5 s; a version is recorded
     ("Undid Alfy's change").
   - Keep all / Undo all act on every pending change; the bar leaves when none is left.

**Refusal ("your words win").** The refused line keeps the user's words and gets a dashed amber rule in
the gutter. Beside it, in the margin, a warning card of the comment family:

```
┌ ⚠ Alfy left this line alone ─────────────────┐
│ “Book the flight. Anna has miles, so I'll…”  │
│ You changed it after Alfy read it, so your   │
│ words stay.                                  │
│ [✦ Ask again]  Dismiss                       │
└──────────────────────────────────────────────┘
```

On phones the note is the first item in the Comments sheet and the review bar carries the summary.

**Reload with a pending change.** Today the decision silently disappears. Proposal (needs an owner
call, [§12](#12-open-questions-for-the-owner)): changes still pending when the page unloads count as
kept, and the next open shows one line under the header, "Alfy changed 2 parts on your last visit ·
Review", which opens Versions at that version.

**The chat side.** When an edit comes from a chat turn, the assistant message shows the tool row
("✓ Edited Vienna trip plan") and a compact card: `Vienna trip plan · [✦ 1 change to review]
[⚠ 1 part left alone] · Review ›`. Review opens the panel on the document and steps to the first change.
Afterwards the card reads "✓ Reviewed". While a Document or App is open, the chat composer's placeholder
names it ("Ask Alfy to change Vienna trip plan…"), as the approved App mockup showed.

### 4.3 States

| State | Where | What shows |
|---|---|---|
| Selection | text | pill above (or below) the selection |
| Composing | text | composer; pending highlight on the words |
| Sending | margin | new card appears; the composer is gone |
| Alfy reading / writing | thread + block | typing dots; gutter bar, dimmed words, inline tag; planned box for new sections |
| Applied | block + bar | mark, inline pill, review bar, chip in thread, version bump |
| Partly refused | block + margin + bar | mark on the applied part, warning note on the refused line, "Left 1 alone." |
| Fully refused | margin + thread | warning note; Alfy's reply "I left the text as it is…"; no bar |
| Nothing to change | thread | Alfy: "It already reads well, so I left it as it is." |
| Failed (tool error) | thread + chat | Alfy's message in warning text, "Couldn't change the text. Try again", with Ask again |
| Kept / Undone | pill | "✓ Kept" 1.4 s / "↶ Undone · Redo" 5 s |
| Offline | composer | Send disabled, "You're offline"; the draft is kept |
| Several changes | bar | "Alfy changed 3 parts.", stepper moves between them (switching tab if needed) |
| Phone | text | a docked bar above the toolbar `[✦ Ask Alfy] [💬 Comment]` (44 px), composer in a sheet, bar above the toolbar with 44 px Keep all / Undo all |

### 4.4 Accessibility

- The pill is a `role="toolbar"` named "Selection"; Tab from a non-collapsed selection moves into it,
  Escape returns to the text with the selection intact. Shortcut: ⌘/Ctrl+Alt+M opens the Comment
  composer directly (the Google Docs convention).
- The composer is a labelled dialog ("Ask Alfy about ‘…’"); focus starts in the textarea.
- The inline pill is `role="group"` named "Alfy's change: ‘Book the hotel by Friday…’"; its buttons are
  "Keep Alfy's change" and "Undo Alfy's change". The stepper buttons are "Previous change" / "Next change".
- Landing is announced politely: "Alfy changed 1 part and left 1 alone. Review it below the text."
- Contrast: the filled Keep uses `--accent-fill` with `--on-accent` (5.0:1 light, 6.0:1 dark; white on
  the raw accent would be 4.2:1 light and 2.9:1 dark). The mark relies on underline plus tint, not tint
  alone.
- Targets: 20 px buttons inside the inline pill are the desktop compromise for running text; on phones
  they get a 44 px hit area (an `::after` inset), and the review bar carries 44 px Keep all / Undo all.
- Reduced motion: see [§7.3](#73-reduced-motion).

### 4.5 Hungarian allowance

"Keep" → "Megtartom" (2.25×), "Undo" → "Visszavonom" (2.75×), "Keep all" → "Mindet megtartom",
"Undo all" → "Mindet visszavonom", "Ask Alfy" → "Alfy megkérdezése". The inline pill in Hungarian is
about 250 px, which fits a 540 px text column, and it may wrap to its own line (checked in the mockup's
HU view). The review bar wraps to two rows below 520 px. Note: the Hungarian Keep/Undo use first-person
verbs while the rest of the UI uses nouns ("Lezárás", "Megnyitás"); keep it (it reads naturally as a
decision) but do it consistently for the new "Mindet megtartom" / "Mindet visszavonom".

---

## 5. Surface c · panel shell, list, tabs, toolbar and cards

### 5.1 Problems observed

1. **Header vocabulary**: "ACTIVE DOCUMENT" for every kind, including an App and a File
   ([d1](current/d1-app-preview-desktop-light.png), [c4](current/c4-file-in-panel-desktop-light.png));
   a "Knowledge Base" pill under the title; kind and version as two grey pills.
2. **Unlabelled, duplicated actions**: grid, clock, download, expand, close as bare icons. The clock is
   permanently `disabled` ("History arrives with documents.", `DocumentWorkspace.svelte` l. 1084–1092)
   while the toolbar has a working History; Download is in both places.
3. **Two lists in one panel**: the old "Open documents" rail (with a leaked `UNSUPPOR…` status and the
   "Knowledge Ba…" source) beside the new "What this chat made" list ([d1](current/d1-app-preview-desktop-light.png)).
4. **The list is a stack of cards**: every item shows title, subtitle, "made by Alfy just now", a kind
   pill repeating the subtitle, a version pill, the checklist (13 px checkboxes on phones) and its own
   "Open" button ([c1](current/c1-panel-list-desktop-light.png), [c1 phone](current/c1-panel-list-mobile-light.png)).
   "Document · 1 tabs" is not plural-aware.
5. **Tabs**: a pencil and a cross on every tab; clicking a tab changes nothing but the highlight.
6. **Toolbar**: 15 undivided icons including Download and History ([c3](current/c3-panel-header-tabs-toolbar-desktop-light.png));
   the phone More sheet has no title, no close button, no Comments ([c5](current/c5-mobile-more-sheet-light.png)).
7. **In-chat cards** sit inside the grey tool-row box under "Thought for 0s" with a timing ("1 ms") and
   read like a log entry; after an edit, the card shows the checklist instead of the edit
   ([e1](current/e1-chat-tool-row-expanded-desktop-light.png), [b4](current/b4-change-marks-refusal-desktop-light.png)).
8. **Motion**: the panel appears with a 150 ms fade that moves it 20 px from the *left*; the chat column
   snaps to its new width; list ↔ item swaps are instant.

### 5.2 Redesign

**One header for every kind** (a new shared `ArtifactPanelHeader.svelte`):

```
‹ THIS CHAT  3                              [💬4] [⤓] │ [⤢] [✕]
Vienna trip plan                                   (serif, 22 px)
✎ Document · [v6 ▾] · You and Alfy · edited 2 min ago
```

- The breadcrumb `‹ This chat 3` returns to the list (replaces the unlabelled grid icon).
- The kind is plain text with its Lucide icon; the **version is a button** (`v6 ▾`) that opens Versions,
  so there is one History entry and it sits where the version is.
- Actions: Comments (Document only, with the open count), Download, a divider, Expand, Close. Each has an
  `aria-label` and a tooltip after 350 ms. No disabled placeholders; no source pill.
- The same header serves App ("Made by Alfy · 30 min ago"), File ("PDF · 180 KB") and later Canvas and
  Slides.

**The list**: one line per item, the row is the button.

```
[✎]  Vienna trip plan                          2 min ago
     Document · 3 tabs · v6              [✦ 1 change to review]
```

- Kind tile (34 px, accent tint), title (14 px bold), a muted line with kind and facts, time on the
  right, a chevron on hover or focus. The open item is tinted. Pending review shows as a status pill.
- Header: eyebrow "This chat", serif title "What this chat made", "3 items · newest first".
- Empty: "Nothing made here yet." plus the line "Ask Alfy for a document, an app or a file."
- The old "Open documents" rail does not appear for artifact kinds; where it remains (comparing
  uploads), it never shows internal statuses.

**Tabs switch sections.** Each tab shows only its section (the approved mockup's "Plan · Budget ·
Packing"). Implementation: a node decoration hides blocks outside the active tab's range, so there is
still one editor and anchors, patches and ids are untouched. The active tab has an accent underline that
slides; other tabs show an amber badge with their open comments. Rename and Delete move into a `⋯` menu
on the active tab (and double-click to rename). Arrow keys move between tabs.

**Toolbar**: grouped `B I S | H1 H2 | • 1. ☑ | ❝ ⊞ 🔗 | ↶ ↷`, with a "✓ Saved" state on the right
(from `document-autosave.ts`). Download and History leave the toolbar (they are in the header). On
phones the bottom toolbar keeps six actions plus More; the More sheet gets a title ("More formatting"),
a close button and the `DialogShell` sheet behaviour.

**In-chat cards** stand on their own, below the tool row and outside the collapsible thinking group:

```
✓ Created  Vienna trip plan
┌──────────────────────────────────────────────┐
│ [✎]  Vienna trip plan               Open ›   │  the head is one button
│      Document · 3 tabs · v6                  │
│      ☑ Renew passport                        │  tickable, same list as the document
│      ☐ Buy a travel adapter                  │
│      +2 more                                 │
└──────────────────────────────────────────────┘
```

- When that item is open in the panel, the card is outlined in accent and "Open ›" reads "Open in panel".
- After an edit: "1 change to review" and "1 part left alone" pills and "Review ›" (see [§4.2](#42-redesign-one-chain)).
- Checklist ticks are 44 px tall on phones.

### 5.3 States

| Element | States |
|---|---|
| Count button | hidden when nothing was made; count; pressed (panel open); dot (a change waits while the panel is closed) |
| Panel | closed; opening; list; item; expanded; narrow (rail becomes a drawer); phone (full screen, slides in from the right) |
| List | loading (three skeleton rows); empty; rows; row with pending review; current row |
| Header | kind variants; version button; title editable on click (Documents); offline (actions stay, Download disabled with a reason tooltip) |
| Tabs | one tab (strip hidden, as today); several; with badges; renaming; overflow (horizontal scroll with fade edges) |
| Card | creating (skeleton lines and "Alfy is writing…", spinner in the tool row); ready; open in panel; changes to review; reviewed; failed ("Couldn't create the document", Retry); deleted ("This document was deleted", muted, no Open) |
| Toolbar | editor loading (disabled); active marks; saving / saved / offline / conflict (the existing save notices move into the toolbar's right end) |

### 5.4 Accessibility

- The panel is a labelled `<aside>` named after the open item ("Vienna trip plan, Document"); the list
  is `<ul>` of buttons.
- Opening the panel moves focus to the title (list: to the first row); closing returns it to the count
  button or the card that opened it. Escape closes the innermost layer first (popover, sheet, composer,
  then the panel), as `DocumentWorkspace` already does for its list.
- Tabs: `role="tablist"` with roving `tabindex` and arrow keys (today there is no keyboard handling).
- Toolbar: `role="toolbar"` with roving `tabindex` so it is one tab stop.
- Icon buttons: 32 px on desktop, 44 px on phones; the count badge uses `--accent-fill` / `--on-accent`.

### 5.5 Hungarian allowance

"What this chat made" → "Amit ez a beszélgetés készített" (+63 %; the list title may wrap to two lines),
"This chat" → "Ez a beszélgetés" (+100 %, the breadcrumb truncates the title, never the crumb),
"Open in panel" → "Megnyitva a panelen", "1 change to review" → "1 módosítás vár rád". Kind names:
"App" → "Alkalmazás" (3.3×), so kind labels are never fixed-width pills.

---

## 6. Surface d · the App panel and the Knowledge Documents tab

### 6.1 Problems observed

**App panel** ([d1](current/d1-app-preview-desktop-light.png), [d1 phone](current/d1-app-preview-mobile-light.png),
[d2](current/d2-app-code-desktop-light.png)):

1. The header calls the App an "ACTIVE DOCUMENT", adds the "Knowledge Base" source pill, and the old
   "Open documents" rail takes 260 px beside the app, listing the Document and the App as `UNSUPPOR…`.
2. The fact check sits at the bottom edge, under the app: the app's name repeated with an icon, the
   verify line, then a boxed "Alfy's note". The text starts at the panel's edge with no padding; on the
   phone it touches the screen edge.
3. "Download as .html" and "Ask Alfy for a new version" sit flush in the bottom-left corner; Download
   repeats the header's download icon.
4. Nothing says the app runs sandboxed, has no internet and keeps its data, the approved mockup's three
   promises.
5. "Ask Alfy for a new version" opens a modal (`DialogShell`) whose Dismiss and Regenerate buttons have
   no button class, and the modal stays up, disabled, for the whole generation: the app is hidden behind
   a scrim with no progress.

**Knowledge Documents tab** ([d3 all](current/d3-knowledge-documents-all-desktop-light.png),
[d3 files](current/d3-knowledge-two-chip-rows-desktop-light.png),
[d3 phone](current/d3-knowledge-two-chip-rows-mobile-light.png)):

1. The file-type row ("File type: PDF 1 · Word 1 · …") appears under the kind row with nothing tying it
   to "Files". There is no "All files" chip: clearing a file type means clicking the active chip again,
   which nothing on screen suggests.
2. Zero-count chips (Canvas 0, Slides 0) look exactly as clickable as the others.
3. Three counts disagree at a glance: the eyebrow pill "7 documents", the summary "7 uploaded · 2
   documents · 1 apps" (plural bug) and "All 10".
4. Choosing a chip swaps the table instantly, and the file-type row pops in and out.

### 6.2 Redesign

**App panel** (mockup: **d · App & Knowledge** → Open the App, Ask for v2):

```
‹ THIS CHAT 3                                   [⤓] │ [⤢] [✕]
Trip budget splitter
▭ App · [v1 ▾] · Made by Alfy · 30 min ago
─────────────────────────────────────────────────────────────
🛡 Alfy checked the facts and fixed one thing.   Read Alfy's note ⌄
─────────────────────────────────────────────────────────────
[👁 Preview | ‹› Code]                      [✦ Change this app…]
┌ 🔒 Runs sandboxed · no internet · keeps your numbers ─────────┐
│  (the app, full height)                                       │
└───────────────────────────────────────────────────────────────┘
```

- The shared header ([§5.2](#52-redesign)); Download is the header icon ("Download as .html" in its
  tooltip), so it exists once.
- The fact check is a status row directly under the header: `ShieldCheck` (success) for clean and
  repaired, `ShieldAlert` (warning) for uncertain, a muted `Shield` for unavailable, a spinner while
  checking. "Read Alfy's note" expands the note in place (height animation). Glitch notices (network,
  storage, external files) are warning rows in the same place.
- Preview / Code is a segmented control; "Change this app…" sits on the same row as the one primary
  action. The sandbox promise is a thin bar on the frame itself.
- "Change this app…" opens a popover anchored to the button (not a modal): "What should change?", a
  textarea, `[Cancel] [✦ Make v2]`, and the effect line "Alfy writes a new version and checks its facts.
  v1 stays in Versions."
- While v2 is built, v1 stays visible, dimmed to 55 %, under a small veil: "✦ Alfy is building v2 · v1
  stays until v2 is ready. Your saved numbers are kept." with a progress bar; the status row reads
  "Alfy is checking the facts in v2…". When v2 lands it fades in, the version button bumps, and a toast
  says "Now showing v2 · Undo".
- The approved mockup's other idea stays: while an App is open, the chat composer's placeholder reads
  "Ask Alfy to change Trip budget splitter…".

**Knowledge chips** (mockup: **d** → Go to Files):

- One summary line with correct plurals: "11 items · 8 files, 2 documents, 1 app". The eyebrow pill that
  disagreed goes.
- Kind row: `All 11 · Documents 2 · Apps 1 · Canvas 0 · Slides 0 · Files 8`, each with its Lucide kind
  icon. Zero-count chips are dimmed, dashed and disabled, with a reason on hover ("No canvases yet").
- Choosing Files grows the file-type row out of it: a tinted tray with a connector from the Files chip,
  starting with **All files 8**, then `PDF 2 · Word 1 · Spreadsheets 2 · Presentations 1 · Images 1 ·
  Text 1`. The active sub-chip is filled (text colour), so the two rows read as parent and child.
  Leaving Files collapses the tray.
- The table cross-fades on every chip change (rows out in 100 ms, in with a 20 ms stagger).

### 6.3 States

| Element | States |
|---|---|
| App status row | checking (spinner, "Alfy is checking the facts…"); clean; repaired + note; uncertain + note (warning); unavailable (muted); glitch notices |
| App frame | loading (skeleton frame with the sandbox bar); running; failed to serve ("This app didn't load. Reload"); network blocked notice |
| Change this app | closed; open (prompt); building (veil, v1 dimmed); failed ("Alfy couldn't make v2. v1 is unchanged." + Try again, in the status row); done (toast with Undo) |
| Code view | code; copy → "Copied" for 1.5 s |
| Knowledge chips | loading (chip skeletons); counts; zero (disabled); Files active with the tray; a file type active; empty result ("No PDFs yet" with a Clear button that resets to All files) |

### 6.4 Accessibility

- The status row is a live region only while checking or building ("Alfy is building v2" is announced
  once, and again when done).
- Preview / Code keep `role="tablist"`; the popover is a labelled dialog with the focus trap and Escape.
- The busy veil never traps focus; the frame is `inert` while dimmed so keyboard users do not type into
  an app that is about to be replaced.
- Chips are toggle buttons with `aria-pressed`; the file-type tray is a `role="group"` named
  "File type"; disabled zero chips keep a reason in `title` and `aria-describedby`.
- Phone: Preview/Code and "Change this app…" are 44 px tall; the chip rows wrap, 36 px chips with 44 px
  hit areas.

### 6.5 Hungarian allowance

"App" → "Alkalmazás" (3.3×), "Change this app…" → "Módosítás…" (shortened on purpose so the row fits
390 px; the popover's title carries the full meaning), "Preview" → "Előnézet", "Download as .html" →
"Letöltés .html-ként" (tooltip only). Knowledge: "Files" → "Fájlok", "All files" → "Minden fájl",
"Spreadsheets" → "Táblázatok", "Presentations" → "Bemutatók"; the tray wraps to three rows on a phone,
which is acceptable.

---

## 7. Motion spec

### 7.1 Principles

1. Motion only answers "what just happened, and where did it go": things move from their cause to their
   effect, and the panel enters from the side it lives on.
2. Alfy's work arrives loud and settles quiet: a strong tint that relaxes over `--duration-settle`, so a
   glance shows what is new, and the page is calm again a moment later.
3. Short and consistent: 100 ms exits, 150 ms state changes, 250 ms arrivals, 700 ms settling; under
   reduced motion everything switches instantly and no information depends on movement.

### 7.2 What animates

Tokens: `--duration-micro` 100 ms, `--duration-standard` 150 ms, `--duration-emphasis` 250 ms (all
existing), `--duration-settle` 700 ms (new). Easings: `--ease-out` (existing), `--ease-emphasis`
`cubic-bezier(0.2, 0, 0, 1)` for arrivals, `--ease-in` `cubic-bezier(0.4, 0, 1, 1)` for exits (new).

| # | What | Trigger | Motion | Duration · easing | Reduced motion |
|---|---|---|---|---|---|
| 1 | Panel opens | count button, card Open | panel column grows from 0 to its width while the chat column narrows (`grid-template-columns`); content slides in 32 px from the right and fades in, 60 ms after | emphasis · ease-emphasis | panel and chat take their final widths at once |
| 2 | Panel closes | ×, Escape, count button | column shrinks to 0; content fades out | standard · ease-in | instant |
| 3 | List → item | row click | list slides 28 px left and fades (standard · ease-in); item slides in from 28 px right (emphasis · ease-emphasis) | as stated | instant swap |
| 4 | Item → list | breadcrumb | mirror of 3 | as stated | instant swap |
| 5 | List rows arrive | panel opens on the list | each row rises 6 px and fades in, 30 ms stagger, first six rows only | emphasis · ease-emphasis | none |
| 6 | Tab switch | click, arrow keys | underline slides to the new tab (left + width); the section fades in, rising 4 px | underline emphasis · ease-emphasis; section standard · ease-out | underline jumps; section appears |
| 7 | Selection pill in / out | selection ends / click away, Escape | in: fade, 4 px rise, scale 0.98 → 1 from the selection; out: fade | in standard · ease-emphasis; out micro · ease-in | instant |
| 8 | Pill → composer | Ask Alfy, Comment | the box morphs (width, height, position); contents fade in after 80 ms | emphasis · ease-emphasis | instant swap |
| 9 | Comment goes to the margin | send | the composer's box travels to the new card's rect and fades; the card fades in during the second half | emphasis · ease-emphasis; card standard, 150 ms delay | card appears in place |
| 10 | Alfy reading / writing | request running | thread: three typing dots (1 s loop); block: gutter bar gradient (1.2 s loop), words at 45 %; tag fades in | loops; tag standard · ease-out | static bar and static "Alfy is writing…" text, no loop |
| 11 | Change arrives | tool result | new words fade in; mark tint from 34 % to 15 %; inline pill scales 0.92 → 1 and fades in | tint settle · ease-out; pill emphasis · ease-emphasis | mark at resting tint; pill at rest |
| 12 | Review bar up / down | first pending change / none left | rises from below the text column and fades in / sinks and fades out | up emphasis · ease-emphasis; down standard · ease-in | instant |
| 13 | Keep | Keep, Keep all | pill contents swap to "✓ Kept" (scale 0.96 → 1); tint and underline fade to nothing; pill leaves after 1.4 s | swap standard; tint settle · ease-out; leave standard · ease-in | tint removed at once; "Kept" shown 1.4 s |
| 14 | Undo | Undo, Undo all | Alfy's words fade out, yours fade in; pill shows "Undone · Redo" for 5 s | out micro · ease-in; in standard · ease-out | instant swap |
| 15 | Version bump | any new version | the number rises 6 px into place | emphasis · ease-emphasis | instant |
| 16 | Thread ↔ words link | hover or focus a card or highlight | highlight deepens; card border and shadow; card shifts 6 px towards the text; card top moves when layout changes | standard · ease-out; `top` emphasis · ease-emphasis | colour only, no shift |
| 17 | Flash the words | quote click, See change, stepper | a 3 px ring and deeper tint that fades | settle · ease-out (900 ms total) | static ring for 900 ms |
| 18 | Resolve / reopen | Resolve, Reopen | card height animates to the one-line fold (or back); the check scales 0.4 → 1; the highlight fades | height emphasis · ease-emphasis; highlight settle · ease-out | instant fold |
| 19 | Peek a resolved thread, open a reply composer | click | height animates | standard · ease-emphasis | instant |
| 20 | New message in a thread | send, Alfy replies | rises 4 px and fades in | emphasis · ease-emphasis | instant |
| 21 | Removed-text group | toggle | height 0 ↔ auto; chevron rotates 90° | open emphasis · ease-emphasis; close standard · ease-in | instant |
| 22 | Refusal note | edit result / Dismiss | appears with the rail (rise 6 px); Dismiss slides 8 px right and fades | in emphasis; out standard · ease-in | instant |
| 23 | Versions / Download / Change-this-app popovers | their buttons | scale 0.98 → 1 with a 4 px drop from the button's corner; out fades | in standard · ease-emphasis; out micro · ease-in | instant |
| 24 | Phone sheets | Comments, Versions, composer, More | slide up from below; scrim fades | in emphasis · ease-emphasis; out standard · ease-in | instant |
| 25 | Card creating → ready | tool call starts / finishes | skeleton lines shimmer (1.4 s loop); the body's height animates to its content; tasks rise with 40 ms stagger | height emphasis · ease-emphasis | static skeleton; instant swap |
| 26 | Card state | panel opens that item, changes wait | border colour and a 3 px ring | standard · ease-out | instant |
| 27 | Checklist tick | click | box fills; the check scales 0.6 → 1; a strike line draws left to right | fill standard; check standard · ease-emphasis; strike emphasis · ease-emphasis | instant |
| 28 | App: Preview ↔ Code | segmented control | the thumb slides; content cross-fades | standard · ease-emphasis | instant |
| 29 | App: note | "Read Alfy's note" | height 0 ↔ auto; chevron rotates 180° | emphasis · ease-emphasis | instant |
| 30 | App: building v2 | Make v2 | preview dims to 55 %; a veil with the progress bar fades in; the status line becomes a spinner | emphasis · ease-out; progress loops | static "Alfy is building v2" text |
| 31 | App: v2 ready | done | new preview fades in from scale 0.99; toast rises 12 px | emphasis · ease-emphasis | instant |
| 32 | Knowledge chips | chip click | rows fade out (micro · ease-in), then rise 4 px with 20 ms stagger (emphasis · ease-emphasis); the file-type row grows from the Files chip (height emphasis) with 20 ms chip stagger and collapses (standard · ease-in) | as stated | instant |
| 33 | Toast | restore, v2 | rises 12 px and fades in; leaves after 5.2 s | in emphasis · ease-emphasis; out standard · ease-in | instant |

What never animates: text the user is typing, the editor's own caret and selection, scroll position
(except scroll-to-target, which is smooth only when motion is allowed), and anything on a timer that
the user did not cause (no idle pulses, no attention shakes).

### 7.3 Reduced motion

`app.css` already collapses every CSS transition and animation to 0.01 ms under
`prefers-reduced-motion: reduce`, and `reducedMotionAware()` in `src/lib/utils/motion.ts` does the same
for Svelte transitions. The redesign relies on both and adds three rules:

1. Web Animations API calls (the FLIP travel in #9, height animations) go through one helper that
   returns immediately under reduced motion; `motion.ts` is the place for it.
2. Loops (#10, #25, #30) become static states with text: "Alfy is writing…", never an animated dot alone.
3. Anything that carried meaning through motion keeps a static marker: the arrived change keeps its
   tint until Keep or Undo, the flashed words get a static ring for 900 ms, the removed-text group
   still says how many it holds.

The mockup's "Reduced motion" checkbox previews this, and it also follows the OS setting.

---

## 8. Shared parts for Canvas and Slides

Canvas and Slides reuse the same panel, so these pieces are built once, in `src/lib/components/artifacts/`,
and know nothing about Tiptap:

| Part | Contract | Document | Canvas / Slides later |
|---|---|---|---|
| `ArtifactPanelHeader.svelte` | kind, title, version (+ `onVersions`), meta, actions snippet, `onBack` | as above | same; Slides adds Present to the actions |
| `CommentCard.svelte` + `CommentThread.svelte` | thread data, `onResolve`, `onReply`, `onGoto(anchor)`, change chip, refusal and guess variants, folded state | anchor = text quote | anchor = node or point; the quote line shows the node's label ("Trains card", "Slide 2") |
| `CommentRail.svelte` (from `MarginPanel`) | positioned cards (`margin-layout.ts`), filter, removed group, other-sections summary | beside blocks | beside the board (pins on the canvas), beside the slide list |
| `ChangePill.svelte` (today `ChangeBar`) | pending / kept / undone, `onKeep`, `onUndo`, `onRedo` | ProseMirror widget after the change | floats at the node's corner; on a slide, at the element |
| `ReviewBar.svelte` (new) | pending count, refused count, index, prev/next, Keep all / Undo all | bottom of the text column | bottom of the board / the slide |
| `RefusalNotice.svelte` | becomes the warning card variant of the comment family plus the one-line summary for `ReviewBar` | pinned beside the line | pinned beside the node |
| `AlfyWriting.svelte` | block state (gutter bar, dimmed content, tag) and planned-section box | block decoration | a dashed frame around the node Alfy is arranging ("Alfy is arranging Saturday…") |
| Selection pill + composer | quote, mode, suggestions, effect line, `onSubmit` | text selection | node selection (the approved Canvas mockup's "Ask Alfy · Refresh · Comment") |

---

## 9. Implementation map

### 9.1 Tokens to add

In `src/app.css` (light and dark), mapped in `tailwind.config.ts` where a utility is useful:

| Token | Light | Dark | Why |
|---|---|---|---|
| `--duration-settle` | 700 ms | same | highlight settling; also in the reduced-motion override |
| `--ease-emphasis` | `cubic-bezier(0.2, 0, 0, 1)` | same | arrivals |
| `--ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | same | exits |
| `--accent-text` | `#9f5135` (5.4:1) | `#e0937c` (7.2:1) | small accent text; the raw accent is 4.0:1 in light |
| `--accent-fill`, `--on-accent` | `#ae5630` / `#ffffff` (5.0:1) | `#d4836b` / `#1a1a1a` (6.0:1) | filled buttons and badges |
| `--accent-tint`, `--accent-tint-strong` | accent 12 % / 22 % | same | tiles, pressed states |
| `--alfy-mark`, `--alfy-mark-arrive` | accent 15 % / 34 % | 17 % / 36 % | the change mark |
| `--comment-mark`, `--comment-mark-active`, `--comment-rule` | amber 24 % / 46 %, `#a07a02` | 17 % / 34 %, `#facc15` | commented words |
| `--warning-text`, `--warning-tint` | `#8a4b06`, warning 11 % | `#f5b04a`, 15 % | replaces the undefined `--status-warning-*` |
| `--success-text`, `--success-tint` | `#166534`, success 11 % | `#4ade80`, 14 % | "Facts checked", "Paid" |

Also: set `color-scheme: dark` on the dark root so native controls follow; define (or stop using)
`--status-danger`, which `CommentThread` references and nothing defines. The existing global
`btn-primary` puts accent text on a 12 % accent tint (3.5:1 in light); switching its colour to
`--accent-text` fixes that everywhere and is worth a separate small change.

### 9.2 Components

| File | Change |
|---|---|
| `src/app.css`, `tailwind.config.ts` | tokens above; remove the need for `.btn-text` |
| `src/lib/components/artifacts/document/DocumentBody.svelte` | prose styles for `.document-content` (serif body, sans headings, lists, inline task items, tracker table, chip selects styled as pills, quotes, code); one scroll container holding text and rail; review bar placement; toolbar save state; tab section visibility |
| `src/lib/components/artifacts/document/extensions.ts`, `document-editor.ts` | decorations: comment anchors (with active state and click → thread), Alfy writing on blocks, refused-line rule, tab-range visibility, the inline change pill as a widget decoration |
| `src/lib/components/artifacts/document/marks.ts` | `.alfy-change` gets its style and an `arrive` class for the settle animation |
| `src/lib/components/artifacts/document/MarginPanel.svelte` | becomes the rail: header with Open/All, removed-text group, other-tabs summary, empty state; the scroll-sync effect is deleted; `margin-layout.ts` is kept as is |
| `src/lib/components/artifacts/CommentCard.svelte` | new anatomy: avatar (`AvatarCircle` for the user, sparkle tile for Alfy), name, time, body with `@Alfy` highlighted, Guess tag, change chip, refusal variant; actions as `btn-ghost btn-sm` with icons |
| `src/lib/components/artifacts/document/CommentThread.svelte` | card container, quote button, folded resolved state and peek, reply composer that turns into Ask Alfy, typing placeholder |
| `src/lib/components/artifacts/document/SelectionBubble.svelte` (+ `bubble-placement.ts`) | horizontal pill, composer mode with quote, suggestions and effect line; composer-height-aware flip; phone docked bar |
| `src/lib/components/artifacts/document/ChangeBar.svelte` | becomes the inline pill (keep `data-testid="alfy-change-bar"`), with Redo after Undo |
| new `src/lib/components/artifacts/ReviewBar.svelte` | the bottom summary bar (shared) |
| `src/lib/components/artifacts/RefusalNotice.svelte` | warning card variant pinned beside its line + summary line (keep `data-testid="refusal-notice"`) |
| `src/lib/components/artifacts/document/AlfyWriting.svelte` | in-place block state and the planned box; minimum visible time 600 ms |
| `src/lib/components/artifacts/document/Tabs.svelte` | sliding underline, badges, `⋯` menu (rename, delete), arrow keys, activation that switches the section |
| `src/lib/components/artifacts/document/DocumentToolbar.svelte`, `toolbar-actions.ts` | groups and dividers, roving tabindex, no Download/History |
| `src/lib/components/artifacts/document/MobileToolbar.svelte` | More sheet through `DialogShell` (title, close) |
| `src/lib/components/artifacts/document/VersionsSheet.svelte`, `DownloadSheet.svelte` | popovers anchored to their header buttons, `focusTrap` attachment with `onEscape` and `restoreFocusOnCleanup`, sheets on phones, inline restore confirm, avatars |
| new `src/lib/components/artifacts/ArtifactPanelHeader.svelte` | the shared header |
| `src/lib/components/document-workspace/DocumentWorkspace.svelte` | uses the header; list rows; push navigation; open/close motion (slides from the right, chat width transition); hides `OpenDocumentsRail` for artifact kinds; removes the disabled History placeholder, the "Active document" eyebrow and the source pill for artifact kinds; narrow-panel drawer for comments |
| `src/lib/components/artifacts/ArtifactCard.svelte` | new `chrome="row"` (append-only, for the list); standalone card styling and states (creating, open in panel, to review, failed, deleted) |
| `src/lib/components/chat/ToolActivityRow.svelte` and its host message component | render the artifact card after the tool-row group, outside the collapsible thinking area; hide the millisecond timing for artifact tools |
| `src/routes/(app)/chat/[conversationId]/+page.svelte` | count button pressed state and pending dot; composer placeholder names the open item |
| `src/lib/components/artifacts/app/AppBody.svelte`, `AppFrame.svelte` | status row under the header (verify line, note toggle, glitch notices), segmented Preview/Code with "Change this app…" beside it, sandbox bar on the frame; the regenerate modal becomes an anchored popover (with real button classes) and a non-blocking busy veil over a dimmed, `inert` v1; v2 toast with Undo; Download only in the header |
| `src/routes/(app)/knowledge/_components/DocumentsList.svelte` | zero-count chips dimmed and disabled with a reason; file-type row attached to Files with an "All files" chip; reveal animation; one count source (the "7 documents" pill disagrees with "All 10") |
| `src/lib/i18n/artifacts.ts` (+ `scripts/validate-i18n.ts` if a key namespace is added) | new strings in EN and HU (list in the mockup's `T` table); ICU plurals for `artifacts.document.cardSubtitle` ("1 tab") and the Knowledge summary ("1 app") |

### 9.3 Primitives to reuse

- `DialogShell.svelte` with `phonePresentation="sheet"` for every phone sheet (Comments, Versions,
  composer, More); its exported `backdropFade`, `panelSlide`, `panelScale` for Svelte transitions.
- `focusTrap` attachment (`src/lib/utils/focus-trap.ts`) for popovers: `onEscape`, `restoreFocusOnCleanup`,
  `isTopmost` so Escape closes only the innermost layer.
- `reducedMotionAware` and `prefersReducedMotion` from `src/lib/utils/motion.ts`; add the WAAPI helper there.
- `portalToBody` (`src/lib/utils/portal.ts`) where a popover must escape the panel's overflow.
- `AvatarCircle.svelte` for user avatars, `Spinner.svelte`, `Toast.svelte` for undo toasts,
  `ConfirmDialog.svelte` only where an inline confirm is impossible.
- Button classes from `app.css`: `btn-primary`, `btn-secondary`, `btn-ghost`, `btn-icon-bare`, `btn-sm`.
- `formatRelativeTime` from `src/lib/utils/time.ts`; `margin-layout.ts` unchanged.
- Lucide icons only (`@lucide/svelte`): `Sparkles`, `MessageSquare`, `MessageSquareText`, `Check`,
  `Undo2`, `Redo2`, `RotateCcw`, `ChevronLeft/Right/Down/Up`, `CornerDownRight`, `CircleCheck`,
  `TriangleAlert`, `ShieldCheck`, `Eye`, `CodeXml`, `Lock`, `Download`, `Maximize2`, `X`, `Ellipsis`,
  plus the kind icons already in `ArtifactCard` (`SquarePen`, `AppWindow`, `FileText`, `Shapes`,
  `Presentation`).

---

## 10. Build plan

Small tasks, two or three per agent, in order. Each task keeps `npm run check` at 0/0, adds EN and HU
strings together, and keeps the existing test ids (`artifact-count-button`, `artifact-panel-list`,
`alfy-change-bar`, `refusal-notice`, `margin-comment`, `selection-bubble`, `document-tabs`).

**Agent 1 · foundations** (first; everything else depends on it)
1. Tokens and motion helpers: the tokens in [§9.1](#91-tokens-to-add), `color-scheme: dark`, the WAAPI
   helper in `motion.ts`, replace `.btn-text` and the undefined `--status-*` tokens.
2. Document prose and marks: `.document-content` typography, inline task items, tracker table, chip
   selects as pills, `.alfy-change` and comment-anchor styles in both themes.

**Agent 2 · panel shell**
3. `ArtifactPanelHeader.svelte` for Document, App and File; drop the disabled History placeholder, the
   eyebrow, the source pill and the Open-documents rail for artifact kinds.
4. List rows (`ArtifactCard chrome="row"`), list ↔ item push, panel open/close motion, count button
   pressed state and pending dot.
5. Tabs that switch sections (decoration), sliding underline, badges, `⋯` menu, arrow keys; grouped
   toolbar with roving tabindex and the save state; More sheet through `DialogShell`.

**Agent 3 · comments**
6. `CommentCard` / `CommentThread` anatomy: avatars, quote button, Guess tag, change chip, ghost
   buttons, fold on resolve, reply composer with the Ask Alfy switch.
7. The rail: one scroll with the text, Open/All filter, removed-text group, other-tabs summary, empty
   state, two-way linking through anchor decorations.
8. Comments on phones (sheet from the header and from a tapped highlight) and the narrow-panel drawer.

**Agent 4 · editing chain**
9. Selection pill and composer (Ask with suggestions and the effect line, Comment with the @Alfy switch),
   pending highlight, travel to the margin, phone docked bar and sheet composer.
10. Inline change pill as a widget decoration, `ReviewBar.svelte`, Keep/Undo/Redo, Keep all/Undo all,
    version bump, settle motion.
11. Alfy writing in place (block decoration, tag, planned box, 600 ms minimum), refusal as a pinned
    warning card with Ask again and Dismiss, Alfy's typing placeholder in threads.

**Agent 5 · cards, App, Knowledge**
12. In-chat cards: standalone placement, all states, the edit card with "Review ›", 44 px ticks on
    phones, plural fixes, composer placeholder naming the open item.
13. App panel: status row and note, Preview/Code with "Change this app…", sandbox bar, the regenerate
    popover in place of the modal, the non-blocking busy veil, v2 toast with Undo.
14. Knowledge chips: disabled zero chips, attached file-type row with "All files", reveal animation,
    one count, plurals.

**Agent 6 · verification** (Opus review at the end)
15. Update unit and e2e tests; axe checks on the panel in both themes; a reduced-motion pass; Hungarian
    screenshots at 390 × 844 and 1440 × 900 compared with the mockup.
16. Independent review of the whole batch before it reaches dev.

---

## 11. Where the build diverged from the approved mockups, and what they never specified

| Approved mockup (`docs/plans/claude-at-home-2-*-mockups.html`) | Built | This redesign |
|---|---|---|
| Serif document with headings, inline checkboxes, a tracker table with status pills and date chips | unstyled editor | restores it |
| Header: kind eyebrow, serif title, `v5` pill, "You and Alfy · edited 1 min ago", comments/versions/export/expand/close | "ACTIVE DOCUMENT", two grey pills, a source pill, a disabled History | shared header with a version button |
| Tabs: text tabs with an underline and `+` | pencil and cross on every tab; no switching | underline, `⋯` menu, real switching |
| Inline "Alfy · Keep · Undo" right after the change | an absolutely positioned bar over the next line; no mark style | inline pill, visible mark, review bar |
| "Alfy is writing: …" as a dashed planned section in place | grey banner above the text | in place, plus the planned box |
| Comments: avatar, name, text, "See change", Resolve | status pills, quotes, text-only actions | cards per the mockup, plus every state |
| List: one line per item (icon, title, kind, time); the row opens | full cards with checklist and an Open button each | one-line rows |
| Selection bubble: horizontal "Ask Alfy · Comment" above the selection | vertical menu below the selection | horizontal pill |
| Chat card: a standalone card | inside the tool row's grey box | standalone |
| App: Preview/Code in the header, the app fills the panel, change it by asking | verify line and actions at the bottom edge without padding | status row on top, Preview/Code with "Change this app…", Download in the header |
| Uploads listed in "What this chat made" | artifacts only | unchanged (not part of this pass) |

**Never specified by the mockups, specified here:** empty, loading, failed, offline and busy states for
every surface; resolved and removed-text threads; the refused line in place; several pending changes and
how to walk them; what happens after Keep or Undo; the relationship between the chat turn, the thread and
the document; phone comments; keyboard and focus order; reduced motion; and all motion.

---

## 12. Open questions for the owner

1. **Pending changes on reload.** Keep today's session-only marks and treat them as kept on reload, with
   a one-line "Alfy changed 2 parts on your last visit · Review" under the header ([§4.2](#42-redesign-one-chain))?
   Or persist the pending state so Keep/Undo survives a reload (a data change)?
2. **Rail default filter.** "All" (resolved threads stay, folded) or "Open" (resolved threads leave after
   folding)? The mockup uses All.
3. **Tabs as pages.** The redesign makes a tab show only its section, as the approved mockup implies.
   The build today shows the whole document whatever the tab. Confirm "one section per tab".

---

## Appendix: how the screenshots were made

- A local dev server on port 5720 with `PLAYWRIGHT_TEST=1` and a scratch copy of the e2e database,
  seeded with the suite's own helpers and conventions: `createDocumentArtifact` + `createComment` +
  `resolveComment` for the document and its five threads (one resolved, one on removed text, one with an
  `@Alfy` reply, one Alfy judgement call), `seedApp`-style rows for the App (verdict "repaired" with
  Alfy's note), `seedProducedFile`-style rows for the File, and `source_document` rows for seven uploads.
- The change marks and the refusal notice come from a real `edit_artifact` call through the suite's fake
  OpenAI-compatible provider (`AI_SMOKE_EDIT_ARTIFACT_MARKER`), exactly as `artifact-document.spec.ts`
  drives it; the in-chat card from a real `create_artifact` call (`AI_SMOKE_CREATE_ARTIFACT_MARKER`).
  The scripted user messages were renamed in the DOM for readability.
- Environment gaps, not design findings: no Docker sandbox and no MinerU on the machine, so the File
  preview shows "Failed to load file" ([c4](current/c4-file-in-panel-desktop-light.png)) and uploads show
  a FAILED extraction status ([d3](current/d3-knowledge-two-chip-rows-desktop-light.png)); a
  "degraded capabilities" banner was dismissed before capturing.
- "Alfy is writing" could not be captured: the fake model's tool call and its result reach the browser
  in the same stream chunk, even with the network throttled to 600 B/s. It is described from
  `AlfyWriting.svelte` and `DocumentBody.svelte`.
- The capture script was a throwaway Playwright spec run from the scratchpad; it is not committed.
