# Incognito, one-way — implementation spec

Owner decision (2026-09-22): an incognito conversation stays incognito for its whole life. The toggle
exists in exactly one place — the landing / new-chat page, before a conversation exists — and disappears
the moment the conversation exists. To be remembered again, the user starts a new chat.
Mockup agreed by the owner: https://claude.ai/artifact/LNiaSJQwXmUEqRXsrd3iR3 — the artboard sources are
local HTML files under `<scratchpad>/incognito-design/project/*.dc.html` (read them for exact colours,
sizes and copy; they are plain HTML/inline CSS).

The privacy promise is unchanged (`src/lib/i18n/legal.ts`): "saved-but-untracked" — the chat is saved and
can be revisited; nothing from it is learned into memory, analytics or personalisation. Never write copy
that implies deletion ("leaves no trace", "gone", "erased").

## Branch / mechanics

- Worktree branch `incognito/one-way` created from `dev` (`git checkout -b incognito/one-way dev` — the
  worktree does NOT start on `dev`). `ln -s <repo>/node_modules node_modules`, `mkdir -p data`.
- Node 22 explicitly: `PATH=/opt/homebrew/opt/node@22/bin:$PATH` for every npm/npx/vitest/playwright call.
- Commit in small steps with trailer `Co-Authored-By: Claude Sonnet <noreply@anthropic.com>`. No push, no merge.
- No `git stash`; stage by explicit path. `npm run lint` is broken by nested worktrees — lint `src scripts tests`.
- First commit: this spec copied to `docs/plans/incognito-one-way-spec.md`.

## 1. Server: the flag is one-way

`src/routes/api/conversations/[id]/+server.ts` (PATCH):
- `memoryIncognito: false` → `409 { error: "incognito_is_one_way" }`, no state change. (Also when the
  conversation is not incognito yet — false is never a valid write.)
- `memoryIncognito: true` → allowed only while the conversation has **no messages**; with messages →
  `409 { error: "incognito_requires_empty_conversation" }`. (Messages already sent may have been learned;
  the UI never offers this path, this is defence in depth.)
- Conversation creation (`POST /api/conversations`, the store's `createNewConversation`) accepts an optional
  `memoryIncognito: true` so a landing-page toggle armed before the conversation exists is applied
  atomically at creation, not by a follow-up PATCH (removes the race between "create → PATCH → first send").
  Keep the PATCH-true fallback for the no-messages case.
- Unit tests for all three PATCH outcomes and for creation with the flag. Existing guard tests
  `tests/cross-cutting/incognito-*-containment.test.ts` must stay green untouched.

## 2. Where the toggle lives (and only there)

Remove:
- the switch row in `ComposerToolsMenu.svelte` (the "+" menu keeps only Thinking in its switches section);
- the switch in `IncognitoPopover.svelte` (becomes information only, see §5);
- any other path that writes `memoryIncognito:false` from the client (`setConversationMemoryIncognito` in
  `src/lib/client/api/conversations.ts` only ever sends `true`; simplify its signature accordingly).

Add — desktop (`src/routes/(app)/+page.svelte`): a 40px round icon button (Lucide `VenetianMask`, 20px
glyph, `--surface-elevated`/white background, `--border-default` 1px border, subtle shadow) absolutely
positioned top-right of the chat stage (18px from top, 22px from right), `data-testid="incognito-arm"`,
`aria-label` = `chat.incognitoArm`. Rendered while **no message has been sent yet**: `!hasStarted &&
!memoryIncognito`. Revised 2026-09-22 from "no conversation exists" — the landing page creates its
conversation from the first keystroke (draft persistence) and from the first attachment, so keying on
`preparedConversationId` took the button away the moment the user started typing, which is the moment
most people reconsider. A message-less conversation has had nothing learned from it, which is the same
condition §1's PATCH allows, so arming one is honest: the arm applies the empty-conversation PATCH to
whatever draft conversation already exists (and disarms if the server refuses, rather than showing
incognito over a row that is not). It goes on `hasStarted` — the first send — and never comes back; a
conversation that already carries messages has no button anywhere. Native tooltip is not enough: on hover/focus show a small
dark tooltip (max 220px, `--text-primary` background, 12px text) with `chat.incognitoArmTitle` bold and
`chat.incognitoArmBody` below; the tooltip is the one place the one-way rule is spelled out before the
tap. Keyboard reachable, 44px hit area on coarse pointers.

Add — phone (`src/lib/components/layout/Header.svelte`, the 52px `lg:hidden` bar): the same mask button
(44px `hbtn`) between the wordmark and the account-menu button, same visibility rule (landing route, no
message sent yet). Once a message has been sent the slot is empty (keep a 44px spacer, and side columns
of equal width, so the wordmark stays centred). In an **incognito** conversation the header's centre shows a 16px mask glyph (muted colour,
`aria-label` = `sidebar.incognitoMark`) before the conversation title.

Tapping the button: arms incognito locally (the `MessageInput` state that exists today), the button fades
out (`reducedMotionAware`), and the landing enters incognito mode (§3). A conversation that does not
exist yet is created with `memoryIncognito: true` when it is first needed (first send / attach / draft),
never before; one that already exists — the draft's own, message-less — is armed with the §1 PATCH.

## 3. Landing in incognito mode (after the tap, before the first message)

- Stage tint (§4) applied; sidebar untouched.
- Greeting: the `h1.home-greeting` shows one of the incognito greetings (§6), italic, in the serif face,
  colour `--text-primary` slightly softened (mockup: `#2a2a28` light). Picked once per mount with
  `Math.random()`; stable for the life of the page (no re-roll on reactive updates); a fresh landing gets a
  fresh one.
- `HomeWeeklyBars` hidden. The whole `.home-board` (suggestion rail, recent, tool-health strip) hidden.
  Only greeting + composer remain, vertically centred as today.
- Composer: placeholder stays `chat.incognitoPlaceholder` / `…Short` (existing); the border becomes a
  1px **dashed** hairline (`--border-strong`-ish, mockup `#b9bab7` light / `#3f4247` dark); the box
  background uses the tinted panel colour (§4); the mask face appears in the action row, right of the
  model chip group, left of Send (existing `incognito-face`, now `border: 1px dashed var(--accent)`,
  transparent background, accent glyph; 34px desktop / 44px phone).

## 4. The ambient tint (the primary cue — no notice row anywhere)

A class on the chat stage root (e.g. `.stage--incognito`, applied on the landing page when armed and on
`chat/[conversationId]` when the conversation is incognito) that overrides the surface tokens **for the
stage only** (sidebar keeps the warm palette, so the contrast is always on screen):

| token              | light normal | light incognito | dark normal | dark incognito |
|--------------------|--------------|-----------------|-------------|----------------|
| `--surface-page`   | `#fafaf8`    | `#ebecea`       | `#1a1a1a`   | `#111214`      |
| `--surface-elevated` (composer panel) | `#f4f3ee`/white | `#f3f4f2` | `#242424` | `#1a1c1f` |
| user bubble        | `#efeee9`    | `#e2e3e0`       | (current)   | `#24272b`      |
| hairlines          | `--border-default` | `#c3c4c1` dashed | (current) | `#3a3d41` dashed |

Put the incognito values in `src/app.css` as tokens (`--incognito-surface-page` …) with `.dark`
variants; the stage class swaps them in. Transition `background-color var(--duration-standard)
var(--ease-out)`; the global reduced-motion reset already zeroes it. Verify text contrast stays ≥ 4.5:1
on the tinted surfaces (muted text `#7a7974` on `#ebecea` passes; check the dark pair).

## 5. In an incognito conversation

- Stage tint on; composer dashed; mask face present; placeholder as today; sidebar row mask mark as today.
- **Opening mark**: the first element of the message list, before the first message, a single row:
  dashed hairline — 16px mask glyph — `chat.incognitoOpening` — dashed hairline; 12px muted text,
  `data-testid="incognito-opening"`. It is part of the scrolling thread (scrolls away), not sticky, not a
  banner. Rendered for every incognito conversation (new or reopened), never for normal ones.
- **Popover** (`IncognitoPopover.svelte`, opened by the face; 292px desktop card / phone bottom sheet as
  today): title row with accent mask glyph + `chat.incognitoOn`; body `chat.incognitoPopoverBody` (new
  copy, §6); a footer row separated by a hairline: left `chat.incognitoNewChatHint` (12px muted), right a
  dark pill button `chat.incognitoNewChat` (`+` glyph) that runs the existing "new chat" navigation. **No
  switch.** Escape / outside click / focus-return behaviour unchanged.
- Removing the toggle from the "+" menu means `mobile-design.spec.ts` and `composer-bar.test.ts` /
  `ComposerToolsMenu.test.ts` assertions about the switches section change to "only Thinking".

## 6. Strings (EN + HU; keys in `src/lib/i18n/chat.ts` unless noted)

Keep (unchanged): `chat.incognitoOn`, `chat.incognitoPlaceholder`, `chat.incognitoPlaceholderShort`,
`sidebar.incognitoMark`. Remove: `chat.incognitoToggle`, `composerMenu.incognito` (and their HU).

New:
- `chat.incognitoArm` (aria) — EN "Start this chat in incognito" · HU "Inkognitó beszélgetés indítása"
- `chat.incognitoArmTitle` — EN "Incognito for this chat" · HU "Inkognitó ehhez a beszélgetéshez"
- `chat.incognitoArmBody` — EN "Nothing here is remembered. Can't be undone — start a new chat to be
  remembered again." · HU "Itt semmi nem marad meg. Nem vonható vissza — új beszélgetést kell indítani, ha
  újra megjegyezhető legyen."
- `chat.incognitoOpening` — EN "Off the record from here" · HU "Innentől semmi nem marad meg"
- `chat.incognitoPopoverBody` (replace) — EN "Nothing in this chat is remembered or counted. It stays that
  way for the whole conversation." · HU "Ebből a beszélgetésből semmi nem marad meg, és nem is számít
  bele semmibe. Ez az egész beszélgetésre így marad."
- `chat.incognitoNewChatHint` — EN "To be remembered again" · HU "Ha újra megjegyezhető legyen"
- `chat.incognitoNewChat` — EN "New chat" · HU "Új beszélgetés" (reuse the existing sidebar key if one
  exists with this exact copy)
- `chat.incognitoGreetings` — an array (EN and HU, same length, index-aligned). Randomly picked (§3).

EN greetings (21):
1. Off the record.
2. Nothing here sticks.
3. Just between us.
4. No notes taken.
5. This one doesn't count.
6. Unlisted.
7. Not for the record.
8. Nobody's counting.
9. Blank slate.
10. Not in the books.
11. This room forgets.
12. Off the books.
13. Unremembered, by design.
14. No lessons learned here.
15. Nothing learned from this.
16. Memory's off.
17. Quiet room.
18. Strictly unofficial.
19. Fresh every time.
20. Untracked.
21. Nothing to remember.

HU greetings (21, same order; polish wording if a native phrasing is better, keep the meaning and never
imply deletion):
1. Jegyzőkönyvön kívül.
2. Itt semmi nem ragad meg.
3. Csak köztünk.
4. Jegyzet nélkül.
5. Ez nem számít.
6. Listán kívül.
7. Nem kerül jegyzőkönyvbe.
8. Senki sem számol.
9. Tiszta lap.
10. Nincs a könyvekben.
11. Ez a szoba felejt.
12. Könyveken kívül.
13. Szándékosan nem jegyzi meg.
14. Innen nincs tanulság.
15. Ebből nem tanul.
16. Memória kikapcsolva.
17. Csendes szoba.
18. Szigorúan nem hivatalos.
19. Minden alkalommal újra.
20. Nem követett.
21. Nincs mit megjegyezni.

`src/lib/i18n/legal.ts`: if the privacy text describes switching incognito on/off, reword to "Incognito
is chosen when a chat is started and cannot be switched off for that chat"; otherwise leave it.
`docs/` (search for "incognito"): update any description of the toggle.

## 7. Tests

- Unit: `MessageInput.test.ts` (face, placeholder, popover without switch, no toggle in menu),
  `ComposerToolsMenu.test.ts`, `composer-bar.test.ts` (switch section = Thinking only), `IncognitoPopover`
  (no switch; New chat button), landing page test for the arm button visibility rule + greeting pick,
  `Header` phone button rule, API tests (§1), i18n key-parity test (EN/HU arrays same length).
- E2E `tests/e2e/incognito-indicator.spec.ts` rewritten around the new flow: arm on landing → button gone →
  tint class + dashed composer + random greeting from the list → send → conversation created incognito
  (sidebar mark, opening mark, face, popover with no switch, New chat button navigates) → reload keeps it →
  "+" menu has no incognito switch → PATCH false via `page.request` returns 409. Phone project: header
  button, 44px face, bottom sheet. Keep `zz-capture-incognito.spec.ts` in step (env-gated).
- Playwright: `PATH=/opt/homebrew/opt/node@22/bin:$PATH` and a freshly migrated
  `DATABASE_PATH=data/playwright-e2e-chat.db npx tsx scripts/prepare-db.ts` first.
- Full gates before reporting: `vitest run` (11,649 passing today, 0 failures), `svelte-check` 0 errors,
  tsc (only the 8 known errors in `CampaignModal.test.ts` and `DialogShell.test.ts`), `vite build`,
  Playwright.

## Non-goals

No change to containment logic, storage, memory pipeline, analytics exclusion, or the sidebar row mark.
No admin setting. No re-styling of normal conversations.
