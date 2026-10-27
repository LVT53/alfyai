# Images Part 2b: The Image Kind's UI Implementation Plan

> **Draft, 2026-10-27.** Waits on the owner's answers to the plan's own calls in [`plan-part-2-images.md`](./plan-part-2-images.md). They are folded in before anyone builds from this plan.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The person sees and steers pictures in the chat and the panel: an image card under the reply with its states, takes, Another and Use this; the picture large in the panel with Before / After and its versions; History with thumbnails, a compare wipe and Restore; numbered picture chips, Attach and the cap; the Mark tool; Images in the Knowledge Base and Workspace Search; all on a phone, in English and Hungarian.

**Architecture:** A new `src/lib/components/artifacts/image/` folder holds the kind's components and their pure view models. The card is `ArtifactCard`'s full chrome with a lazily loaded `ImageCardBody`; the panel body and the History preview join the family's two registries (`artifact-bodies.ts`, `history/history-previews.ts`). The chat page holds the conversation's `imageCards` from the detail (plan 2a Task 10), polls while a take is live, and owns the composer's attached pictures and marks, because they start outside the composer (a card, the panel, History).

**Tech Stack:** Svelte 5 runes, SvelteKit, TypeScript, Lucide icons, the tokens in `src/app.css`, `@testing-library/svelte` with vitest, Playwright.

**Spec:** `docs/plans/image-generation/design.md` sections 5.3 to 5.10 and wireframe frames 1 to 7. The index, the shared Global Constraints and the plan's own calls are in [`plan-part-2-images.md`](./plan-part-2-images.md). Consumes plan 2a's interfaces (Tasks 6, 7, 10, 11, 12).

## Global Constraints

The shared list in `plan-part-2-images.md` applies to every task. This plan adds:

- Read `src/lib/components/artifacts/AGENTS.md`, `artifacts/history/AGENTS.md`, `document-workspace/AGENTS.md` and `components/chat/AGENTS.md` before changing code in those folders.
- The registries stay append-only, one entry per kind (`ARTIFACT_BODIES`, `HISTORY_PREVIEWS`, `ARTIFACT_KIND_ICONS`, `ArtifactCard`'s kind branches). The image components load lazily: nothing of them enters the chat route's first load (`npm run check:artifact-chunks` holds it).
- The card is drawn in `message-deliverables`, after the prose (F16). Its picture box is reserved from the take's size before the picture loads.
- Older cards keep their own turn's picture (the card's pick), on purpose: the family's "one latest moment" rule does not apply to this kind's card picture, and the card shows no "edited … ago" line.
- The chip-kind list stays closed: numbered pictures and the marks chip are `image` chips (Plan's call 8).
- Pictures are fetched only from `/api/images/files/<id>` (`imageFileUrl`), with the chat's `conversationId` so an incognito chat's pictures load.
- Touch handlers that must `preventDefault` (drawing a mark) are attached as non-passive listeners in an action, never with legacy modifiers (root AGENTS.md, Svelte 5).
- Hungarian copy below is first-guess copy in the owner's style; keep each label short enough for a 360 px row.

## Review Focus

1. **A card arriving while the reply still streams.** Nothing above the prose moves (F16), and the card's own picture box does not jump when the picture loads. Tests in Tasks 2 and 8.
2. **A transparent picture in dark mode.** The checkerboard shows in both themes and Download keeps the alpha channel. Tests in Tasks 2 and 8.
3. **A 360 px phone in Hungarian.** The card's actions, the takes strip and the composer's chips fit without sideways scrolling. Test in Task 8.
4. **Marks left from an older picture.** When a new version lands, or another item opens, the marks and their chip go. Test in Task 6.
5. **The admin lowers the cap while the composer holds more pictures.** Send is blocked with the cap's words; the server refuses too (plan 2a Task 11). Test in Task 5.

---

## File structure

Created (under `src/lib/components/artifacts/image/` unless a path says otherwise):
- `AGENTS.md`: the kind's UI rules (the Global Constraints above that concern the card, the panel and marks), under 25 lines.
- `image-card-view.ts`: the card's state, subtitle and lines, pure.
- `ImagePicture.svelte`: one picture with its reserved box, the checkerboard and Before / After.
- `ImageCardBody.svelte`: the card's body.
- `ImageBody.svelte`, `VersionStrip.svelte`, `pinch-zoom.ts`: the panel.
- `ImageVersionPreview.svelte`, `CompareWipe.svelte`: History.
- `MarkLayer.svelte`, `mark-geometry.ts`: the Mark tool.
- `src/lib/components/chat/composer-pictures.ts`: picture numbering and the cap.
- `tests/e2e/images.spec.ts`, `tests/e2e/images-composer.spec.ts`.
- A test file beside every new module and component.

Modified, by task: `src/lib/i18n/artifacts.ts`, `components/artifacts/AGENTS.md`, root `AGENTS.md` (Task 1); `ArtifactCard.svelte`, `utils/tool-activity.ts`, `chat/ToolActivityRow.svelte`, `chat/ToolActivityList.svelte`, `chat/MessageBubble.svelte`, the chat page `+page.svelte`, `+page.ts`, `_helpers.ts` (Task 2); `artifact-bodies.ts`, `document-workspace/DocumentWorkspace.svelte`, `history/HistoryMode.svelte`, the chat page (Task 3); `history/history-previews.ts`, `history/MomentRail.svelte` (Task 4); `chat/ComposerChip.svelte`, `chat/MessageInput.svelte`, the chat page, the landing page, `chat/MessageBubble.svelte`, the image components (Task 5); `ImageBody.svelte`, `artifact-bodies.ts`, `DocumentWorkspace.svelte`, `MessageInput.svelte`, the chat page (Task 6); `routes/(app)/knowledge/_components/documents-table.ts`, `DocumentsList.svelte`, `components/search/SearchModal.svelte`, `src/lib/i18n/knowledge.ts` (Task 7); the mock provider, root `AGENTS.md`, `tests/AGENTS.md` (Task 8).

---

### Task 1: The card's view model and words

**Files:**
- Create: `image/image-card-view.ts`, `image/image-card-view.test.ts`, `image/AGENTS.md`
- Modify: `src/lib/i18n/artifacts.ts` (the card's keys below), `src/lib/components/artifacts/AGENTS.md` (`image/` has its own file), root `AGENTS.md` (Folder Rules: `image/` beside `canvas/`, `document/`, `history/`, `tour/`)

**Interfaces:**
- Consumes: `ImageCardView`, `ImageTakeView` (plan 2a Task 10); the `Translate` type of `src/lib/utils/tool-evidence-presentation.ts`, so the view model stays pure.
- Produces:

```ts
export type ImageCardState =
	| { kind: "waiting"; ahead: number | null }
	| { kind: "starting" }
	| { kind: "making"; etaSeconds: number | null; progressPercent: number | null }
	| { kind: "failed"; unavailable: boolean; retryable: boolean }
	| { kind: "stopped" }
	| { kind: "ready" };
export const STARTING_SHOWN_AFTER_MS = 3_000;
export function visibleTakes(card: ImageCardView): ImageTakeView[];
export function shownTake(card: ImageCardView, selectedTakeId: string | null): ImageTakeView | null;
export function takeState(take: ImageTakeView, now: number): ImageCardState;
export function cardSubtitle(card: ImageCardView, t: Translate): string;
export function etaLabel(seconds: number | null, t: Translate): string | null;
export function canCompareBeforeAfter(take: ImageTakeView | null): boolean;
export function hasActiveImageTakes(cards: readonly ImageCardView[]): boolean;
```

- [ ] **Step 1: Write the failing tests**

- `takeState`: `queued` is waiting with `ahead: null`; running with phase `submitted` and `queueAhead: 2` is waiting with 2; phase `starting` for 2 s is making, for 3 s is starting; phase `rendering` with `etaSeconds: 8` is making with 8; `succeeded` is ready; `cancelled` is stopped; failed with `errorCode: "image_server_unreachable"` is failed with `unavailable: true`, with `image_render_failed` `unavailable: false`.
- `shownTake`: the selected take when it is visible; else the pick; else the newest take still being made; else the newest.
- `cardSubtitle`: a photo card reads "Image · from your photo" / "Kép · a fotódból"; a pictures card with `sourceCount: 3` "Image · from 3 pictures" / "Kép · 3 képből"; a words card with two visible takes "Image · 2 takes" / "Kép · 2 változat"; with one take "Image" / "Kép".
- `etaLabel(7.2)` is "About 8 s left" / "Még kb. 8 mp"; `etaLabel(null)` and `etaLabel(0)` are null.
- `canCompareBeforeAfter` is true only for a take with both a file and a `baseFileId`.
- `hasActiveImageTakes` is true while any take is queued or running.

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/lib/components/artifacts/image`
Expected: FAIL.

- [ ] **Step 3: Implement, and add the strings**

`artifacts.image.*` keys (en / hu):
- `subtitle.photo` "Image · from your photo" / "Kép · a fotódból"; `subtitle.pictures` "Image · from {count} pictures" / "Kép · {count} képből"; `subtitle.takes` "Image · {count} takes" / "Kép · {count} változat"
- `card.making` "Making the picture…" / "Készül a kép…"; `card.eta` "About {count} s left" / "Még kb. {count} mp"
- `card.waiting` "Another picture is being made" / "Egy másik kép készül"; `card.ahead` "{count} ahead of this one" / "{count} van előtte"
- `card.starting` "Starting the picture maker…" / "Indul a képkészítő…"; `card.startingDetail` "After a quiet spell the model loads first, so this one takes longer." / "Szünet után előbb betöltődik a modell, ezért ez tovább tart."
- `card.failed` "Couldn't make this one." / "Ezt nem sikerült elkészíteni."; `card.nothingSaved` "Nothing was saved." / "Nem lett elmentve semmi."; `card.unavailable` "Pictures can't be made right now." / "Most nem lehet képet készíteni."; `card.stopped` "Stopped." / "Leállítva."
- `card.stop` "Stop" / "Leállítás"; `card.tryAgain` "Try again" / "Újra"; `card.another` "Another" / "Másik"; `card.useThis` "Use this" / "Ez legyen"; `card.inUse` "In use" / "Használatban"; `card.attach` "Attach" / "Csatolás"; `card.download` "Download" / "Letöltés"; `card.more` "More" / "Továbbiak"; `card.history` "History" / "Előzmények"
- `card.before` "Before" / "Előtte"; `card.after` "After" / "Utána"; `card.madeFrom` "Made from" / "Ebből készült"; `card.seeThrough` "See-through background" / "Átlátszó háttér"
- `card.takeAlt` "{title}, take {number}" / "{title}, {number}. változat"

- [ ] **Step 4: Run the tests and check**

Run: `npx vitest run src/lib/components/artifacts/image src/lib/i18n` then `npm run check`.
Expected: PASS; 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/artifacts src/lib/i18n/artifacts.ts AGENTS.md
git commit -m "Say what an image card shows in each state, in English and Hungarian"
```

### Task 2: The card in the chat

**Files:**
- Create: `image/ImagePicture.svelte`, `image/ImageCardBody.svelte`, `image/ImageCardBody.test.ts`, `image/ImagePicture.test.ts`
- Modify: `src/lib/components/artifacts/ArtifactCard.svelte` (the image branch: full chrome, lazy `ImageCardBody`, props `imageCard` and `onImageAction`), `src/lib/utils/tool-activity.ts` (a `make_image` call's body), `src/lib/components/chat/ToolActivityRow.svelte`, `ToolActivityList.svelte`, `MessageBubble.svelte` (thread `imageCards` and `onImageAction`; one card per card id among the deliverables), `src/routes/(app)/chat/[conversationId]/+page.svelte`, `+page.ts`, `_helpers.ts`
- Test: `ImageCardBody.test.ts`, `ImagePicture.test.ts`, `ArtifactCard.test.ts`, `utils/tool-activity.test.ts`, `MessageBubble.test.ts`, the chat page `_helpers.test.ts`

**Interfaces:**
- Consumes: Task 1; `imageFileUrl`, `useImageTake`, `anotherImageTake`, `stopImageTake`, `retryImageTake` (plan 2a Task 10); `startAuthenticatedDownload` (`src/lib/client/downloads.ts`).
- Produces:
  - `ToolActivityBody` gains `{ kind: "image-card"; cardId: string | null; takeId: string | null; title: string }`, read from the call's metadata (`imageCardId`, `imageTakeId`) and input (`title`).
  - `type ImageCardAction = { type: "another"; cardId: string } | { type: "use"; takeId: string } | { type: "stop"; takeId: string } | { type: "retry"; takeId: string } | { type: "download"; fileId: string; title: string } | { type: "history"; artifactId: string } | { type: "open"; artifactId: string }` (Task 5 adds `{ type: "attach"; fileId: string; name: string }`).
  - `ArtifactCard` props `imageCard?: ImageCardView | null`, `onImageAction?: (action: ImageCardAction) => void`.
  - `ImagePicture` props: `fileId`, `width`, `height`, `hasAlpha`, `alt`, `conversationId`, `beforeFileId?: string | null`, `showing?: "after" | "before"`, `variant?: "full" | "thumb"`.
  - In the chat page's `_helpers.ts`: `shouldPollImageCards(cards: readonly ImageCardView[], streamingToolCalls: readonly { name: string; status: string }[]): boolean`.

- [ ] **Step 1: Write the failing tests**

- a running take in phase `rendering` with `etaSeconds: 8` and `progressPercent: 40` shows "Making the picture…", "About 8 s left", a `progressbar` with `aria-valuenow` 40, and Stop sends `{ type: "stop", takeId }`.
- a take waiting with one ahead shows "Another picture is being made" and "1 ahead of this one".
- a ready take shows an `img` whose `src` contains `/api/images/files/<fileId>`, with `width` and `height` set; with `hasAlpha` its box has the class `image-checkerboard`; while it renders, the box keeps the take's `canvas` aspect ratio (Review Focus 1).
- two takes with the first as the pick: the first thumbnail carries the "In use" badge; choosing the second shows it and "Use this", which sends `{ type: "use", takeId: <second> }`.
- Another sends `{ type: "another", cardId }`; the "…" menu holds Download and History.
- a failed take with `image_server_unreachable` reads "Pictures can't be made right now." with Try again, which sends `{ type: "retry", takeId }`.
- Before / After switches the picture to the base file and back.
- in Hungarian the card reads "Másik", "Ez legyen" and "Készül a kép…".
- the checkerboard's two colours are tokens (`--surface-page`, `--border-subtle`), so dark mode has its own (Review Focus 2).
- `MessageBubble`: two `make_image` calls with the same `imageCardId` give one card in `message-deliverables`, after the prose.
- `tool-activity`: a `make_image` call's body is `image-card` with the ids from its metadata.
- `shouldPollImageCards` is true for a queued take, and for a `make_image` call still running in the streaming message before its card exists.

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/lib/components/artifacts src/lib/components/chat src/lib/utils/tool-activity.test.ts "src/routes/(app)/chat/[conversationId]/_helpers.test.ts"`
Expected: FAIL.

- [ ] **Step 3: Implement**

The card's head is `ArtifactCard`'s full chrome (the `Image` icon, the title, `cardSubtitle`, Open › when the card has an item). Its body, top to bottom: the shown take's picture (or the state block in the same reserved box: the state's line, the detail line, the progress bar while making, Stop or Try again); the Before / After switch (two `aria-pressed` buttons) when `canCompareBeforeAfter`; the takes strip when more than one take is visible (56 px thumbnails, the pick's `Check` badge, "Use this" under a chosen take that is not the pick); the "Made from" row for a pictures card (numbered thumbnails of `sourceFileIds`); the actions row: Another (`RefreshCw`) and "…" (`Ellipsis`: Download, History). The card finds its data by `cardId`, or, while the call is still running, by the take whose `toolCallId` is the call's. The page keeps `imageCards` from the detail (load and every hydrate), polls with the existing 2.5 s detail interval while `shouldPollImageCards`, sends each action through `client/api/images.ts` and hydrates after it. A Download goes through `startAuthenticatedDownload(imageFileUrl(fileId, { download: true, conversationId }))`.

- [ ] **Step 4: Run the tests and check**

Run: the Step 2 command, `npm run check`, then `npm run build` and `npm run check:artifact-chunks`.
Expected: PASS; 0 errors, 0 warnings; the chat route's first load does not grow by the image components.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/artifacts src/lib/components/chat src/lib/utils/tool-activity.ts src/lib/utils/tool-activity.test.ts "src/routes/(app)/chat/[conversationId]"
git commit -m "Show each turn's picture as a card under the reply, with its takes, Another and Use this"
```

### Task 3: The picture in the panel

**Files:**
- Create: `image/ImageBody.svelte`, `image/VersionStrip.svelte`, `image/pinch-zoom.ts`, and `ImageBody.test.ts`, `VersionStrip.test.ts`, `pinch-zoom.test.ts`
- Modify: `src/lib/components/artifacts/artifact-bodies.ts` (`image: () => import("./image/ImageBody.svelte")`; `onOpenHistory?: (versionId?: string) => void`), `document-workspace/DocumentWorkspace.svelte` (passes the version on), `history/HistoryMode.svelte` (`initialVersionId?: string` selects that version's entry first), the chat page (an open image item takes `artifacts.chat.composerPlaceholderApp`, as an App does)
- Test: those tests, `HistoryMode` test

**Interfaces:**
- Consumes: `parseImageVersionBody` (plan 2a Task 6), `fetchArtifactHistory` (`client/api/artifacts.ts`), `imageFileUrl`, `ImagePicture` (Task 2).
- Produces: `zoomFrom(start: { distance: number; scale: number }, now: { distance: number }): number` (clamped to 1..4) and the action `pinchZoom(node: HTMLElement, options: { enabled: boolean })` in `pinch-zoom.ts`.

- [ ] **Step 1: Write the failing tests**

- the body shows the version's picture with its width and height; with a `baseFileId`, Before shows the base.
- the strip lists one thumbnail per version, oldest first, read from History's image moments; a photo item's first frame is labelled "Your photo" / "A fotód"; choosing a frame calls `onOpenHistory(<versionId>)`, and History opens on that version.
- the registered `openDownload` starts a download of `/api/images/files/<fileId>?download=1` with the chat's `conversationId`.
- `zoomFrom({ distance: 100, scale: 1 }, { distance: 200 })` is 2; 500 gives 4; 50 gives 1.
- the chat page's placeholder for an open image item reads "Ask Alfy to change {title}…" (the App's key).

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/lib/components/artifacts src/lib/components/document-workspace "src/routes/(app)/chat/[conversationId]"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`ImageBody`: the picture fitted to the panel (`object-fit: contain`), the toolbar (Before / After; Task 6 adds Mark), the strip below it. It registers `openDownload` and `reload` (`registerPanelActions`). On a phone the panel is the existing full-screen sheet and the picture takes `use:pinchZoom`: two pointers zoom (1x to 4x) and pan, a double tap resets, one pointer is left to the Mark tool. The strip's tooltips and labels come from History's moment words (`moment-text.ts`), never a version number.

- [ ] **Step 4: Run the tests and check**

Run: the Step 2 command, `npm run check`, then `npm run build` and `npm run check:artifact-chunks`.
Expected: PASS; 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/artifacts src/lib/components/document-workspace "src/routes/(app)/chat/[conversationId]"
git commit -m "Show the picture large in the panel, with Before / After and a strip of its versions"
```

### Task 4: History for pictures

**Files:**
- Create: `image/ImageVersionPreview.svelte`, `image/CompareWipe.svelte`, `ImageVersionPreview.test.ts`, `CompareWipe.test.ts`
- Modify: `history/history-previews.ts` (`image: () => import("../image/ImageVersionPreview.svelte")`), `history/MomentRail.svelte` (a 40 px thumbnail on image moments), `src/lib/i18n/artifacts.ts`
- Test: those tests, `MomentRail` test

**Interfaces:**
- Consumes: `HistoryPreviewProps` (unchanged in this task), `version-bodies.ts`, `MomentDetail` image (plan 2a Task 6), `MARK_COLOURS`.
- Produces: `CompareWipe` props `beforeUrl`, `afterUrl`, `width`, `height`, `position` (0 to 100, bindable), `label`.

- [ ] **Step 1: Write the failing tests**

- with a base version, the preview shows both pictures and the wipe at 50; setting the range to 30 clips the top picture with `inset(0 0 0 30%)`.
- a first version (`baseVersionId: null`) shows only its picture, with no wipe.
- "compared with now" wipes against the newest version's picture.
- the prompt sits in a closed `<details>` labelled "Prompt Alfy sent" / "Alfy utasítása".
- a version made with marks shows them on the before side: a box at `x: 0.1, w: 0.2` is placed at `left: 10%`, `width: 20%`, bordered `#E53935`, tagged "A".
- the preview reports `{ status: "ready", changeCount: 0 }`, so no change stepper shows.
- the rail shows a thumbnail for an image moment and none for a document's.

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/lib/components/artifacts/image src/lib/components/artifacts/history`
Expected: FAIL.

- [ ] **Step 3: Implement, and add the strings**

`artifacts.image.history.wipe` "Drag to compare" / "Húzd az összevetéshez"; `artifacts.image.history.prompt` "Prompt Alfy sent" / "Alfy utasítása"; `artifacts.image.history.marks` "With marks {letters}" / "{letters} jelöléssel". Restore stays the shell's own (`MomentPreviewToolbar`).

- [ ] **Step 4: Run the tests and check**

Run: the Step 2 command, `npm run check`, then `npm run build` and `npm run check:artifact-chunks`.
Expected: PASS; 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/artifacts src/lib/i18n/artifacts.ts
git commit -m "Give pictures their History: a thumbnail per version and a wipe to compare with the one before"
```

### Task 5: Pictures in the composer: numbers, Attach and the cap

**Files:**
- Create: `src/lib/components/chat/composer-pictures.ts`, `composer-pictures.test.ts`
- Modify: `chat/ComposerChip.svelte` (`number?: number | null`), `chat/MessageInput.svelte` (props `pictureRefs`, `onRemovePictureRef`, `imageReferenceCap`; numbering; the cap; the send carries `pictureRefs`), the chat page (holds `pictureRefs`; Attach from a card, the strip and History adds one and focuses the composer; cleared after a send), the landing page (the cap for uploads, from `AppShellData.imageReferenceCap`), `image/ImageCardBody.svelte`, `image/VersionStrip.svelte`, `image/ImageVersionPreview.svelte` (Attach), `history/history-previews.ts` (`HistoryPreviewProps.onAttachPicture?`), `history/HistoryMode.svelte` and `DocumentWorkspace.svelte` (thread it), `chat/MessageBubble.svelte` (a sent message's pictures), `src/lib/i18n/chat.ts`
- Test: `composer-pictures.test.ts`, `ComposerChip.test.ts`, `MessageInput` tests, `MessageBubble.test.ts`, the chat page tests

**Interfaces:**
- Consumes: `PictureRef` (plan 2a Task 6), `ChatMessage.pictures` (plan 2a Task 11), `imageFileUrl`.
- Produces:

```ts
export type ComposerPictureRef = { imageFileId: string; name: string };
export function pictureKey(source: { kind: "upload"; artifactId: string } | { kind: "ref"; imageFileId: string }): string; // "upload:<id>" | "ref:<id>"
export function numberPictures(order: readonly string[], isPicture: (key: string) => boolean): Map<string, number>;
export function picturesOverCap(count: number, cap: number): boolean;
```

- `ImageCardAction` gains `{ type: "attach"; fileId: string; name: string }`.

- [ ] **Step 1: Write the failing tests**

- numbering in the order things were added: a photo upload, a PDF, then a ref give the photo 1 and the ref 2, and the PDF no number; removing the photo makes the ref 1.
- a numbered chip shows its numeral and is named "Picture 2: rug.jpg" / "2. kép: rug.jpg".
- five pictures with the cap at 4 show "Up to 4 pictures in one message. Remove one to send." / "Egy üzenetben legfeljebb 4 kép lehet. Vegyél ki egyet a küldéshez.", and Send is disabled.
- "the admin lowers the cap" (Review Focus 5): holding four pictures, a rerender with `imageReferenceCap: 3` blocks Send with the same words.
- the send payload carries `pictureRefs: [{ imageFileId: "f1", number: 2 }]`, and the refs are gone after the send.
- Attach on a card adds a ref chip named after the card's title; Attach in History adds that version's picture.
- a sent user message with `pictures.refs` shows each as a numbered thumbnail.

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/lib/components/chat src/lib/components/artifacts "src/routes/(app)"`
Expected: FAIL.

- [ ] **Step 3: Implement, and add the strings**

The composer keeps one list of picture keys in the order they were added (`pictureKey`), so uploads and refs share one numbering, and the numbers match the server's (plan 2a Tasks 1 and 11). An upload counts as a picture when its file-type category is `image`. The server's refusal (`composerChips.tooManyPictures`) shows the same words. Keys: `composerChips.pictureNumberA11y` "Picture {number}: {name}" / "{number}. kép: {name}"; `composerChips.tooManyPictures` "Up to {count} pictures in one message. Remove one to send." / "Egy üzenetben legfeljebb {count} kép lehet. Vegyél ki egyet a küldéshez."; `composerChips.removePicture` "Remove {name}" / "{name} eltávolítása".

- [ ] **Step 4: Run the tests and check**

Run: the Step 2 command, `npx vitest run src/lib/i18n`, then `npm run check`.
Expected: PASS; 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components src/routes/\(app\) src/lib/i18n/chat.ts
git commit -m "Number the pictures in the composer, let any card's picture be attached, and hold the cap"
```

### Task 6: Marks

**Files:**
- Create: `image/MarkLayer.svelte`, `image/mark-geometry.ts`, `MarkLayer.test.ts`, `mark-geometry.test.ts`
- Modify: `image/ImageBody.svelte` (the Mark toggle and the layer), `artifact-bodies.ts` (`marks?: ImageMark[]`, `onMarksChange?: (marks: ImageMarksRequest | null) => void`), `DocumentWorkspace.svelte` (passes them through), the chat page (holds `imageMarks`; clears them on send, on the chip's ×, when another item opens and when the open item's version changes), `chat/MessageInput.svelte` (`imageMarks`, `onClearMarks`; one `image` chip; the send carries `imageMarks`), `src/lib/i18n/artifacts.ts`, `src/lib/i18n/chat.ts`
- Test: those tests, `ImageBody.test.ts`, `MessageInput` tests, the chat page tests

**Interfaces:**
- Consumes: `ImageMark`, `ImageMarksRequest`, `MARK_LETTERS`, `MARK_COLOURS`, `MAX_MARKS` (plan 2a Task 6).
- Produces:

```ts
export type Point = { x: number; y: number };
export const MIN_MARK_SIDE = 0.02;
export function boxFromDrag(start: Point, end: Point, frame: { width: number; height: number }): { x: number; y: number; w: number; h: number } | null;
export function nextLetter(marks: readonly ImageMark[]): MarkLetter | null;
export function hitMark(point: Point, marks: readonly ImageMark[]): MarkLetter | null;
```

- [ ] **Step 1: Write the failing tests**

- `boxFromDrag({ x: 10, y: 10 }, { x: 110, y: 60 }, { width: 200, height: 100 })` is `{ x: 0.05, y: 0.1, w: 0.5, h: 0.5 }`; a drag past the frame is clamped; a 2 px drag is null.
- `nextLetter` gives the first unused letter (`[A, C]` gives B; eight marks give null); `hitMark` gives the last-drawn box under the point.
- the layer: with Mark on, two drags draw A (red) and B (blue); a tap on A removes it; a ninth box is refused with "Up to 8 marks" / "Legfeljebb 8 jelölés"; with Mark off, a drag draws nothing.
- each box is a button named "Mark A, tap to remove" / "A jelölés, koppints a törléshez".
- the composer shows one chip "Marks A, B" / "A, B jelölés" with the picture's thumbnail; its × clears the marks; the send carries `imageMarks: { imageFileId, marks }` in fractions, and the chip is gone after.
- "marks left from an older picture" (Review Focus 4): the page clears the marks and the chip when the open item's version changes and when another item opens.

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/lib/components/artifacts/image src/lib/components/chat "src/routes/(app)/chat/[conversationId]"`
Expected: FAIL.

- [ ] **Step 3: Implement, and add the strings**

The layer listens with pointer events on an overlay; drawing on touch needs `preventDefault`, so it adds a non-passive `touchmove` listener in an action. A second pointer cancels the box being drawn (the pinch belongs to the zoom). A press that moves under 6 px is a tap. Keys: `artifacts.image.panel.mark` "Mark" / "Jelölés" (icon `SquareDashed`); `artifacts.image.panel.markHint` "Drag to draw a box" / "Húzással rajzolj keretet"; `artifacts.image.panel.markA11y` "Mark {letter}, tap to remove" / "{letter} jelölés, koppints a törléshez"; `artifacts.image.panel.tooManyMarks` "Up to 8 marks" / "Legfeljebb 8 jelölés"; `composerChips.marks` "Marks {letters}" / "{letters} jelölés"; `composerChips.removeMarks` "Remove the marks" / "Jelölések törlése".

- [ ] **Step 4: Run the tests and check**

Run: the Step 2 command, `npx vitest run src/lib/i18n`, then `npm run check`.
Expected: PASS; 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components src/routes/\(app\)/chat src/lib/i18n
git commit -m "Let the person draw lettered boxes on the open picture and send them as one chip"
```

### Task 7: Images in the Knowledge Base and Workspace Search

**Files:**
- Modify: `src/routes/(app)/knowledge/_components/documents-table.ts` (`DOCUMENT_TYPE_FILTER_ORDER` gains `"image"` between `"app"` and `"uploaded"`), `DocumentsList.svelte` (the chip's label and the row's `Image` icon), `src/lib/components/search/SearchModal.svelte` (an image result shows the `Image` icon, the way a Canvas result shows its kind), `src/lib/i18n/knowledge.ts`
- Test: `documents-table.test.ts`, `DocumentsList.test.ts`, `SearchModal.test.ts`

- [ ] **Step 1: Write the failing tests**

- the Images chip ("Images" / "Képek") lists only image rows; the row shows the `Image` icon and the kind label "Image" / "Kép".
- a search result for an image's title shows the `Image` icon, and choosing it opens the item in the panel with the image body.

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run "src/routes/(app)/knowledge" src/lib/components/search`
Expected: FAIL.

- [ ] **Step 3: Implement** (one entry in each list, the strings in `knowledge.ts`).

- [ ] **Step 4: Run the tests and check**

Run: the Step 2 command, `npx vitest run src/lib/i18n`, then `npm run check`.
Expected: PASS; 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add src/routes/\(app\)/knowledge src/lib/components/search src/lib/i18n/knowledge.ts
git commit -m "List pictures under Images in the Knowledge Base and show them in Workspace Search"
```

### Task 8: End to end and the gate

**Files:**
- Create: `tests/e2e/images.spec.ts`, `tests/e2e/images-composer.spec.ts`
- Modify: `tests/mocks/ai-provider/openai-compatible-provider.ts` (markers for an edit of picture `"1"` and for four identical calls; the `make_image` arguments it sent are kept for assertions), root `AGENTS.md` (Mandatory Verification: "an Image: `tests/e2e/images*.spec.ts`"), `tests/AGENTS.md`

**Interfaces:**
- Consumes: `startFakeComfyUiForSpec`, `stopFakeComfyUiForSpec` and `AI_SMOKE_MAKE_IMAGE_MARKER` (plan 2a Task 14).

- [ ] **Step 1: Write the specs**

`images.spec.ts`:
- `@smoke` "makes a picture and shows it under the reply": the card is in `message-deliverables` after the prose, shows "Making the picture…" and then the picture; the reply's first sentence keeps its top edge, frame by frame, while the card arrives (the method of `artifact-card-arrival.spec.ts`) (Review Focus 1).
- "Another adds a take and Use this moves the tick": two takes; Use this on the second moves the "In use" badge; History lists two versions with thumbnails.
- "changes an uploaded photo": attach a PNG and send the edit marker; the card reads "Image · from your photo"; Before / After switches; the panel's strip starts with "Your photo".
- "History compares and restores": open History, move the wipe, Restore the first version; the panel shows it.
- "a transparent picture" (Review Focus 2): the fake renders RGBA; in dark mode the card shows the checkerboard; the downloaded file is a PNG with an alpha channel (read with sharp in the spec).
- "pictures can't be made right now": with the fake closed, the card reads "Pictures can't be made right now." with Try again.
- "a phone in Hungarian" (Review Focus 3): at 360x780 with the Hungarian UI, the card's actions, the takes strip and the composer's chips have `scrollWidth <= clientWidth`; the card reads "Másik" and "Ez legyen".

`images-composer.spec.ts`:
- "Attach puts a picture into the next message": Attach on a card gives the chip "1 Cosy living room"; after the send, the fake model's request holds the text `Picture 1: Cosy living room` before an `image_url` part.
- "marks travel as one chip": open the item, turn on Mark, draw two boxes; the chip reads "Marks A, B"; after the send, the request holds `with the user's marks: A = red box, B = blue box` and the chip is gone.
- "the cap blocks the send": the cap set to 2 through the admin route; three pictures show the cap's words and a disabled Send; cleanup with `clearAdminConfig`.
- "Images in the Knowledge Base": the item is listed under Images and opens with its picture.

- [ ] **Step 2: Run the specs on their own**

Run: `npm run build`, then `E2E_PORT=4700 E2E_WORKERS=2 npx playwright test tests/e2e/images.spec.ts tests/e2e/images-composer.spec.ts`
Expected: PASS; then three more runs with `--repeat-each=3` pass (a flake is a bug: find its cause).

- [ ] **Step 3: Run the agent gate once**

Run: `scripts/gates.sh agent /Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/<worktree>/.superpowers/sdd/plan-part-2b-image-ui/gates --port 4600 tests/e2e/images.spec.ts tests/e2e/images-composer.spec.ts tests/e2e/images-pipeline.spec.ts tests/e2e/artifact-card-arrival.spec.ts tests/e2e/artifact-chat-card.spec.ts tests/e2e/artifact-panel-history.spec.ts tests/e2e/composer-chips.spec.ts tests/e2e/chat.spec.ts tests/e2e/vision.spec.ts tests/e2e/knowledge.spec.ts tests/e2e/search-modal.spec.ts` (with the worktree's literal path)
Expected: every step exits 0; zero build warnings; the chunk check passes; Fallow shows only the four known cycles.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e tests/mocks tests/AGENTS.md AGENTS.md
git commit -m "Cover the image card, the panel, History, Attach, marks and the cap end to end"
```
