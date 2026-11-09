# Feature Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An optional page, "What AlfyAI can do", opened from a "?" beside the sidebar's version badge, that lists the app's 30 headline features in six sections. Each section has a realistic drawing, and each row has Try it, Show me or neither.

**Architecture:** Everything is client-side and lives in code: a typed entry list, a `guide.*` dictionary, and a route at `src/routes/(app)/guide/`. The drawings are composed from a shared kit of drawn parts in `src/lib/components/drawings/`. Try it hands its example to Home through `conversation-session.ts`. Show me sets an in-memory spotlight request, and the component that owns the real control takes it, opens whatever has to open, and rings the control. The campaign allow-list becomes a view of one list of in-app places, and its values do not change.

**Tech Stack:** SvelteKit 2, Svelte 5 runes, TypeScript, Tailwind with the CSS tokens in `src/app.css`, `@lucide/svelte` 1.17, Vitest (jsdom, `@testing-library/svelte`), Playwright.

**Spec:** [`docs/plans/feature-guide/design.md`](./design.md), approved 2026-11-06. Read it before any task. [`mockups.html`](./mockups.html) is the approved look; [`inventory.md`](./inventory.md) is where the content came from.

**Line numbers** (`file.svelte:123`) were read at `244c9c028`. The code may have moved a few lines since, so find each place by the name, test id or class given next to the number.

## Global Constraints

- Svelte 5 runes only: `$props()`, `$state`, event attributes (`onclick`), snippets. No `on:` directive, `<slot>` or `createEventDispatcher`.
- Icons come from `@lucide/svelte` only, imported by name. The "?" is `CircleQuestionMark`; `CircleHelp` is a deprecated alias, so don't use it. A drawing is an illustration: it may arrange Lucide icons and simple shapes, but it never hand-draws an icon `<svg>`.
- Colours, radii, durations and type come from the tokens in `src/app.css`. No hex values in components.
- Every word on the guide page lives in `src/lib/i18n/guide.ts` under `guide.*`, in English and Hungarian. Hungarian is short and natural and fits a 360 px row. A drawing's words reuse the real controls' existing keys and never get keys of their own. No value in either language may contain "artifact" or "artefakt" (`src/lib/i18n/artifacts.test.ts` enforces this). Keys match `[\w.]+`: no hyphens.
- No server, schema, migration or API change. No per-person state, no analytics. The guide never opens by itself and never mentions an admin feature.
- The page title is the only serif on the page. It is drawn in `src/routes/(app)/guide/+page.svelte` itself.
- No new raw `sessionStorage` key anywhere except `src/lib/client/conversation-session.ts`.
- The campaign allow-list keeps exactly these values, in this order: `/`, `/chat`, `/knowledge`, `/settings`, `/settings/profile`, `/settings/admin`, `internal:chatgpt-import`. Campaign and feature-note buttons get no Show me.
- NEW shows for 30 days after an entry's `added` date. "Alfy asks first" was added on `2026-11-05`; every other entry has `BEFORE_THE_GUIDE` (`2026-09-01`).
- A Show me ring lasts 2000 ms. The request lives in memory, expires after 6000 ms, and is taken once; it is never put in the URL. Under reduced motion the scroll is `"auto"` and nothing animates.
- `npm run check` must report 0 errors and 0 warnings, and `npm run build` zero warnings. Biome must be clean. Fallow must show no new finding, so every new export needs a user.
- Commit once per task. End each commit message with your harness's attribution line. Never push.
- Never run `npm run check` or `npm test` while `npm run build` runs.

## Review Focus

1. **A person with an unsent Home draft presses Try it.** Their draft stays and the example is not added. A toast says so. Owned by Task 3, test "keeps an unsent Home draft and says the example was not added".
2. **Show me for a control that isn't on screen yet.** This covers the closed "+" menu, the closed phone drawer, the collapsed sidebar, Settings' Connections tab and Knowledge's Memory tab. The owner opens what has to open and the ring lands. If the control never appears (Atlas not configured, skills switched off), nothing rings later by surprise. Owned by Task 4 (expiry), Tasks 8 and 9 (openers), and Task 11 (every Show me, end to end).
3. **Back or reload after Show me.** There is no second ring, because the request was taken once and lives only in memory. Owned by Task 4, tests "takes a live request once" and "lets a request lapse after six seconds".
4. **Hungarian at 360 px.** Long Hungarian names and lines wrap, and the drawing labels ("Fájl csatolása", "A Könyvtáradból", "Visszavonom") fit inside their drawing. Neither the page nor any drawing scrolls sideways. Owned by Task 11, tests "Hungarian at 360 px holds together" and "English at 390 px holds together".
5. **Keyboard and touch.** Tabbing onto a row lights its spot. On a phone, tapping a row lights it while its drawing stays in view. Owned by Task 6, test "lights a row's spot on hover, on focus and on tap", and Task 11, tests "Keyboard", "Hungarian at 360 px holds together" and "English at 390 px holds together" (each checks a tap lights the spot in view).

---

### Task 1: One list of places in the app

**Files:**
- Create: `src/lib/app-places.ts`, `src/lib/app-places.test.ts`, `src/lib/campaign-action-destinations.test.ts`
- Modify: `src/lib/campaign-action-destinations.ts:14-21` (`ALLOWED_ACTION_PATHS` becomes `CAMPAIGN_ACTION_PATHS`)

**Interfaces:**
- Produces (in `src/lib/app-places.ts`, imported by server and browser code alike, so it must stay free of browser APIs):
  - `type AppPlaceId = "home" | "chat" | "knowledge" | "knowledgeMemory" | "settings" | "settingsProfile" | "settingsAdmin" | "guide"`
  - `const APP_PLACES: Readonly<Record<AppPlaceId, { path: string; campaign: boolean }>>`
  - `function appPlacePath(id: AppPlaceId): string`
  - `const CAMPAIGN_ACTION_PATHS: readonly string[]`: the paths with `campaign: true`, in `APP_PLACES` order
  - `const SPOTLIGHT_IDS = ["composer.thinking", "composer.attach", "composer.library", "composer.atlas", "home.incognito", "home.home", "sidebar.search", "sidebar.projects", "knowledge.library", "knowledge.memory", "settings.instructions", "settings.style", "settings.language", "settings.skills", "settings.twoStep", "settings.data", "settings.activity", "settings.connections"] as const`
  - `type SpotlightId = (typeof SPOTLIGHT_IDS)[number]`

The places, in this order:

| Id | Path | Campaign |
|---|---|---|
| `home` | `/` | yes |
| `chat` | `/chat` | yes |
| `knowledge` | `/knowledge` | yes |
| `knowledgeMemory` | `/knowledge?tab=memory` | no |
| `settings` | `/settings` | yes |
| `settingsProfile` | `/settings/profile` | yes |
| `settingsAdmin` | `/settings/admin` | yes |
| `guide` | `/guide` | no |

`settingsProfile` and `settingsAdmin` get a one-line comment. They have no route (inventory section 4, item 4), and they stay because published campaign snapshots store these strings.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/campaign-action-destinations.test.ts
it("keeps the campaign allow-list exactly as published campaigns know it", () => {
	expect(ALLOWED_ACTION_DESTINATIONS).toEqual(["/", "/chat", "/knowledge", "/settings", "/settings/profile", "/settings/admin", "internal:chatgpt-import"]);
});
it("never offers a guide-only place to a campaign", () => {
	expect(isAllowedActionDestination("/guide")).toBe(false);
});
// src/lib/app-places.test.ts
it("gives every place one same-origin path", () => {
	for (const { path } of Object.values(APP_PLACES)) expect(path.startsWith("/") && !path.startsWith("//")).toBe(true);
});
it("derives the campaign paths from the places marked for campaigns", () => {
	expect(CAMPAIGN_ACTION_PATHS).toEqual(["/", "/chat", "/knowledge", "/settings", "/settings/profile", "/settings/admin"]);
});
it("names eighteen distinct spotlight ids as area.control", () => {
	expect(new Set(SPOTLIGHT_IDS).size).toBe(18);
	for (const id of SPOTLIGHT_IDS) expect(id).toMatch(/^[a-z]+\.[a-zA-Z]+$/);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/app-places.test.ts src/lib/campaign-action-destinations.test.ts`
Expected: FAIL, because `$lib/app-places` does not exist.

- [ ] **Step 3: Write `src/lib/app-places.ts`, then build `ALLOWED_ACTION_PATHS` from `CAMPAIGN_ACTION_PATHS` in `campaign-action-destinations.ts`.** Leave every other line of that file alone.

- [ ] **Step 4: Run the new tests plus every existing reader of the allow-list**

Run: `npx vitest run src/lib/app-places.test.ts src/lib/campaign-action-destinations.test.ts src/lib/server/services/announcement-campaigns.test.ts src/lib/server/services/announcement-campaigns.audience.test.ts "src/routes/(app)/settings/_components/campaigns" src/lib/components/campaigns scripts/create-release-campaign.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**: `git add src/lib/app-places.ts src/lib/app-places.test.ts src/lib/campaign-action-destinations.ts src/lib/campaign-action-destinations.test.ts && git commit -m "Keep the app's places in one list, and derive the campaign allow-list from it"`

---

### Task 2: The guide's content and its words

**Files:**
- Create: `src/lib/components/guide/guide-content.ts`, `src/lib/components/guide/guide-content.test.ts`, `src/lib/i18n/guide.ts`
- Modify: `src/lib/i18n/index.ts` (import `guideDict`, add `...guideDict.en` and `...guideDict.hu`), `src/lib/i18n.test-helpers.ts` (add `"guide."` to `AUDITED_PREFIXES`; without this, the parity check skips the guide), `AGENTS.md` (Core Rules), `CONTEXT.md` (User Onboarding)

**Interfaces:**
- Consumes: `AppPlaceId`, `SpotlightId` (Task 1).
- Produces (in `guide-content.ts`):
  - `const GUIDE_SECTION_IDS = ["ask", "make", "knowsYou", "yourThings", "organized", "account"] as const` and `type GuideSectionId`
  - `type GuideAction = { kind: "tryIt" } | { kind: "showMe"; place: AppPlaceId | null; spotlight: SpotlightId } | { kind: "none" }`. A `place` of `null` means "stay on this page"; the sidebar is on every page.
  - `interface GuideEntry { id: string; section: GuideSectionId; drawingSpot: string | null; action: GuideAction; added: string }`
  - `const GUIDE_ENTRIES: readonly GuideEntry[]`, `const GUIDE_NEW_FOR_DAYS = 30`, `const BEFORE_THE_GUIDE = "2026-09-01"`
  - `function isGuideEntryNew(added: string, now: Date): boolean`: true when `0 <= now - added < 30 days`, with `added` read as UTC midnight
  - `function guideEntriesFor(section: GuideSectionId): readonly GuideEntry[]`
  - `function guideSectionKey(section: GuideSectionId, field: "name" | "intro"): I18nKey` builds `guide.section.<section>.<field>`
  - `function guideEntryKey(id: string, field: "name" | "line" | "example"): I18nKey` builds `guide.entry.<id>.<field>`
- `guide.ts` has the shape of `projects.ts`: `const guideDict = { en: {…}, hu: {…} } as const; export default guideDict;`

The entries, in order. Every `added` is `BEFORE_THE_GUIDE` except `asksFirst`. The English copy for each name, line and example is section 4 of the design, word for word. Write the Hungarian copy yourself, under the Global Constraints rule.

| Section | Id | Drawing spot | Action |
|---|---|---|---|
| ask | `askAnything` | `thinking` | showMe `home` `composer.thinking` |
| ask | `webAndLinks` | `sources` | tryIt |
| ask | `pictureOrFile` | `attach` | showMe `home` `composer.attach` |
| ask | `mapsAndTravel` | null | tryIt |
| ask | `atlasResearch` | `atlas` | showMe `home` `composer.atlas` |
| ask | `steerAReply` | `replyActions` | none |
| ask | `asksFirst` (added `2026-11-05`) | null | tryIt |
| make | `documents` | `document` | tryIt |
| make | `apps` | null | tryIt |
| make | `canvases` | null | tryIt |
| make | `pictures` | `picture` | tryIt |
| make | `files` | `download` | tryIt |
| make | `history` | `history` | none |
| knowsYou | `memory` | `memory` | showMe `knowledgeMemory` `knowledge.memory` |
| knowsYou | `instructions` | `instructions` | showMe `settings` `settings.instructions` |
| knowsYou | `styleAndModel` | `style` | showMe `settings` `settings.style` |
| knowsYou | `skills` | `skills` | showMe `settings` `settings.skills` |
| yourThings | `knowledgeBase` | `library` | showMe `knowledge` `knowledge.library` |
| yourThings | `useADocument` | `fromLibrary` | showMe `home` `composer.library` |
| yourThings | `connectedAccounts` | `connections` | showMe `settings` `settings.connections` |
| yourThings | `yourOk` | `okCard` | none |
| organized | `projects` | `projects` | showMe `null` `sidebar.projects` |
| organized | `search` | `search` | showMe `null` `sidebar.search` |
| organized | `tidySidebar` | `sidebarList` | none |
| organized | `incognito` | `incognito` | showMe `home` `home.incognito` |
| organized | `home` | `home` | showMe `home` `home.home` |
| account | `languageAndLook` | `language` | showMe `settings` `settings.language` |
| account | `twoStep` | `twoStep` | showMe `settings` `settings.twoStep` |
| account | `yourData` | `data` | showMe `settings` `settings.data` |
| account | `yourActivity` | `activity` | showMe `settings` `settings.activity` |

The page's own words, with English fixed. Hungarian drafts are given where the design has one.

| Key | English | Hungarian |
|---|---|---|
| `guide.title` | What AlfyAI can do | Amit az AlfyAI tud |
| `guide.subtitle` | A map of everything here. Try it starts a chat with an example you can change before sending. | (yours) |
| `guide.section.<id>.name` / `.intro` | design section 4, first table | names as drafted there |
| `guide.sectionsLabel` | Sections | (yours) |
| `guide.tryIt` / `guide.tryItA11y` | Try it / Try it: {name} | (yours) |
| `guide.showMe` / `guide.showMeA11y` | Show me / Show me: {name} | (yours) |
| `guide.new` | NEW | ÚJ |
| `guide.tryItDraftKept` | Your unsent message is still in the box, so the example was not added. | (yours) |
| `guide.shortcuts.title` | Shortcuts and commands | (yours) |
| `guide.shortcuts.search` / `.focus` / `.send` / `.newLine` / `.close` | Open Search / Go to the message box / Send / New line / Close a menu or dialog | (yours) |
| `guide.shortcuts.commandsLead` | Type / in the message box for these: | (yours) |

- [ ] **Step 1: Write the failing tests** in `guide-content.test.ts`:

```ts
it("has six sections in the approved order", () => {
	expect(GUIDE_SECTION_IDS).toEqual(["ask", "make", "knowsYou", "yourThings", "organized", "account"]);
});
it("has thirty entries with unique ids, 7/6/4/4/5/4 per section", () => {
	expect(new Set(GUIDE_ENTRIES.map((e) => e.id)).size).toBe(30);
	expect(GUIDE_SECTION_IDS.map((s) => guideEntriesFor(s).length)).toEqual([7, 6, 4, 4, 5, 4]);
});
it("gives every entry a name and a line, and every Try it an example, in both languages", () => {
	for (const e of GUIDE_ENTRIES) for (const lang of ["en", "hu"] as const) {
		expect(guideDict[lang][guideEntryKey(e.id, "name")]).toBeTruthy();
		expect(guideDict[lang][guideEntryKey(e.id, "line")]).toBeTruthy();
		if (e.action.kind === "tryIt") expect(guideDict[lang][guideEntryKey(e.id, "example")]).toBeTruthy();
	}
});
it("points every Show me at a known place and spotlight, each spotlight used once", () => {
	const shows = GUIDE_ENTRIES.flatMap((e) => (e.action.kind === "showMe" ? [e.action] : []));
	expect(shows.map((a) => a.spotlight).sort()).toEqual([...SPOTLIGHT_IDS].sort());
	for (const a of shows) if (a.place) expect(APP_PLACES[a.place]).toBeDefined();
});
it("dates only Alfy asks first after the guide's baseline", () => {
	expect(GUIDE_ENTRIES.filter((e) => e.added !== BEFORE_THE_GUIDE).map((e) => e.id)).toEqual(["asksFirst"]);
});
it("shows NEW for thirty days from the added date", () => {
	expect(isGuideEntryNew("2026-11-05", new Date("2026-11-05T00:00:00Z"))).toBe(true);
	expect(isGuideEntryNew("2026-11-05", new Date("2026-12-04T23:59:59Z"))).toBe(true);
	expect(isGuideEntryNew("2026-11-05", new Date("2026-12-05T00:00:00Z"))).toBe(false);
	expect(isGuideEntryNew("2026-11-05", new Date("2026-11-04T23:59:59Z"))).toBe(false);
});
```

- [ ] **Step 2: Run to see them fail**: `npx vitest run src/lib/components/guide/guide-content.test.ts`. Expected: FAIL, module missing.

- [ ] **Step 3: Write `guide-content.ts` and `guide.ts`, then register the dictionary.** Make three edits:
  - Register the dictionary in `index.ts`.
  - Add `"guide."` to `AUDITED_PREFIXES`.
  - Add one Core Rules line to `AGENTS.md`: a change that adds, removes, renames or moves a user-facing feature updates its Feature Guide entry (`src/lib/components/guide/guide-content.ts`, `src/lib/i18n/guide.ts`) in the same change, and its section's drawing when a pictured control changes; a moved control keeps its spotlight marker.

  Then add the `CONTEXT.md` entry under User Onboarding:
  - **Feature Guide**: the optional page at `/guide`, opened from the "?" beside the App Version Badge. It lists everything a person can do with AlfyAI in six sections, each with a drawing; every entry has Try it, Show me or neither. Its entry names are the features' names.
  - _Avoid_: tour, help centre, manual.

- [ ] **Step 4: Run the guide and dictionary tests**

Run: `npx vitest run src/lib/components/guide/guide-content.test.ts src/lib/i18n.test.ts src/lib/i18n/artifacts.test.ts scripts/validate-i18n.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**: `git add src/lib/components/guide src/lib/i18n/guide.ts src/lib/i18n/index.ts src/lib/i18n.test-helpers.ts AGENTS.md CONTEXT.md && git commit -m "Write the feature guide's content and words, checked in both languages"`

---

### Task 3: Try it hands its example to Home

**Files:**
- Modify: `src/lib/client/conversation-session.ts`. Add the pair next to `markProjectComposerFocus` (:325), and remove the key in `clearConversationSessionState` (:1030), which runs on sign-out.
- Modify: `src/lib/components/home/HomeSurface.svelte`, in `onMount` right after the landing-draft restore (:871-880)
- Test: `src/lib/client/conversation-session.test.ts`, `src/lib/components/home/HomeSurface.test.ts`

**Interfaces:**
- Produces: `function storeHomeComposerSeed(text: string): void` and `function consumeHomeComposerSeed(): string | null`. They are sessionStorage-backed through the module's private `getSessionStorage()`, under the key `"home-composer-seed"`; consuming removes the key.
- HomeSurface flow:
  1. On `mode.kind === "home"` only, consume the seed.
  2. Await the restore promise (`preparedConversationValidationPromise`; resolve at once if there is none).
  3. If `conversationDraft` is still `null`, set it with `createConversationDraftRecord({ conversationId: preparedConversationId, draftText: seed, selectedAttachmentIds: [], selectedAttachments: [] })` and focus the box.
  4. Otherwise keep the draft and call `showToast({ type: "success", message: get(t)("guide.tryItDraftKept") })`.
  5. Never call `requestLandingReset()`.

- [ ] **Step 1: Write the failing tests**

```ts
// conversation-session.test.ts
it("hands a Try it example to Home once", () => {
	storeHomeComposerSeed("How do I get from Keleti station to the airport by public transport?");
	expect(consumeHomeComposerSeed()).toBe("How do I get from Keleti station to the airport by public transport?");
	expect(consumeHomeComposerSeed()).toBeNull();
});
it("forgets a waiting example on sign-out", () => {
	storeHomeComposerSeed("x");
	clearConversationSessionState();
	expect(consumeHomeComposerSeed()).toBeNull();
});
// HomeSurface.test.ts, following that file's existing setup for a home mount
it("puts a waiting example in the empty Home box without sending it");     // box value === seed; no send request made
it("keeps an unsent Home draft and says the example was not added");       // restored draft "my words" stays; showToast called with guide.tryItDraftKept
it("leaves a waiting example alone on a project page");                    // mode project: seed not consumed, box empty
```

- [ ] **Step 2: Run to see them fail**: `npx vitest run src/lib/client/conversation-session.test.ts src/lib/components/home/HomeSurface.test.ts`. Expected: the new tests FAIL.

- [ ] **Step 3: Add the pair to `conversation-session.ts` and the seed step to `HomeSurface.svelte`, as described in Interfaces.**

- [ ] **Step 4: Run again**, plus `npm run check`. Expected: PASS, 0 errors and 0 warnings.

- [ ] **Step 5: Commit**: `git add src/lib/client/conversation-session.ts src/lib/client/conversation-session.test.ts src/lib/components/home/HomeSurface.svelte src/lib/components/home/HomeSurface.test.ts && git commit -m "Let Try it put an example in the Home box without sending or overwriting a draft"`

---

### Task 4: Spotlight: the request, the ring and its look

**Files:**
- Create: `src/lib/stores/spotlight.ts`, `src/lib/stores/spotlight.test.ts`, `src/lib/actions/spotlight.ts`, `src/lib/actions/spotlight.test.ts`, `src/lib/actions/spotlight.test-helpers.ts`
- Modify: `src/app.css` (the global `.spotlight-ring` rule), `src/lib/stores/AGENTS.md` (one row in the Structure table)

**Interfaces:**
- Consumes: `SpotlightId` (Task 1).
- Produces, in `src/lib/stores/spotlight.ts` (the pattern is `searchModalOpenRequested` in `ui.ts`: a writable that one owner drains):
  - `const SPOTLIGHT_REQUEST_TTL_MS = 6000`
  - `type SpotlightRequest = { spotlight: SpotlightId; expiresAt: number }`
  - `const spotlightRequest: Writable<SpotlightRequest | null>`
  - `function requestSpotlight(spotlight: SpotlightId, now = Date.now()): void`: a newer request replaces an older one
  - `function pendingSpotlight(request: SpotlightRequest | null, now = Date.now()): SpotlightId | null`
  - `function takeSpotlight(spotlight: SpotlightId, now = Date.now()): boolean`: true at most once per request, and only while it is live; clears it
- Produces, in `src/lib/actions/spotlight.ts`:
  - `const SPOTLIGHT_RING_MS = 2000`
  - `function spotlightTarget(node: HTMLElement, spotlight: SpotlightId): { update(next: SpotlightId): void; destroy(): void }`
  - The action subscribes to `spotlightRequest`. When a live request names its spotlight and the node is rendered (`node.getClientRects().length > 0`), it takes the request. On the next animation frame it calls `node.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" })` and adds `spotlight-ring` for `SPOTLIGHT_RING_MS`. `destroy` removes the class, clears the timer and unsubscribes.
  - A request made before the node mounts is taken on mount (the subscription's first value). That is how menu rows, tabs and drawers that open late still ring.
- Produces, in `spotlight.test-helpers.ts`: `function stubLayoutForSpotlight(): () => void`. jsdom has no layout, so it gives `Element.prototype.getClientRects` one rect and stubs `scrollIntoView`, and the function it returns undoes both. Tasks 8 to 10 use it.
- CSS: `.spotlight-ring { box-shadow: 0 0 0 2px var(--accent), 0 0 0 6px var(--accent-tint); transition: box-shadow var(--duration-standard); }`. This is the same look as a lit spot in a drawing.

- [ ] **Step 1: Write the failing tests**

```ts
// spotlight.test.ts (store)
it("takes a live request once", () => {
	requestSpotlight("settings.data", 1000);
	expect(takeSpotlight("settings.data", 1500)).toBe(true);
	expect(takeSpotlight("settings.data", 1600)).toBe(false);
});
it("lets a request lapse after six seconds", () => {
	requestSpotlight("composer.atlas", 0);
	expect(takeSpotlight("composer.atlas", 6001)).toBe(false);
});
it("does not hand one control's request to another", () => {
	requestSpotlight("sidebar.search", 0);
	expect(takeSpotlight("sidebar.projects", 10)).toBe(false);
	expect(takeSpotlight("sidebar.search", 10)).toBe(true);
});
// spotlight.test.ts (action), with vi.useFakeTimers() and stubLayoutForSpotlight()
it("rings a rendered target for two seconds when its request arrives"); // class added after a frame; gone after 2000 ms; scrollIntoView({ block: "center", behavior: "smooth" })
it("rings a target that mounts after the request");
it("leaves a target with no layout alone");                              // getClientRects → []: no ring, request still pending
it("scrolls without animation under reduced motion");                    // prefersReducedMotion mocked true → behavior "auto"
it("stops cleanly when destroyed mid-ring");                             // destroy at 500 ms → class gone, no timer left
```

- [ ] **Step 2: Run to see them fail**: `npx vitest run src/lib/stores/spotlight.test.ts src/lib/actions/spotlight.test.ts`. Expected: FAIL, modules missing.

- [ ] **Step 3: Write the store, the action, the test helper and the CSS rule.**

- [ ] **Step 4: Run again.** Expected: PASS.

- [ ] **Step 5: Commit**: `git add src/lib/stores/spotlight.ts src/lib/stores/spotlight.test.ts src/lib/actions/spotlight* src/app.css src/lib/stores/AGENTS.md && git commit -m "Add one spotlight: a request held in memory that the owning control takes and rings"`

---

### Task 5: The drawing kit, and the Ask and Make drawings

**Files:**
- Create the kit in `src/lib/components/drawings/`: `AGENTS.md`, `DrawingFrame.svelte`, `DrawnBar.svelte`, `DrawnUserMessage.svelte`, `DrawnReply.svelte`, `DrawnComposer.svelte`, `DrawnMenu.svelte`, `DrawnPanel.svelte`, `DrawnChatCard.svelte`, `drawing-spot.ts`
- Create the guide's drawings in `src/lib/components/guide/drawings/`: `AskDrawing.svelte`, `MakeDrawing.svelte`, `SectionDrawing.svelte`, `section-drawing-spots.ts`, `drawings.test.ts`
- Modify: `AGENTS.md` Folder Rules (add `src/lib/components/drawings/`: the drawing kit and its rules)

**Interfaces:**
- Consumes: `GuideSectionId`, `GUIDE_ENTRIES` (Task 2).
- Produces:
  - `drawing-spot.ts`: `function isLit(spot: string, lit: string | null | undefined): boolean`. Every kit part takes `lit?: string | null`. It marks each spot element with `data-drawing-spot="<id>"`, adding the class `drawing-spot-lit` when `isLit`.
  - `DrawingFrame.svelte`: props `{ children: Snippet }`. It renders an `aria-hidden="true"` box on `--surface-elevated` with the token border and radius. It draws at a fixed design size (330 by 222 CSS px) scaled to the container's width, so the drawing keeps its proportions at any width.
  - `section-drawing-spots.ts`: `const SECTION_DRAWING_SPOTS: Readonly<Record<GuideSectionId, readonly string[]>>`, with these values:
    - ask: `thinking`, `sources`, `attach`, `atlas`, `replyActions`
    - make: `document`, `picture`, `download`, `history`
    - knowsYou: `memory`, `instructions`, `style`, `skills`
    - yourThings: `library`, `fromLibrary`, `connections`, `okCard`
    - organized: `search`, `projects`, `sidebarList`, `incognito`, `home`
    - account: `language`, `twoStep`, `data`, `activity`
  - `SectionDrawing.svelte`: props `{ section: GuideSectionId; lit: string | null }`. It renders the section's drawing; until Task 7, the four undrawn sections get an empty `DrawingFrame`.
- What the two drawings show: section 3.3 of the design and `mockups.html`, built from the kit's parts.
  - **Ask:**
    - The reply's Sources row is labelled with `messageEvidenceDetails.sourcesLabel`; its action icons copy the real reply's icons.
    - The open "+" menu rows are:
      - Attach file: `composerTools.attachFile`, `Paperclip`
      - From your Library: `composerTools.fromLibrary`, `Library`
      - Atlas report: `composerMenu.atlasReport`, `Orbit`
      - Skills: `composerMenu.skills`, `Sparkles`
    - The composer bar has `Plus`, `Plug`, `Brain` and the send button.
  - **Make:**
    - The panel header has the way back (`artifacts.panel.crumb`), `Clock` and `Download`.
    - Alfy's change has the Keep / Undo pill (`artifacts.document.review.keepShort`, `artifacts.document.review.undoShort`).
    - The chat shows a Document card and a Picture card.
  - Message text is grey `DrawnBar`s. Take each icon and key from the real control's component; never add a key.
- The lit look is `.drawing-spot-lit`, the same box-shadow as `.spotlight-ring` (Task 4).

- [ ] **Step 1: Write the failing tests** in `drawings.test.ts`:

```ts
it.each(["ask", "make"] as const)("draws every spot the %s section names", (section) => {
	const { container } = render(SectionDrawing, { props: { section, lit: null } });
	const drawn = [...container.querySelectorAll<HTMLElement>("[data-drawing-spot]")].map((n) => n.dataset.drawingSpot);
	expect(new Set(drawn)).toEqual(new Set(SECTION_DRAWING_SPOTS[section]));
});
it("lights only the named spot", () => {
	const { container } = render(SectionDrawing, { props: { section: "ask", lit: "atlas" } });
	expect([...container.querySelectorAll(".drawing-spot-lit")].map((n) => (n as HTMLElement).dataset.drawingSpot)).toEqual(["atlas"]);
});
it("takes its words from the real controls' keys, in the reader's language", () => {
	uiLanguage.set("hu");
	render(SectionDrawing, { props: { section: "ask", lit: null } });
	expect(screen.getByText(get(t)("composerTools.attachFile"))).toBeInTheDocument();
});
it("is hidden from screen readers", () => {
	const { container } = render(SectionDrawing, { props: { section: "make", lit: null } });
	expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
});
it("names only spots its section's drawing has", () => {
	for (const e of GUIDE_ENTRIES) if (e.drawingSpot) expect(SECTION_DRAWING_SPOTS[e.section]).toContain(e.drawingSpot);
});
```

- [ ] **Step 2: Run to see them fail**: `npx vitest run src/lib/components/guide/drawings/drawings.test.ts`. Expected: FAIL.

- [ ] **Step 3: Build the kit's parts and the two drawings.** The kit's `AGENTS.md` says three things:
  - What the kit is for: realistic drawings of real screens, also meant for campaign pictures later. Point to design section 9.
  - The rules: words from the real controls' keys, icons from Lucide, tokens only, `aria-hidden`, spots marked with `data-drawing-spot`.
  - That a drawing must follow its control when the control changes.

- [ ] **Step 4: Run again**, plus `npm run check`. Expected: PASS, 0 and 0.

- [ ] **Step 5: Commit**: `git add src/lib/components/drawings src/lib/components/guide/drawings AGENTS.md && git commit -m "Add the drawing kit and the guide's Ask and Make drawings"`

---

### Task 6: The guide page

**Files:**
- Create: `src/routes/(app)/guide/+page.svelte`. There is no `+page.server.ts`: sign-in is already required for every page in `(app)` (`src/hooks.server.ts:350`).
- Create in `src/lib/components/guide/`: `GuidePage.svelte`, `GuideSection.svelte`, `GuideRow.svelte`, `GuideShortcuts.svelte`, `guide-actions.ts`, `guide-actions.test.ts`, `GuidePage.test.ts`, `AGENTS.md`
- Modify: `tests/integration/serif-conventions.test.ts` (`MAY_NAME_THE_SERIF`: add `"src/routes/(app)/guide/+page.svelte": { sets: "the Feature Guide page title", ways: ["class"] }`), `AGENTS.md` Folder Rules (add `src/lib/components/guide/`: the Feature Guide page, its content, its drawings and the spotlight markers' rules), `src/lib/components/AGENTS.md` (Page-to-Component Usage: a "Guide" entry)

**Interfaces:**
- Consumes: Tasks 1 to 5. Also `STATIC_COMPOSER_COMMANDS` from `src/lib/composer-commands.ts`, whose items have the fields `token`, `descriptionKey` and `availability`.
- Produces (`guide-actions.ts`):
  - `async function tryGuideExample(example: string): Promise<void>`: `storeHomeComposerSeed(example)`, then `goto(appPlacePath("home"))`
  - `async function showGuidePlace(action: Extract<GuideAction, { kind: "showMe" }>): Promise<void>`: `requestSpotlight(action.spotlight)`, then `goto(appPlacePath(action.place))` when `place` is not `null`
- The route copies the Knowledge page's frame:
  - a root `flex h-full min-h-0 flex-col overflow-hidden bg-surface-page`
  - a scroller `main-content flex flex-1 flex-col overflow-y-auto`
  - a column `mx-auto … max-w-[calc(65rem+2*var(--column-pad))] … px-(--column-pad) py-6`
  - `<svelte:head><title>{$t("guide.title")}</title></svelte:head>`
  - `<h1 class="page-title font-serif text-text-primary">`
  - then `<GuidePage />`
- `GuidePage`: the subtitle, then a `nav` of six chips (anchors to `#guide-section-<id>`; a click scrolls with the reduced-motion rule), the six `GuideSection`s and `GuideShortcuts`.
- `GuideSection`: `<section id="guide-section-<id>" aria-labelledby>`. On a wide screen it is two columns: on the left the name (`h2`), the intro and `SectionDrawing`; on the right the rows. It holds `let lit = $state<string | null>(null)`. Under 768 px the band stacks, and the drawing is `position: sticky; top: 0` inside its band, so it stays in view while that band's rows scroll.
- `GuideRow`: props `{ entry: GuideEntry; now: Date; onLight: (spot: string | null) => void }`. It shows the name, NEW when `isGuideEntryNew(entry.added, now)`, the line, and the action button:
  - "Try it": its accessible name is `guide.tryItA11y` with `{name}`, and it calls `tryGuideExample` with the example in the reader's language.
  - "Show me": named with `guide.showMeA11y`, and it calls `showGuidePlace`.
  - No button for `none`.

  The row lights its spot on `pointerenter`, `focusin` and a click on the row's body (a tap). It clears it on `pointerleave` and `focusout`.
- `GuideShortcuts`: the keys Ctrl/⌘+K, `/`, Ctrl/⌘+Enter, Enter and Esc, each with its `guide.shortcuts.*` description, then every `"available"` command as its `token` and `$t(descriptionKey)`.

- [ ] **Step 1: Write the failing tests** (mock `$app/navigation` `goto` and `$app/state` as `Sidebar.test.ts` and `src/routes/login/login-page.test.ts` do):

```ts
// GuidePage.test.ts
it("shows six sections and thirty rows");
it("marks Alfy asks first NEW during its first thirty days", () => { vi.setSystemTime(new Date("2026-11-10T12:00:00Z")); /* exactly one NEW, in the Alfy asks first row */ });
it("lights a row's spot on hover, on focus and on tap, and clears it on leave"); // Web and links → [data-drawing-spot="sources"] gets drawing-spot-lit
it("names its buttons after their entry");          // getByRole("button", { name: "Try it: Maps and travel" })
it("gives rows without an action no button");       // the Steer a reply row has no button
it("lists every available slash command");          // each STATIC_COMPOSER_COMMANDS token is on the page
// guide-actions.test.ts
it("Try it hands the example to Home and goes there", async () => {
	await tryGuideExample("How do I get from Keleti station to the airport by public transport?");
	expect(consumeHomeComposerSeed()).toBe("How do I get from Keleti station to the airport by public transport?");
	expect(goto).toHaveBeenCalledWith("/");
});
it("Show me asks for the control and goes to its place", async () => {
	await showGuidePlace({ kind: "showMe", place: "settings", spotlight: "settings.twoStep" });
	expect(get(spotlightRequest)?.spotlight).toBe("settings.twoStep");
	expect(goto).toHaveBeenCalledWith("/settings");
});
it("Show me for a sidebar control stays on the page", async () => {
	await showGuidePlace({ kind: "showMe", place: null, spotlight: "sidebar.search" });
	expect(goto).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to see them fail**: `npx vitest run src/lib/components/guide tests/integration/serif-conventions.test.ts`. Expected: the new tests FAIL. The serif test fails too, until the route file exists.

- [ ] **Step 3: Build the route, the four components and `guide-actions.ts`, and write the guide's `AGENTS.md`.** The `AGENTS.md` covers four things:
  - Where the content and words live.
  - The rule that every Show me spotlight has a marker on its real control (Tasks 8 and 9) and a line in the end-to-end spec.
  - The NEW rule.
  - The rule that the guide never shows admin features.

- [ ] **Step 4: Run again**, plus `npm run check`. Expected: PASS, 0 and 0.

- [ ] **Step 5: Commit**: `git add "src/routes/(app)/guide" src/lib/components/guide tests/integration/serif-conventions.test.ts AGENTS.md src/lib/components/AGENTS.md && git commit -m "Add the feature guide page: six sections, Try it, Show me and the shortcuts box"`

---

### Task 7: The other four drawings

**Files:**
- Create: `src/lib/components/guide/drawings/KnowsYouDrawing.svelte`, `YourThingsDrawing.svelte`, `OrganizedDrawing.svelte`, `AccountDrawing.svelte`, plus whatever kit parts they need in `src/lib/components/drawings/` (a sidebar, a settings row, a switch, a list row)
- Modify: `src/lib/components/guide/drawings/SectionDrawing.svelte` (all six), `drawings.test.ts` (extend the `it.each` to all six sections)

**Interfaces:**
- Consumes: the kit and `SECTION_DRAWING_SPOTS` (Task 5).
- What each drawing shows is the table in section 3.3 of the design. Each label is the key the real control renders: find it in that control's component and never write a new one. For example: `memory.title`, `knowledge.documents`, `sidebar.search`, `sidebar.projects`, `home.runningNow`, and the Settings labels from `SettingsProfileTab.svelte` and `SettingsConnectionsTab.svelte`.

- [ ] **Step 1: Extend the test** to `it.each(GUIDE_SECTION_IDS)`. Run `npx vitest run src/lib/components/guide/drawings/drawings.test.ts`. Expected: FAIL for the four new sections.
- [ ] **Step 2: Draw the four sections from the real screens**, using the kit's parts. Set the screens beside your drawing in the browser and compare.
- [ ] **Step 3: Run the test and `npm run check`.** Expected: PASS, 0 and 0.
- [ ] **Step 4: Commit**: `git add src/lib/components/drawings src/lib/components/guide/drawings && git commit -m "Draw the guide's last four sections from the real screens"`

---

### Task 8: Show me in the composer and on Home

**Files:**
- Modify: `src/lib/components/chat/composer-bar.ts` (add the menu helper), `src/lib/components/chat/MessageInput.svelte`, `src/lib/components/chat/ComposerToolsMenu.svelte`, `src/lib/components/home/HomeSurface.svelte`, `src/lib/components/layout/Header.svelte`
- Test: `src/lib/components/chat/composer-bar.test.ts`, `src/lib/components/chat/ComposerToolsMenu.test.ts`, `src/lib/components/home/HomeSurface.test.ts`, `src/lib/components/layout/Header.test.ts`

**Interfaces:**
- Consumes: `spotlightTarget`, `spotlightRequest`, `pendingSpotlight`, `stubLayoutForSpotlight` (Task 4).
- Produces (`composer-bar.ts`): `const COMPOSER_MENU_SPOTLIGHTS = ["composer.attach", "composer.library", "composer.atlas"] as const` and `function opensComposerMenu(spotlight: SpotlightId | null): boolean`.
- Markers, as `use:spotlightTarget={"…"}`:
  - The Thinking button (`data-testid="thinking-bar-toggle"`, `MessageInput.svelte:4537`): `composer.thinking`.
  - The menu rows `composer-menu-attach`, `composer-menu-library` and `composer-menu-atlas` (`ComposerToolsMenu.svelte:529`, `:547`, `:590`): `composer.attach`, `composer.library`, `composer.atlas`.
  - Home's `button[data-testid="incognito-arm"]` (`HomeSurface.svelte:1227`) and the phone's `button[data-testid="incognito-arm-phone"]` (`Header.svelte:216`) both carry `home.incognito`. Only the one with layout takes the request.
  - `div.home-band` (`HomeSurface.svelte:1275`): `home.home`.
- `MessageInput.svelte` gets an `$effect` on `$spotlightRequest`: when `opensComposerMenu(pendingSpotlight($spotlightRequest))` and the menu is closed, open it the way `toggleToolsMenu()` does (:2641). The row's marker then takes the request when the menu mounts.

- [ ] **Step 1: Write the failing tests**

```ts
// composer-bar.test.ts
it("opens the + menu only for the controls that live in it", () => {
	expect(COMPOSER_MENU_SPOTLIGHTS.every(opensComposerMenu)).toBe(true);
	expect(opensComposerMenu("composer.thinking")).toBe(false);
	expect(opensComposerMenu(null)).toBe(false);
});
// ComposerToolsMenu.test.ts, with stubLayoutForSpotlight()
it("rings the Atlas row when Show me asks for it");   // requestSpotlight("composer.atlas"); render with Atlas available; after a frame getByTestId("composer-menu-atlas") has spotlight-ring
// HomeSurface.test.ts
it("rings the incognito button when Show me asks for it");
// Header.test.ts
it("rings the phone's incognito button when Show me asks for it");
```

- [ ] **Step 2: Run to see them fail**: `npx vitest run src/lib/components/chat/composer-bar.test.ts src/lib/components/chat/ComposerToolsMenu.test.ts src/lib/components/home/HomeSurface.test.ts src/lib/components/layout/Header.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Add the helper, the markers and the effect.**
- [ ] **Step 4: Run again**, plus `npm run check`. Expected: PASS, 0 and 0.
- [ ] **Step 5: Commit**: `git add src/lib/components/chat src/lib/components/home src/lib/components/layout/Header.svelte src/lib/components/layout/Header.test.ts && git commit -m "Mark the composer's and Home's controls for Show me, opening the + menu when needed"`

---

### Task 9: Show me in the sidebar, Knowledge and Settings

**Files:**
- Modify: `src/lib/components/layout/Sidebar.svelte`, `src/lib/components/sidebar/ConversationList.svelte`, `src/lib/components/ui/PageSwitcher.svelte`, `src/routes/(app)/knowledge/+page.svelte`, `src/routes/(app)/settings/+page.svelte`, `src/routes/(app)/settings/_components/SettingsProfileTab.svelte`, `src/routes/(app)/settings/_components/TwoStepSettingsRow.svelte`, `src/routes/(app)/settings/_components/SettingsConnectionsTab.svelte`
- Test: `src/lib/components/layout/Sidebar.test.ts`, `src/lib/components/sidebar/ConversationList.test.ts`, `src/lib/components/ui/PageSwitcher.test.ts` (new), `src/routes/(app)/settings/_components/SettingsProfileTab.test.ts`, `src/routes/(app)/settings/_components/TwoStepSettingsRow.test.ts`, `src/routes/(app)/settings/page-spotlight.test.ts` (new; set it up like `page-oauth-return.test.ts`)

**Interfaces:**
- Consumes: Task 4.
- `PageSwitcher.svelte`: its item type (:2) gains an optional `spotlight?: SpotlightId`. When it is set, the tab element carries `use:spotlightTarget`.
- Markers:

| Spotlight | Element |
|---|---|
| `sidebar.search` | `button.search-pill` (Sidebar :393) and the collapsed rail's Search button (:360) |
| `sidebar.projects` | the Projects section header row in both branches of `ConversationList.svelte`: with projects (:1264) and without (:1451) |
| `knowledge.memory` / `knowledge.library` | the Memory and Documents items in `knowledgeTabs` (knowledge page :192-218), through `spotlight` |
| `settings.connections` | the root of `SettingsConnectionsTab.svelte` (:285) |
| `settings.twoStep` | the root of `TwoStepSettingsRow.svelte` (`data-testid="two-step-row"`, :109) |
| `settings.style` | a wrapper around the Default model and Conversation style rows in `SettingsProfileTab.svelte` (:607-650) |
| `settings.language` | the Interface language group (:678) |
| `settings.instructions` | the Personal instructions row (:737-750) |
| `settings.skills` | the Skills row (:781) |
| `settings.data` | `section#settings-section-data-privacy` (:831) |
| `settings.activity` | `section#settings-section-your-activity` (:898) |

- Openers. Each one runs only for a live request; use `pendingSpotlight`, and do not take the request, because the marker takes it:
  - `Sidebar.svelte`, `$effect` on `$spotlightRequest`: for `sidebar.search` or `sidebar.projects` below desktop, `sidebarOpen.set(true)`. For `sidebar.projects` on a collapsed desktop sidebar, `sidebarCollapsed.set(false)`; the rail has no Projects, and the person asked to see them.
  - `settings/+page.svelte`, in its existing `onMount` (:644), before the `?section=` reads: when the pending spotlight is `settings.connections`, set `activeTab = "connections"`. Leave the existing `?section=` deep links and their `settings-card-highlight` alone.

- [ ] **Step 1: Write the failing tests** (all with `stubLayoutForSpotlight()`):

```ts
// Sidebar.test.ts
it("opens the phone drawer when Show me asks for Search");                   // mock viewport tier "phone"; requestSpotlight("sidebar.search") → get(sidebarOpen) === true; pill rings
it("expands a collapsed sidebar when Show me asks for Projects");            // sidebarCollapsed.set(true); request → get(sidebarCollapsed) === false
// ConversationList.test.ts
it("rings the Projects header, with and without projects");
// PageSwitcher.test.ts
it("lets a tab carry a spotlight marker");                                   // item { spotlight: "knowledge.memory" } rings on request
// SettingsProfileTab.test.ts / TwoStepSettingsRow.test.ts
it.each(["settings.instructions", "settings.style", "settings.language", "settings.skills", "settings.data", "settings.activity"])("rings %s on request");
it("rings the two-step row on request");
// page-spotlight.test.ts
it("opens the Connections tab when Show me asks for connected accounts");
```

- [ ] **Step 2: Run to see them fail**: `npx vitest run src/lib/components/layout/Sidebar.test.ts src/lib/components/sidebar/ConversationList.test.ts src/lib/components/ui/PageSwitcher.test.ts "src/routes/(app)/settings"`. Expected: the new tests FAIL.
- [ ] **Step 3: Add the `spotlight` item field, the markers and the two openers.**
- [ ] **Step 4: Run again**, plus `npm run check`. Expected: PASS, 0 and 0.
- [ ] **Step 5: Commit**: `git add src/lib/components/layout/Sidebar.svelte src/lib/components/layout/Sidebar.test.ts src/lib/components/sidebar src/lib/components/ui "src/routes/(app)/knowledge/+page.svelte" "src/routes/(app)/settings" && git commit -m "Mark the sidebar's, Knowledge's and Settings' controls for Show me"`

---

### Task 10: The ways in

**Files:**
- Modify: `src/lib/components/layout/Sidebar.svelte`, `src/lib/components/layout/Header.svelte`
- Test: `src/lib/components/layout/Sidebar.test.ts`, `src/lib/components/layout/Header.test.ts`

**Interfaces:**
- Consumes: `appPlacePath("guide")` (Task 1) and `guide.title` (Task 2).
- **The "?" beside the badge.** It goes in the expanded header right after `{#if appVersion}…{/if}` (Sidebar :294-300) and outside it, because the version arrives after hydration and the "?" must not wait for it.
  - It is a `button` named `guide.title` (its `aria-label` and `title`). It shows `CircleQuestionMark` at `size={15}` and `strokeWidth={2.1}`, in a quiet circle as tall as the badge.
  - It carries `aria-current="page"` when `page.url.pathname === "/guide"` (`page` from `$app/state`).
  - A click calls `navigateAndClose(appPlacePath("guide"))` (:211), which also closes the phone drawer.
  - Do not give it `.btn-icon-bare` or `.compose-btn`: under 768 px, `src/app.css:835-929` forces those to 44 px. Instead, give it a 44 px touch area under 768 px with a pseudo-element, so the 64 px header does not grow.
- **The collapsed rail.** A fourth rail button after Knowledge (:369), styled like its neighbours, with `CircleQuestionMark` at `size={19}`, the same name and the same click.
- **The phone menu.** A sixth row in `Header.svelte` after Knowledge base (:269), copying that row's markup, with `CircleQuestionMark` at `size={18}` and the `guide.title` label. On click: `mobileMenuOpen = false; goto(appPlacePath("guide"))`.

- [ ] **Step 1: Write the failing tests**

```ts
// Sidebar.test.ts
it("puts a ? beside the version badge that opens the guide, before the version has loaded", async () => {
	render(Sidebar, { open: true, appVersion: null });
	await fireEvent.click(screen.getByRole("button", { name: "What AlfyAI can do" }));
	expect(goto).toHaveBeenCalledWith("/guide");
});
it("marks the ? as the current page on the guide");     // $app/state page.url "/guide" → aria-current="page"
it("puts a ? in the collapsed rail");                   // sidebarCollapsed.set(true) → the rail has the button
// Header.test.ts
it("lists the guide in the phone menu and closes the menu when it opens it");
```

- [ ] **Step 2: Run to see them fail**: `npx vitest run src/lib/components/layout/Sidebar.test.ts src/lib/components/layout/Header.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Add the three ways in.**
- [ ] **Step 4: Run again**, plus `npm run check`. Expected: PASS, 0 and 0.
- [ ] **Step 5: Commit**: `git add src/lib/components/layout && git commit -m "Open the feature guide from a ? beside the version badge, the collapsed rail and the phone menu"`

---

### Task 11: End to end, and the gate

**Files:**
- Create: `tests/e2e/feature-guide.spec.ts`

**Interfaces:**
- Consumes: `login`, `ensureSidebarExpanded` and `waitForHydration` from `tests/e2e/helpers.ts`, and `createTourUser("hu")` from `tests/e2e/artifact-tours-helpers.ts` (a throwaway Hungarian user, so no shared state needs putting back).
- Copy the shape of `tests/e2e/branding.spec.ts`. Locate by `data-testid` and role, never with `page.waitForTimeout`. Put any theme you change back in the test's own cleanup.

- [ ] **Step 1: Write the spec.** Each test below is one `test(...)`.
  1. `@smoke`: **the ? beside the version badge opens the guide.** Desktop, sidebar expanded. Expect the heading "What AlfyAI can do", six section headings and thirty rows.
  2. **The collapsed rail and the phone menu open it too.** The phone is 390 by 844, through `button[aria-label="Open user menu"]` then `.header-menu`.
  3. **Try it puts the example in the Home box and sends nothing.** Use Maps and travel. Expect the URL to be `/`, the `message-input` value to equal the English example, and no request to `/api/chat/stream`.
  4. **Try it keeps an unsent Home draft.**
     - Type "my words" on Home and wait for the `PUT …/draft` response.
     - Open `/guide` and press Try it.
     - Expect the box to still say "my words", with the toast visible.
  5. **Every Show me rings its control.** Loop over the 18 Show me entries: press "Show me: <name>", then expect the target to match `toHaveClass(/spotlight-ring/)`. Run it on desktop, then repeat `sidebar.search`, `sidebar.projects`, `home.incognito` and `composer.atlas` at 390 px.
     - Keep a table of targets in the spec: spotlight id to locator.
     - Three targets depend on configuration: the Atlas row needs Atlas availability, the Thinking button needs a model with reasoning controls, and the Skills row needs the command registry. Confirm the seeded e2e app has them. If one is missing, set it up through the existing helpers and put it back afterwards. Never skip an entry.
  6. **Hungarian at 360 px holds together.** Use a throwaway Hungarian user at 360 by 780.
     - The guide's scroller has `scrollWidth <= clientWidth`.
     - Every drawing frame has `scrollWidth <= clientWidth`.
     - A tap on a row lights its spot, and the drawing's bounding box is inside the viewport.
  6b. **English at 390 px holds together.** The same three checks, for the English admin at 390 by 844.
  7. **Keyboard.** At 1280 px, tab onto a row's button and expect its spot to be lit.
  8. **Dark mode.** Use `emulateMedia({ colorScheme: "dark" })`. Expect `html` to have the class `dark` and a drawing frame's background to be the dark `--surface-elevated` value. Put the media back.

- [ ] **Step 2: Run the spec alone.**
  - First: `npm run build`.
  - Then: `npx playwright test tests/e2e/feature-guide.spec.ts`.
  - Expected: PASS, with 0 flaky. If a test is flaky, find its cause (`tests/AGENTS.md`); do not retry it.

- [ ] **Step 3: Run the gate once, at the end**

Run: `scripts/gates.sh agent "$TMPDIR/alfyai-gates" --port 4720 tests/e2e/feature-guide.spec.ts tests/e2e/branding.spec.ts tests/e2e/chat.spec.ts tests/e2e/conversation.spec.ts tests/e2e/login.test.ts tests/e2e/search-modal.spec.ts tests/e2e/settings-admin.spec.ts tests/e2e/settings-connections.spec.ts tests/e2e/knowledge.spec.ts tests/e2e/mobile-design.spec.ts tests/e2e/phone-polish.spec.ts tests/e2e/sidebar-multi-select.spec.ts tests/e2e/campaign-audience.spec.ts`
Expected: every step exits 0. Fallow shows no finding beyond the baseline's four cycles, and the build shows zero warnings.

- [ ] **Step 4: Commit**: `git add tests/e2e/feature-guide.spec.ts && git commit -m "Cover the feature guide end to end: ways in, Try it, every Show me, Hungarian at 360 px, dark"`
