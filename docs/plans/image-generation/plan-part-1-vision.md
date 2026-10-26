# Alfy Can See (Part 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A chat model the admin marks "Can see images" receives the pixels of images attached to the current message, and of Immich thumbnails when a question needs them. Older turns carry a short description instead of pixels.

**Architecture:** A new `src/lib/server/services/vision/` folder owns image preparation (sharp, plus heic-convert for HEIC), the model's ability to see (the existing `imageMessageParts` capability), turn images, history descriptions and the thumbnail hand-off. Chat-turn code asks it for a turn's images and adds them as AI SDK image parts to the current user message. History builders swap old images for stored descriptions. A per-attempt `prepareStep` hands Immich thumbnails to the model after the photos tool returns.

**Tech Stack:** SvelteKit with Svelte 5 runes, TypeScript, SQLite with hand-written Drizzle migrations, `ai` 6.0.193 with `@ai-sdk/openai-compatible` 2.0.48, vitest, Playwright, sharp, heic-convert.

**Spec:** `docs/plans/image-generation/design.md`. Part 1 is sections 1 to 4; the owner's decisions and my calls are sections 6 and 7. Part 2 (images) gets its own plan after this one lands.

## Global Constraints

- Every user-facing string (labels, errors, empty states, aria) exists in English and Hungarian. Hungarian is short and natural and fits a 360 px row.
- Ruling 79: everything the app writes into a model request is ASCII English (`tests/integration/english-request-purity.test.ts`). A new file that calls a model gets a `MODEL_CALLERS` line in that test.
- Pixels go only into the turn that needs them. Afterwards history carries a description. No new model-facing tool.
- Budgets: an attachment is sent at most 1600 px on its long side (about 1,600 tokens). An Immich thumbnail at most 512 px (about 250 tokens). Token estimate: `ceil(w/32) * ceil(h/32)`.
- At most 8 attachment images and 8 thumbnails as pixels per turn.
- "Can see images" is the `imageMessageParts` capability in `provider_models.capabilities_json`. Ticked writes a manual override with `supported: true`. Unticked removes the key and never writes `false`, so `canUseProviderModelFallback` keeps accepting fallbacks. Only an explicit `true` counts as seeing. Built-in models without a provider row cannot see.
- MinerU keeps running on images. Vision adds pixels; it does not replace intake.
- Images reach a cloud model only when that model is ticked. Immich pixels follow `connections/locality.ts` (local summarising and the cloud warning).
- A failover attempt on a model that cannot see gets no image parts.
- Profile memory never receives pixels.
- Svelte 5 runes, Lucide icons, tokens from `src/app.css`. Read each folder's AGENTS.md before changing code there.
- Run npm with Node 22: `/opt/homebrew/opt/node@22/bin/npm` (Node 26 breaks better-sqlite3). Pin new dependencies exactly (`--save-exact`).
- Iterate with single commands (`npx vitest run <file>`, `npm run check`). Never run `npm run check` or `npm test` while `npm run build` runs. Run the full gate once, at the end (Task 10).

## Review Focus

1. **The same photo attached again in a later turn** reuses one artifact, because uploads are deduplicated per user by hash. It must still go as pixels in the new turn, and its stored description must be reused, not written twice. Test in Task 6.
2. **Ten images in one message:** the first 8 go as pixels, and the text names the 2 that were held back. Test in Task 3.
3. **Switching from a seeing model to one that cannot see, mid-chat:** older images appear as descriptions, the current one gets the "cannot see" note, and no image part is sent. Test in Task 3.
4. **The description call fails or times out:** no row is stored, history falls back to `[attachment: <name>]`, and the turn is unaffected. Test in Task 6.
5. **Some Immich thumbnails fail to download:** the look continues with the rest, and "Looked at N photos" counts only the ones the model got. Test in Task 7.

---

## File structure

Created:
- `src/lib/model-image-input.ts`: `modelCanSeeImages`, `setModelImageInput`. Shared by the admin form, the model list and the server.
- `src/lib/server/services/vision/AGENTS.md`: the folder's rules (the constraints above that concern pixels, budgets and privacy).
- `vision/prepare-image.ts`: decode, rotate, flatten, resize and encode.
- `vision/model-vision.ts`: `providerCanSeeImages`, `modelIdCanSeeImages`.
- `vision/turn-images.ts`: `collectTurnImages`, `buildCurrentUserMessage`, `stripImageParts`.
- `vision/descriptions-store.ts` and `vision/describe.ts`: history descriptions.
- `vision/step-images.ts`: the per-turn thumbnail queue and its `prepareStep`.
- `vision/photo-look.ts`: the privacy decision and thumbnail fetching for the photos tool.
- `drizzle/<next>_image_descriptions.sql` (119 at the time of writing).
- `tests/e2e/vision.spec.ts`.

Modified, by task: `ModelForm.svelte`, `available-models.ts`, `client/api/models.ts` (Task 1); `package.json` (Task 2); `context-selection.ts`, `normal-chat-context.ts`, `shared-normal-chat-model-run-helpers.ts`, both model-run files (Task 3); `normal-chat-model/index.ts` (Tasks 4 and 7); `preflight.ts`, `knowledge/store/attachments.ts`, `composer-chip-presentation.ts`, `MessageInput.svelte`, `documents-table.ts`, `DocumentsList.svelte` (Task 5); `schema.ts`, `account-lifecycle/user-scoped-tables.ts`, `conversation-history.ts` (Task 6); `photos.ts`, `normal-chat-tools/index.ts`, `utils/tool-activity.ts` (Task 7); `chat-turn/stream.ts` and the response-activity client mapping (Task 8); i18n files in every task that adds a string; the root `AGENTS.md` Folder Rules and `services/AGENTS.md` (Task 2).

---

### Task 1: "Can see images" per model

**Files:**
- Create: `src/lib/model-image-input.ts`, `src/lib/model-image-input.test.ts`
- Modify: `src/routes/(app)/settings/_components/ModelForm.svelte` (state near :137, `buildModelUpdateData` :269, checkbox beside `guideNoCost` :690-698); `src/lib/server/services/available-models.ts` (model type :38-50, mapping :206-216, built-in models); `src/lib/client/api/models.ts`; `src/lib/i18n/settings.ts` (en and hu)
- Test: `src/lib/model-image-input.test.ts`, `src/lib/server/services/available-models.test.ts`

**Interfaces:**
- Produces: `modelCanSeeImages(capabilitiesJson: string | null | undefined): boolean` and `setModelImageInput(capabilitiesJson: string | null | undefined, enabled: boolean): string`, both in `src/lib/model-image-input.ts`. Also `supportsImages: boolean` on every model in the available-models payload.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/model-image-input.test.ts
it("writes a manual override when enabled", () => {
	const json = setModelImageInput('{"tools":"detected"}', true);
	expect(JSON.parse(json)).toEqual({
		tools: "detected",
		imageMessageParts: { state: "manual_override", supported: true, source: "manual_override" },
	});
	expect(modelCanSeeImages(json)).toBe(true);
});
it("removes the key when disabled, never writing false", () => {
	const json = setModelImageInput(setModelImageInput("{}", true), false);
	expect(JSON.parse(json)).toEqual({});
});
it("counts only an explicit true", () => {
	expect(modelCanSeeImages("{}")).toBe(false);
	expect(modelCanSeeImages('{"imageMessageParts":"unknown"}')).toBe(false);
	expect(modelCanSeeImages("not json")).toBe(false);
});
it("keeps a non-seeing fallback acceptable", () => {
	const source = { capabilitiesJson: setModelImageInput("{}", true), reasoningEffort: null, thinkingType: null };
	const fallback = { capabilitiesJson: setModelImageInput("{}", false), reasoningEffort: null, thinkingType: null };
	expect(canUseProviderModelFallback(source, fallback)).toEqual({ compatible: true });
});
```

Add to `available-models.test.ts`: a provider model whose `capabilitiesJson` comes from `setModelImageInput("{}", true)` lists `supportsImages: true`; one with `"{}"` lists `false`; built-in models list `false`.

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/lib/model-image-input.test.ts src/lib/server/services/available-models.test.ts`
Expected: FAIL (module and field missing).

- [ ] **Step 3: Implement both helpers in `src/lib/model-image-input.ts`**

Use `parseCapabilitySupportMap` from `src/lib/model-fallback-compatibility.ts`. Unparseable JSON counts as `{}`. Then add `supportsImages: modelCanSeeImages(model.capabilitiesJson)` to the available-models mapping, `supportsImages: false` for built-in models, and the field to the client type.

- [ ] **Step 4: Add the checkbox to `ModelForm.svelte`**

Follow the `formGuideNoCost` pattern (`$state(untrack(...))` plus its `$effect`). The checkbox's state is `modelCanSeeImages(formCapabilitiesJson)`. On change, `formCapabilitiesJson = setModelImageInput(formCapabilitiesJson, checked)`. New keys in `settings.ts`:
- `admin.modelCanSeeImages`: "Can see images" / "Lát képeket"
- `admin.modelCanSeeImagesDescription`: "Alfy sends this model the images people attach. Tick it only if the model reads images, and for a cloud model only if images may leave the server." / "Alfy elküldi ennek a modellnek a csatolt képeket. Csak akkor jelöld be, ha a modell érti a képeket, felhős modellnél pedig csak akkor, ha a képek elhagyhatják a szervert."

- [ ] **Step 5: Run the tests and check**

Run: `npx vitest run src/lib/model-image-input.test.ts src/lib/server/services/available-models.test.ts src/lib/i18n` then `npm run check`
Expected: PASS; check reports 0 errors and 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add src/lib/model-image-input.ts src/lib/model-image-input.test.ts "src/routes/(app)/settings/_components/ModelForm.svelte" src/lib/server/services/available-models.ts src/lib/server/services/available-models.test.ts src/lib/client/api/models.ts src/lib/i18n/settings.ts
git commit -m "Let the admin mark a model as able to see images"
```

### Task 2: Image preparation

**Files:**
- Modify: `package.json`, `package-lock.json` (add `sharp` and `heic-convert`, exact versions), root `AGENTS.md` (Folder Rules: add `vision/`), `src/lib/server/services/AGENTS.md` (add the folder's one-line role)
- Create: `src/lib/server/services/vision/AGENTS.md`, `vision/prepare-image.ts`, `vision/prepare-image.test.ts`, `vision/heic-convert.d.ts` (if the package ships no types), `vision/__fixtures__/tiny.heic`

**Interfaces:**
- Produces, in `vision/prepare-image.ts`:
  - `type PreparedImage = { base64: string; mediaType: "image/jpeg"; width: number; height: number; estimatedTokens: number }`
  - `prepareImageForModel(input: Uint8Array, mimeType: string | null, options: { maxLongEdge: number }): Promise<PreparedImage>`
  - `estimateImageTokens(width: number, height: number): number`
  - `ATTACHMENT_MAX_LONG_EDGE = 1600`, `THUMBNAIL_MAX_LONG_EDGE = 512`
  - `class ImagePreparationError extends Error`

- [ ] **Step 1: Add the dependencies**

Run `npm view sharp version` and `npm view heic-convert version`. Install those exact versions with `/opt/homebrew/opt/node@22/bin/npm install --save-exact sharp@<v> heic-convert@<v>`. Make the HEIC fixture on the Mac: `sips -s format heic -Z 64 static/favicon.png --out src/lib/server/services/vision/__fixtures__/tiny.heic`. Any small PNG works as the source.

- [ ] **Step 2: Write the failing tests** (`vision/prepare-image.test.ts`; build JPEG, PNG and GIF inputs in the test with sharp)

```ts
it("shrinks a large photo to the long-edge budget", async () => {
	const big = await sharp({ create: { width: 4032, height: 3024, channels: 3, background: "#888" } }).jpeg().toBuffer();
	const out = await prepareImageForModel(big, "image/jpeg", { maxLongEdge: ATTACHMENT_MAX_LONG_EDGE });
	expect(Math.max(out.width, out.height)).toBe(1600);
	expect(out.mediaType).toBe("image/jpeg");
});
it("applies EXIF orientation", async () => {
	const rotated = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#888" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
	const out = await prepareImageForModel(rotated, "image/jpeg", { maxLongEdge: 1600 });
	expect([out.width, out.height]).toEqual([200, 300]);
});
it("flattens transparency", async () => { /* RGBA PNG in, a JPEG out with no alpha (sharp metadata channels === 3) */ });
it("keeps only the first frame of an animated GIF", async () => { /* two-frame GIF in; sharp metadata of the output reports pages undefined or 1 */ });
it("decodes HEIC", async () => { /* __fixtures__/tiny.heic in; width > 0 */ });
it("never enlarges a small image", async () => { /* 1x1 PNG in; 1x1 out */ });
it("rejects bytes that are not an image", async () => {
	await expect(prepareImageForModel(new Uint8Array([1, 2, 3]), "image/png", { maxLongEdge: 1600 })).rejects.toBeInstanceOf(ImagePreparationError);
});
it("estimates tokens at 32 px per token", () => {
	expect(estimateImageTokens(1600, 1000)).toBe(1600);
	expect(estimateImageTokens(512, 384)).toBe(192);
});
```

- [ ] **Step 3: Run the tests and check they fail**

Run: `npx vitest run src/lib/server/services/vision/prepare-image.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 4: Implement `prepareImageForModel`**

For HEIC or HEIF (by MIME type or by the `ftypheic`/`ftypheix`/`ftypmif1` brand in bytes 4 to 12), first convert to JPEG with heic-convert. Then use `sharp(input, { animated: false })`, `.rotate()`, `.flatten({ background: "#ffffff" })`, `.resize({ width: max, height: max, fit: "inside", withoutEnlargement: true })`, `.jpeg({ quality: 85 })` and `.toBuffer({ resolveWithObject: true })`. Wrap any failure in `ImagePreparationError`. Write `vision/AGENTS.md` from the Global Constraints that concern pixels, budgets and privacy, in under 25 lines, and add the folder to the two maps.

- [ ] **Step 5: Run the tests and check**

Run: `npx vitest run src/lib/server/services/vision/prepare-image.test.ts` then `npm run check`
Expected: PASS; 0 errors, 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json AGENTS.md src/lib/server/services/AGENTS.md src/lib/server/services/vision
git commit -m "Prepare images for a model that can see: rotate, flatten, shrink, JPEG"
```

### Task 3: Pixels for the current message

**Files:**
- Create: `vision/model-vision.ts`, `vision/turn-images.ts`, and their tests
- Modify: `chat-turn/context-selection.ts` (`buildConstructedContext` :1681, where `resolvePromptAttachmentArtifacts` runs at :1776); `normal-chat-context.ts` (`prepareOutboundChatContext` :2165, turn guidance, and the budget at :1066); `chat-turn/shared-normal-chat-model-run-helpers.ts` (`prepareOutboundContext` :325, `PreparedModelContext`); `chat-turn/streaming-normal-chat-model-run.ts` :152; `chat-turn/plain-normal-chat-model-run.ts` :149
- Test: `vision/turn-images.test.ts`, `vision/model-vision.test.ts`, `normal-chat-model/index.test.ts` (outbound body, injected fetch, `parseRequestBody` :174)

**Interfaces:**
- Consumes: `prepareImageForModel`, `ATTACHMENT_MAX_LONG_EDGE`, `PreparedImage` (Task 2); `modelCanSeeImages` (Task 1).
- Produces:
  - `providerCanSeeImages(provider: NormalChatModelRunProvider): boolean`, via `isModelCapabilitySupported(provider.capabilities, "imageMessageParts")`
  - `modelIdCanSeeImages(modelId: ModelId | undefined): Promise<boolean>`. It resolves `undefined` through `resolveModelSelection` (`chat-turn/request.ts:233`), as the turn does, then goes through `resolveNormalChatModelRunProvider`.
  - `type TurnImage = { artifactId: string; name: string; image: PreparedImage }`
  - `collectTurnImages(params: { items: PromptAttachmentResolutionItem[]; maxImages: number }): Promise<{ images: TurnImage[]; heldBack: string[] }>`. The items are those of `resolvePromptAttachmentArtifacts` in `knowledge/store/attachments.ts`.
  - `buildCurrentUserMessage(text: string, images: readonly TurnImage[]): ModelMessage`
  - `MAX_TURN_IMAGES = 8`
  - `PreparedModelContext.currentImages: TurnImage[]` (empty unless the provider can see)

- [ ] **Step 1: Write the failing tests**

- `buildCurrentUserMessage("hi", [img])` returns `{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image", image: img.image.base64, mediaType: "image/jpeg" }] }`.
- `collectTurnImages` with 10 image items (real temp files) returns 8 `images` and the 2 remaining names in `heldBack`. A non-image item (`getCategory(name, mime) !== "image"`) is skipped. A corrupt file is skipped without throwing.
- In `normal-chat-model/index.test.ts`, a run whose provider has `imageMessageParts` supported and whose user message holds one image part sends a body whose last user message contains `{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,`.
- Review Focus 2: with 10 images, the user text contains "2 more attached images were not sent as pictures".
- Review Focus 3: with a provider that cannot see and image attachments present, the body contains no `image_url`, and the user text contains `CANNOT_SEE_IMAGES_GUIDANCE`.

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/lib/server/services/vision src/lib/server/services/normal-chat-model/index.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `buildConstructedContext` takes `collectImages: boolean` and, when true, returns `currentImages` from `collectTurnImages(items, MAX_TURN_IMAGES)`. Read bytes with `readFile(join(process.cwd(), displayArtifact.storagePath))`, as in `file-production/image-loader.ts:292`. An image with no prompt-ready text still contributes its pixels.
- `prepareOutboundContext` passes `collectImages: providerCanSeeImages(runtime.provider)`.
- The history budget shrinks by the sum of `estimatedTokens`.
- When images were held back, append to the turn guidance: `${n} more attached images were not sent as pictures because of the limit: ${names}.`
- When the provider cannot see and image attachments exist, append the turn guidance `CANNOT_SEE_IMAGES_GUIDANCE`: "The user attached an image, but you cannot see images; you only get any text extracted from it. Say so in one short sentence, then answer from that text."
- Both run files build the user message with `buildCurrentUserMessage(finalInputValue, prepared.currentImages)`.

- [ ] **Step 4: Run the tests and check**

Run: `npx vitest run src/lib/server/services/vision src/lib/server/services/normal-chat-model/index.test.ts src/lib/server/services/chat-turn tests/integration/english-request-purity.test.ts` then `npm run check`
Expected: PASS; 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/vision src/lib/server/services/chat-turn src/lib/server/services/normal-chat-context.ts src/lib/server/services/normal-chat-model/index.test.ts
git commit -m "Send attached images as pictures to a model that can see"
```

### Task 4: No pictures for a fallback that cannot see

**Files:**
- Modify: `vision/turn-images.ts` (add `stripImageParts`); `normal-chat-model/index.ts` (`attemptParams` in the plain loop :1176 and in `…WithFailover` :1414)
- Test: `vision/turn-images.test.ts`, `normal-chat-model/index.test.ts`

**Interfaces:**
- Produces: `stripImageParts(messages: readonly ModelMessage[]): ModelMessage[]`. Every `image` part becomes the text part `STRIPPED_IMAGE_NOTE`: "[An image was attached here, but this model cannot see images.]".

- [ ] **Step 1: Write the failing tests**

- `stripImageParts` leaves text-only messages unchanged by reference and replaces each image part with the note.
- A plain run whose seeing primary fails on its first attempt fails over to a provider without the capability. The second request body contains no `image_url` and contains the note.

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/lib/server/services/vision/turn-images.test.ts src/lib/server/services/normal-chat-model/index.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In both `attemptParams` blocks, use `messages: providerCanSeeImages(currentProvider) ? params.messages : stripImageParts(params.messages)`.

- [ ] **Step 4: Run the tests and check**

Same command; expected PASS. Then `npm run check`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/vision src/lib/server/services/normal-chat-model
git commit -m "Strip pictures from a failover attempt on a model that cannot see"
```

### Task 5: Images without text can be sent

**Files:**
- Modify: `chat-turn/preflight.ts` (`validateAttachmentReadiness` :297, `prepareChatTurn` :96); `knowledge/store/attachments.ts` (`assertPromptReadyAttachments` :486); `src/lib/components/chat/composer-chip-presentation.ts` (`extractionChipState` :219, `attachmentChipFailure` :336); `MessageInput.svelte` (`hasUnreadyAttachment` :590, chip status :701); `routes/(app)/knowledge/_components/documents-table.ts` (`extractionDetailKey`) and `DocumentsList.svelte` (`statusContent`, about :1292); `src/lib/i18n/chat.ts`, `src/lib/i18n/knowledge.ts`
- Test: `chat-turn/preflight.test.ts` (gate tests :361), `knowledge/store/attachments.test.ts`, `composer-chip-presentation.test.ts`, the documents-table test

**Interfaces:**
- Consumes: `modelIdCanSeeImages` (Task 3); `supportsImages` on the selected model (Task 1).
- Produces:
  - `assertPromptReadyAttachments(userId: string, attachmentIds: string[], options?: { exemptImages?: boolean })`. With `exemptImages`, image-category attachments never raise `attachment_extraction_pending`, `attachment_extraction_failed` or `no_usable_text`.
  - `attachmentChipFailure(chip, options: { selectedModelSupportsImages: boolean })`

- [ ] **Step 1: Write the failing tests**

- Preflight with a seeing model passes an image whose job failed with `empty_result`, an image with `no_usable_text`, and an image whose MinerU job is still `queued`, without waiting. The same inputs with a non-seeing model fail exactly as today.
- The chip for an image with `empty_result` and `selectedModelSupportsImages: true` has no failure and the label key `chat.extraction.imageNoText`. With `false` it is unchanged. A PDF with `empty_result` is unchanged either way.
- The library row for an image with `empty_result` shows `knowledge.extraction.status.noText` and `knowledge.extraction.error.imageNoText`. A PDF keeps "Failed".

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/lib/server/services/chat-turn/preflight.test.ts src/lib/server/services/knowledge/store/attachments.test.ts src/lib/components/chat/composer-chip-presentation.test.ts "src/routes/(app)/knowledge/_components"`
Expected: FAIL.

- [ ] **Step 2b: Add the strings**

- `chat.extraction.imageNoText`: "No text in this image" / "Nincs szöveg a képen"
- `knowledge.extraction.status.noText`: "No text" / "Nincs szöveg"
- `knowledge.extraction.error.imageNoText`: "This image has no text in it." / "Ezen a képen nincs szöveg."

- [ ] **Step 3: Implement**

- `prepareChatTurn` resolves `modelIdCanSeeImages(request.modelId)` once and passes `exemptImages` through `validateAttachmentReadiness`. Atlas preflight keeps today's behaviour.
- In the composer, image chips stop blocking Send when the selected model has `supportsImages`. Other chips are unchanged.
- `serializeBudgetedAttachments` skips image items that have no prompt artifact.

- [ ] **Step 4: Run the tests and check**

Same command plus `npx vitest run src/lib/i18n`; expected PASS. Then `npm run check`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/chat-turn src/lib/server/services/knowledge src/lib/components/chat "src/routes/(app)/knowledge/_components" src/lib/i18n
git commit -m "Let a model that can see take images with no text in them"
```

### Task 6: Descriptions instead of pixels in history

**Files:**
- Create: `drizzle/<next>_image_descriptions.sql` and its `drizzle/meta/_journal.json` entry; `vision/descriptions-store.ts`, `vision/describe.ts`, and their tests
- Modify: `src/lib/server/db/schema.ts`; `src/lib/server/services/account-lifecycle/user-scoped-tables.ts`; `chat-turn/context-selection.ts` (attachments narrowed at :1284); `chat-turn/conversation-history.ts` (`HistoryMessage.attachments` :27, `userText` :184); `prepareOutboundContext` (schedule descriptions); `tests/integration/english-request-purity.test.ts` (`MODEL_CALLERS` :579)
- Test: `vision/descriptions-store.test.ts`, `vision/describe.test.ts`, `chat-turn/conversation-history.test.ts`

**Interfaces:**
- Consumes: `TurnImage`, `providerCanSeeImages` (Task 3).
- Produces:
  - Table `image_descriptions`: `artifact_id` text primary key referencing `artifacts(id)` on delete cascade; `user_id` text not null referencing `users(id)` on delete cascade; `description` text not null; `model_name` text not null; `created_at` integer not null; an index on `user_id`.
  - `getImageDescriptions(userId: string, artifactIds: readonly string[]): Promise<Map<string, string>>`
  - `saveImageDescription(params: { userId: string; artifactId: string; description: string; modelName: string }): Promise<void>`, which inserts or ignores
  - `describeImage(params: { provider: NormalChatModelRunProvider; image: PreparedImage; signal?: AbortSignal }): Promise<string>`
  - `scheduleImageDescriptions(params: { userId: string; provider: NormalChatModelRunProvider; images: readonly TurnImage[] }): void`
  - `IMAGE_DESCRIPTION_PROMPT`: "Describe this image for someone who cannot see it, in at most 60 words. Name the main subject, the setting and any visible text, and quote short text exactly. Use plain sentences."
  - `HistoryMessage.attachments: Array<{ name: string; description?: string }>`

- [ ] **Step 1: Write the failing tests**

- The store saves, reads back by id, and ignores a second save for the same artifact.
- `describeImage` (injected fetch) sends one user message with the prompt text and one `image_url` part, caps output at 160 tokens, and returns the trimmed text. An empty reply throws.
- `scheduleImageDescriptions` skips artifacts that already have a description. Two schedules for the same artifact in flight produce one call (Review Focus 1).
- Review Focus 4: a describe call that rejects stores nothing and throws nothing to the caller.
- `userText` renders `[image: kitchen.jpg: A small white kitchen with a window.]` when a description exists and `[attachment: kitchen.jpg]` when it does not.
- Deleting the artifact row removes its description (foreign keys are on).

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/lib/server/services/vision src/lib/server/services/chat-turn/conversation-history.test.ts src/lib/server/services/account-lifecycle`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Write the migration by hand, following `drizzle/1777140000058_provider_model_guide_no_cost.sql` for style. Append the journal entry `{"idx":<next idx>,"version":"7","when":<file number>,"tag":"<file stem>","breakpoints":true}`.
- `describeImage` uses `generateText` with the provider from `createOpenAICompatibleProviderForNormalChatModelRun`.
- `scheduleImageDescriptions` runs after the context is prepared, in the background, one call at a time per user, and logs failures.
- `context-selection.ts` keeps `artifactId` and `mimeType` on history attachments, loads descriptions for the image ones, and passes `description`.

- [ ] **Step 4: Run the tests and check**

Same command plus `npm run check:migrations`, `npx vitest run tests/integration/english-request-purity.test.ts` and `npm run check`. Expected: PASS; 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add drizzle src/lib/server/db/schema.ts src/lib/server/services/vision src/lib/server/services/account-lifecycle src/lib/server/services/chat-turn tests/integration/english-request-purity.test.ts
git commit -m "Keep a short description of each image for later turns, not its pixels"
```

### Task 7: Immich thumbnails when a question needs them

**Files:**
- Create: `vision/step-images.ts`, `vision/photo-look.ts`, and their tests
- Modify: `normal-chat-tools/photos.ts` (schema :28, `runPhotosTool` :585, `distillPhotosReadOutcome` :393); `normal-chat-tools/index.ts` (the photos registration block :2178: `metadata.viewedCount`); `chat-turn/shared-normal-chat-model-run-helpers.ts` (`createToolPack` :432 receives the queue); `normal-chat-model/index.ts` (`buildFirstStepOnlyPrepareStep` :160, wired at :1271 and :1597, composed with the vision step per attempt); `utils/tool-activity.ts` (`buildConnectorActivityItem` :1021, `VERB_KEYS` :168); `src/lib/i18n/chat.ts`; `src/lib/server/services/normal-chat-tools/tool-catalogue.en.snapshot.txt`; `tests/cross-cutting/locality-raw-never-leaves.test.ts`
- Test: `vision/photo-look.test.ts`, `vision/step-images.test.ts`, `normal-chat-tools/photos.test.ts`, `utils/tool-activity` tests

**Interfaces:**
- Consumes: `prepareImageForModel`, `THUMBNAIL_MAX_LONG_EDGE` (Task 2); `describeImage` (Task 6); `immichThumbnail(userId, connectionId, { assetId })` (`connections/providers/immich.ts:948`); `isCloudModel`, `hasLocalDistillEnabled` (`connections/locality.ts`).
- Produces:
  - `type StepImageQueue = { push(entry: { label: string; images: TurnImage[] }): void; drain(): Array<{ label: string; images: TurnImage[] }> }`
  - `createStepImageQueue(): StepImageQueue`
  - `buildVisionPrepareStep(params: { queue: StepImageQueue; providerCanSee: boolean })`, returning a `prepareStep` that appends one user message per drained entry
  - `decidePhotoLook(params: { userId: string; modelId: string; modelCanSee: boolean }): Promise<"pixels" | "describe_locally" | "withhold">`
  - `MAX_LOOK_THUMBNAILS = 8`
  - The photos schema field `look: z.boolean().optional().describe("Set true only when you must see the photos to answer, such as choosing the sharpest or best lit; you then get small thumbnails of up to 8 results.")`

- [ ] **Step 1: Write the failing tests**

- `decidePhotoLook` returns `"pixels"` for a local model that can see, and `"withhold"` for a model that cannot. For a cloud model with local summarising on, it returns `"describe_locally"` when a local seeing model exists and `"withhold"` when none does. For a cloud model with local summarising off, it returns `"pixels"`.
- `runPhotosTool` with `look: true` on a search that finds 10 photos queues 8 prepared thumbnails. The tool result says 8 thumbnails follow, and `metadata.viewedCount` is 8. With `"describe_locally"`, nothing is queued and the result carries one description per photo. With `"withhold"`, nothing is queued and the result says the photos could not be looked at.
- Review Focus 5: when 3 of 8 thumbnail downloads throw `ImmichError`, 5 are queued and `viewedCount` is 5.
- The vision `prepareStep` appends one user message after the tool result, whose content is `[text label, ...image parts]`. With `providerCanSee: false` it appends the label with `STRIPPED_IMAGE_NOTE` instead of images.
- The activity row for photos with `viewedCount: 6` reads "Looked at 6 photos" (en) and "6 fotót megnézett" (hu).
- In the locality cross-cutting test, no thumbnail bytes reach a cloud model for a person with local summarising on.

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/lib/server/services/vision src/lib/server/services/normal-chat-tools/photos.test.ts src/lib/server/utils tests/cross-cutting/locality-raw-never-leaves.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- The local model for `"describe_locally"` is `getConfig().memoryConsolidationModel`, the one `distillConnectorPayload` uses (`locality.ts:116`). It qualifies only when it is not a cloud model and `modelIdCanSeeImages` returns true for it.
- The queue is created per turn and passed through `createToolPack`.
- `normal-chat-model/index.ts` builds the vision step per attempt, so a fallback attempt passes its own `providerCanSee`.
- The label text is `Thumbnails from the photos tool, in result order: 1 = <file name or id>, 2 = ...`.
- New key `toolActivity.photosViewed`: "Looked at {count, plural, one {# photo} other {# photos}}" / "{count} fotót megnézett".
- Leave `TOOL_TEXT.photos` unchanged: the catalogue has zero headroom, and parameter text is not counted. Update the catalogue snapshot with `npx vitest run src/lib/server/services/normal-chat-tools/index.test.ts -u`.

- [ ] **Step 4: Run the tests and check**

Same command plus `npx vitest run src/lib/server/services/normal-chat-tools/index.test.ts src/lib/i18n` and `npm run check`; expected PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/vision src/lib/server/services/normal-chat-tools src/lib/server/services/chat-turn src/lib/server/services/normal-chat-model src/lib/server/utils src/lib/i18n tests/cross-cutting
git commit -m "Let Alfy look at Immich thumbnails when a question needs it (catalogue snapshot updated)"
```

### Task 8: "Looking at the image" while the reply streams

**Files:**
- Modify: `chat-turn/stream.ts` (`data-response-activity` :248); `response-activity-types.ts` (`ResponseActivityEntry` :142, add the class `viewing_images` with `count`); the client mapping of response-activity classes and `MessageBubble.svelte` :281; `src/lib/i18n/chat.ts`; the streaming run (emit the entry before the model call when `prepared.currentImages.length > 0`)
- Test: the response-activity mapping test, `chat-turn/stream` tests

**Interfaces:**
- Consumes: `PreparedModelContext.currentImages` (Task 3).
- Produces: the response-activity class `viewing_images` with `count: number`, and the key `chat.responseActivity.viewingImages`: "Looking at {count, plural, one {the image} other {# images}}…" / "{count, plural, one {Megnézem a képet…} other {Megnézem a # képet…}}"

- [ ] **Step 1: Write the failing tests**

- A streaming turn with 2 current images emits one `data-response-activity` entry of class `viewing_images` with `count: 2` before the first text delta. A turn with none emits none.
- The client maps the entry to "Looking at 2 images…" in English and "Megnézem a 2 képet…" in Hungarian.

- [ ] **Step 2: Run, implement, run again**

Run: `npx vitest run src/lib/server/services/chat-turn src/lib/components/chat src/lib/i18n` before and after; expected FAIL, then PASS. Then `npm run check`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/server/services/chat-turn src/lib/components/chat src/lib/i18n
git commit -m "Say when Alfy is looking at the attached images"
```

### Task 9: End-to-end spec

**Files:**
- Create: `tests/e2e/vision.spec.ts`
- Test: the spec itself

**Interfaces:**
- Consumes: everything above. Use `createOpenAICompatibleProviderHarness()` (`tests/mocks/ai-provider/openai-compatible-provider.ts`), whose `requests()` returns the full outbound bodies. Make a temporary provider and model through `/api/admin/providers` and `.../models/batch`, as `fake-provider-chat.spec.ts:99` does. Clean them up with `deleteProvidersWithPrefix`.

- [ ] **Step 1: Write the spec**

- In the admin model form, tick "Can see images" on the temporary model, save, reload, and see it still ticked.
- Select that model and attach a small PNG through the real upload routes. The e2e build has no MinerU, so the extraction never succeeds, but the image chip does not block Send. Send it. The last request body's last user message contains an `image_url` part starting `data:image/jpeg;base64,`.
- Untick the setting and attach the same PNG to a new chat. Send stays disabled, as it is today for an image whose text is not ready.
- Send a follow-up in the first chat after `image_descriptions` has a row for the artifact (insert one through the test database helper). The follow-up's request body has no `image_url` in the older user turn, and contains `[image: <name>: <description>]`.

- [ ] **Step 2: Run the spec on its own**

Run: `npm run build` and then `npx playwright test tests/e2e/vision.spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/vision.spec.ts
git commit -m "Cover seeing images end to end"
```

### Task 10: Full gate, then the owner's check on ai.dev

- [ ] **Step 1: Run the agent gate once**

Run: `scripts/gates.sh agent "$TMPDIR/alfyai-gates" --port 4600 tests/e2e/vision.spec.ts tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts tests/e2e/conversation.spec.ts tests/e2e/composer-chips.spec.ts tests/e2e/settings-admin.spec.ts`
Expected: every step exits 0. The build reports zero warnings. Fallow reports no finding beyond its baseline (the four known cycles).

- [ ] **Step 2: Stop and hand over**

Nothing is pushed or deployed without the owner's explicit request. Once the owner asks for a deploy to ai.dev, check the design's "Done when" (section 4.4) there with the real Flash-Next, after ticking "Can see images" on ai.dev's `model1` row:
- a photo with no text gets a correct description;
- a screenshot is read correctly;
- "which of these has the best light?" over Immich results names one photo;
- a 20-turn chat with 10 images keeps its prompt bounded (vLLM prompt-token counts flat for the old images);
- a model without the setting behaves as before, plus the one-line note.
