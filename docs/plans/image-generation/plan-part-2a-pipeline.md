# Images Part 2a: The Picture Pipeline Implementation Plan

> **Draft, 2026-10-27.** The owner's answers to the plan's own calls in [`plan-part-2-images.md`](./plan-part-2-images.md) are folded in, except call 5 (pictures and chat deletion), which waits on one more answer.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the server, any chat can make and change pictures: the pictures of a message are numbered, a `make_image` tool queues takes on the job engine, a ComfyUI client renders them (against a fake ComfyUI until plan 2c installs the real one), pixel guards keep the rest of the picture in place, and each take lands as a version of a sixth artifact kind, Image.

**Architecture:** A new `src/lib/server/services/images/` folder holds the ComfyUI client and its fake (`comfyui/`), the graph templates, canvas and seed rules, the pixel guards (`guards/`), the picture file store, the cards and takes, the job kind and its runner, and the turn's numbered pictures. The tool adapter is `normal-chat-tools/make-image.ts`. The Image kind joins the artifact family's registries; a version's body is JSON that points at PNG files.

**Tech Stack:** TypeScript, SQLite with hand-written Drizzle migrations, the job engine (`services/jobs`), sharp 0.35.5, Node 22's global `WebSocket`, zod 4, `ai` 6.0.193, vitest, Playwright.

**Spec:** `docs/plans/image-generation/design.md` section 5 (with sections 6 to 9). The index, the shared Global Constraints and the plan's own calls are in [`plan-part-2-images.md`](./plan-part-2-images.md).

## Global Constraints

The shared list in `plan-part-2-images.md` applies to every task. This plan adds:

- `COMFYUI_URL` is admin configuration, like `MINERU_API_URL`: the client calls it with plain `fetch` through an injectable `fetchImpl` (the MinerU client's pattern, `services/mineru/client.ts`), never through `$lib/server/outbound`, and sends only the app's own files and graphs. Nothing the model writes becomes an address (ADR-0068).
- The ComfyUI routes the app uses, and the only ones the fake implements: `POST /upload/image`, `POST /prompt`, `GET /queue`, `POST /queue` (delete), `POST /interrupt`, `GET /history/{prompt_id}`, `GET /view`, `POST /free`, `GET /system_stats`, and the `/ws?clientId=` event stream.
- `POST /interrupt` is sent only when `GET /queue` shows our own prompt running: the other app may be the one rendering.
- Nothing outside `services/jobs/` writes a lifecycle column of `image_jobs` or inserts into it (`jobs/one-writer.test.ts`).
- `services/artifacts/` imports `images/files.ts` only; nothing in `images/` re-exports through a module the artifacts facade imports (no cycle).
- Picture files live under `data/image-files/<conversationId>/`, with `storage_path` stored relative to the working directory like every other writer's; `data/image-files` joins `storageRoots()` (`src/lib/server/storage-containment.ts`) and every unlink goes through `resolveDeletablePath`.

## Review Focus

1. **ComfyUI down, or restarted mid-render.** The take fails within seconds with a retryable code (not after the 100 s wait), and a restart mid-render resumes the same prompt or resubmits once. Tests in Task 8.
2. **The same picture reaching a turn twice** (attached with Attach and also open in the panel; the same upload twice): it gets one number, is sent once and is one input to Qwen. Test in Task 11.
3. **The composer's Stop while our prompt waits behind the other app's.** Our prompt is deleted from ComfyUI's queue and the take ends cancelled; a take that has started rendering is left to finish. Test in Task 13.
4. **Parallel options finishing together** ("show me four"): exactly one becomes the version in use; the others stay takes to pick. Test in Task 9.
5. **The Image item, or the whole chat, deleted while a take renders.** Nothing is brought back to life and no file stays on disk. Tests in Tasks 7 and 9.

---

## File structure

Created (under `src/lib/server/services/images/` unless a path says otherwise):
- `AGENTS.md`: the folder's rules (Global Constraints above, the card and take rules from Task 9, the tool rules from Tasks 12 and 13), kept under 40 lines.
- `comfyui/types.ts`, `comfyui/client.ts`: the one ComfyUI client. `comfyui/testing/fake-comfyui.ts`: the fake (real HTTP and WebSocket on a loopback port, the MinerU fake's shape).
- `comfyui/templates.ts`, `comfyui/graphs/reference-generate.api.json`, `comfyui/graphs/reference-edit.api.json`: graph templates and their slot maps.
- `canvas.ts`, `seeds.ts`: picture sizes and seeds.
- `guards/raw-image.ts`, `guards/align.ts`, `guards/change-mask.ts`, `guards/composite.ts`, `guards/guard-edit.ts`, `guards/thresholds.ts`: the pixel guards.
- `src/lib/shared/artifacts/image-body.ts`: the version body, marks and their colours (browser-safe).
- `src/lib/server/services/artifacts/serialize/image.ts`: the body's serializer for the family.
- `files.ts`; `src/routes/api/images/files/[fileId]/+server.ts`: picture files and the route that serves them.
- `take-request.ts`, `image-job.ts`, `image-runner.ts`, `idle-free.ts`, `testing/run-takes.ts`: takes on the job engine.
- `cards.ts`, `read-model.ts`; routes `src/routes/api/images/takes/[takeId]/{use,stop,retry}/+server.ts`, `src/routes/api/images/cards/[cardId]/another/+server.ts`; `src/lib/client/api/images.ts`.
- `marks.ts`, `turn-pictures.ts`: the turn's numbered pictures and the marked copy.
- `requests.ts`, `inputs.ts`, `turn-takes.ts`, `wait.ts`; `src/lib/server/services/normal-chat-tools/make-image.ts`: the tool.
- `drizzle/<next>_image_files.sql`, `drizzle/<next+1>_image_jobs.sql` and their journal entries.
- `tests/e2e/images-pipeline.spec.ts`.
- A test file beside every new module.

Modified, by task: `vision/turn-images.ts`, `vision/step-images.ts`, `vision/photo-look.ts`, `normal-chat-context.ts` (Task 1); `env.ts`, `config-store.ts`, `admin-config-registry.ts`, settings pages map, `tool-health/`, `client/degraded-capabilities.ts`, i18n (Task 2); root `AGENTS.md`, `services/AGENTS.md` (Task 3); `shared/artifacts/{kinds,tours,history,version-summaries}.ts`, `artifacts/{types,record,catalogue,read-model}.ts`, `artifacts/moments/detail.ts`, `artifacts/serialize/index.ts`, `knowledge/store/documents.ts`, `workspace-search.ts`, `cleanup/conversation-cleanup.ts`, `components/artifacts/kind-icons.ts`, `history/moment-text.ts`, `DocumentsList.svelte`, `utils/tool-activity.ts`, i18n (Task 6); `schema.ts`, `storage-containment.ts`, `account-lifecycle/`, `account-data-archive/index.ts`, `artifacts/record.ts`, `artifacts/library-delete.ts` (Task 7); `schema.ts`, `hooks.server.ts`, `account-lifecycle/` (Task 8); `conversation-detail/` (Task 10); `chat-turn/{request,types,preflight,context-selection,conversation-history,finalize,finalize-steps,retry,shared-normal-chat-model-run-helpers,plain-normal-chat-model-run,streaming-normal-chat-model-run}.ts`, `messages.ts`, `client/normal-chat-client-turn-runtime.ts`, `services/streaming.ts` (Task 11); `normal-chat-tools/{index,shared}.ts` and the catalogue snapshot, `vision/prepare-image.ts`, `utils/tool-calls.ts`, `utils/tool-activity.ts` (Task 12); `chat-turn/stream-idle-timeout.ts`, `chat-turn/stream-orchestrator.ts` (Task 13); the mock provider, `README.md`, `.env.example`, `tests/AGENTS.md` (Task 14).

---

### Task 1: Number and label the pictures of a message

Part 1's binding follow-up: the model must be able to tie "picture 2" to a picture.

**Files:**
- Modify: `src/lib/server/services/vision/turn-images.ts` (`TurnImages`, `collectTurnImages`, `buildTurnImageGuidance`, `heldBackImagesGuidance`, `buildCurrentUserMessage`), `vision/step-images.ts` (`buildVisionPrepareStep`), `vision/photo-look.ts` (`labelNameOf` uses the shared `oneLineName`), `src/lib/server/services/normal-chat-context.ts` (the image guidance lines), `vision/AGENTS.md` (one bullet: pictures are numbered)
- Test: `vision/turn-images.test.ts`, `vision/step-images.test.ts`, `vision/photo-look.test.ts`, `normal-chat-model/index.test.ts`, `tests/integration/vision-current-turn.test.ts`

**Interfaces:**
- Produces, in `vision/turn-images.ts`:
  - `type LabelledPicture = { number: number; name: string; image: PreparedImage }`
  - `type NumberedTurnImage = TurnImage & { number: number }`; `type NumberedName = { number: number; name: string }`
  - `TurnImages.images: NumberedTurnImage[]`, `TurnImages.heldBack: NumberedName[]`, `TurnImages.notShown: NumberedName[]` (and `PreparedModelContext.currentImages: NumberedTurnImage[]`)
  - `pictureLabel(number: number, name: string): string`, `oneLineName(name: string, maxChars?: number): string` (default 80)
  - `buildCurrentUserMessage(text: string, pictures?: readonly LabelledPicture[]): ModelMessage`
  - `buildStepImagesMessage(label: string, images: readonly TurnImage[]): UserModelMessage`
  - `heldBackImagesGuidance(pictures: readonly NumberedName[]): string`, `notShownImageGuidance(picture: NumberedName): string` (exported)

- [ ] **Step 1: Write the failing tests**

```ts
// vision/turn-images.test.ts
const image = { base64: "QUJD", mediaType: "image/jpeg" as const, width: 10, height: 10, estimatedTokens: 1 };
it("puts each picture's label right before it", () => {
	expect(buildCurrentUserMessage("hi", [{ number: 1, name: "a.jpg", image }, { number: 2, name: "b.png", image }]).content).toEqual([
		{ type: "text", text: "hi" },
		{ type: "text", text: "Picture 1: a.jpg" },
		{ type: "image", image: "QUJD", mediaType: "image/jpeg" },
		{ type: "text", text: "Picture 2: b.png" },
		{ type: "image", image: "QUJD", mediaType: "image/jpeg" },
	]);
});
it("numbers every image attachment in attachment order, one that cannot be shown included", async () => {
	// real temp files, attached in this order: a.jpg, notes.pdf, old.bmp, c.png
	const turn = await collectTurnImages({ items, maxImages: 8 });
	expect(turn.images.map(({ number, name }) => [number, name])).toEqual([[1, "a.jpg"], [3, "c.png"]]);
	expect(turn.notShown).toEqual([{ number: 2, name: "old.bmp" }]);
});
it("names held-back pictures by number", () => {
	expect(heldBackImagesGuidance([{ number: 9, name: "a.jpg" }, { number: 10, name: "b.jpg" }]))
		.toBe("Not sent as pictures because of the limit: Picture 9: a.jpg; Picture 10: b.jpg.");
});
it("says which numbered picture could not be shown", () => {
	expect(notShownImageGuidance({ number: 2, name: "old.bmp" }))
		.toBe("Picture 2: old.bmp was attached, but it could not be shown to you.");
});
it("one-lines a name and cuts it by code points", () => {
	expect(oneLineName("kitchen\n photo.jpg")).toBe("kitchen photo.jpg");
	expect(oneLineName("😀".repeat(100))).toBe(`${"😀".repeat(77)}...`);
});
```

- `step-images.test.ts`: "keeps a step's thumbnails under their own label, without picture numbers": the appended message's content is `[{ type: "text", text: <label> }, image part, image part]`.
- `vision-current-turn.test.ts`: attachments sent in the order `b.png`, `a.jpg` reach the outbound body as `Picture 1: b.png` and `Picture 2: a.jpg`, each text part directly before its `image_url` part.
- `normal-chat-model/index.test.ts`: in the outbound body, the text part `Picture 1: <name>` directly precedes the `image_url` part.

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/lib/server/services/vision src/lib/server/services/normal-chat-model/index.test.ts tests/integration/vision-current-turn.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

A picture's number is its place among the message's image-category attachments (`attachedImagesOf` order: attachment order, deduplicated), whether or not it is seeable or sent, so the server and the composer's chips (plan 2b) count the same things. `oneLineName` replaces control characters and runs of whitespace with one space and cuts by code points (`Array.from`), which also fixes part 1's deferred "label truncation cuts by UTF-16 units" minor. `buildVisionPrepareStep` builds its messages with `buildStepImagesMessage` (thumbnails keep their entry label and get no "Picture N"). The held-back sentence is the numbered one above, which also retires part 1's deferred "1 more attached images were" minor.

- [ ] **Step 4: Run the tests and check**

Run: the Step 2 command, then `npx vitest run src/lib/server/services/chat-turn src/lib/server/services/normal-chat-context.test.ts tests/integration` and `npm run check`.
Expected: PASS; check 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/vision src/lib/server/services/normal-chat-context.ts src/lib/server/services/normal-chat-model/index.test.ts tests/integration/vision-current-turn.test.ts
git commit -m "Number the pictures of a message, so 'picture 2' means the same thing to the person and the model"
```

### Task 2: Settings, Tool Health and the banner's label

**Files:**
- Modify: `src/lib/server/env.ts`, `src/lib/server/config-store.ts` (`ADMIN_CONFIG_KEYS`, `RuntimeConfig`, the appliers, the export map), `src/lib/config/admin-config-registry.ts`, `src/routes/(app)/settings/_components/system/pages.ts` (`COMFYUI_URL` on `integrations`, `IMAGE_REFERENCE_CAP` on `limits`), `src/lib/server/services/tool-health/types.ts` and `registry.ts`, `src/lib/client/degraded-capabilities.ts` (`TOOL_LABEL_KEYS`), `src/lib/i18n/settings.ts`, `src/lib/i18n/chat.ts`, `README.md`, `.env.example`
- Test: `src/lib/server/env.test.ts`, the config-store tests, `tool-health/tool-health.test.ts`, `client/degraded-capabilities` test

**Interfaces:**
- Produces: `RuntimeConfig.comfyuiUrl: string` ("" means picture making is off), `RuntimeConfig.imageReferenceCap: number`; `getImageReferenceCap(): number` and `isImageMakingConfigured(config: Pick<RuntimeConfig, "comfyuiUrl">): boolean` in `config-store.ts`; `ToolHealthConfig` gains `"comfyuiUrl"`; a registry entry `{ id: "make_image", name: "make_image", backend: "ComfyUI" }`. The cap is the server's alone: the browser never reads it (the composer has no picture cap, Global Constraints).

- [ ] **Step 1: Write the failing tests**

- `env.test.ts`: `COMFYUI_URL` unset gives `""`; `IMAGE_REFERENCE_CAP` unset gives `4`, `"12"` gives `10`, `"0"` gives `1`, `"abc"` gives `4`.
- config-store: an admin override `IMAGE_REFERENCE_CAP: "7"` makes `getImageReferenceCap()` return 7; `validateAdminConfigValue` refuses `"11"` and `"0"` for it and accepts `http://127.0.0.1:8188` for `COMFYUI_URL`.
- tool health: with `comfyuiUrl: ""` the `make_image` report is `unconfigured`; a probe answered 200 on `/system_stats` is `healthy`; a refused connection is `degraded` with a detail.
- `degradedToolLabels([{ tool: "make_image" }], t)` returns "Making pictures" (en) and "Képkészítés" (hu).

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/lib/server/env.test.ts src/lib/server/config-store src/lib/server/services/tool-health src/lib/client`
Expected: FAIL.

- [ ] **Step 3: Implement**

Follow `MINERU_API_URL` through env, config store, registry (`{ kind: "url" }`, `effect: "live"`, group `integrations`) and pages map. `IMAGE_REFERENCE_CAP`: `int(1, 10, "count")`, `effect: "live"`, group `limits`; the parser clamps into 1..10 and falls back to 4. The probe is `GET <comfyuiUrl>/system_stats` through `httpProbe` with `expectOk`. Strings:
- `admin.system.keys.COMFYUI_URL.label`: "Picture server" / "Képszerver"; `.meaning`: "The ComfyUI server that makes pictures. Leave empty to turn picture making off." / "A képeket készítő ComfyUI-szerver. Üresen hagyva nincs képkészítés."
- `admin.system.keys.IMAGE_REFERENCE_CAP.label`: "Source pictures per image" / "Forrásképek egy képhez"; `.meaning`: "How many pictures Alfy may use to make or change one image, from 1 to 10. Each extra picture costs the picture server about 2 GiB. A message itself may hold more." / "Egy kép elkészítéséhez vagy módosításához legfeljebb ennyi képet használhat Alfy (1–10). Minden további kép kb. 2 GiB-ot kér a képszervertől. Egy üzenetben ennél több kép is lehet."
- `chat.degradedBanner.tool.make_image`: "Making pictures" / "Képkészítés"

README: a "Picture server" paragraph (what `COMFYUI_URL` is, that empty turns the tool off, the cap). `.env.example`: both keys, commented, with defaults.

- [ ] **Step 4: Run the tests and check**

Run: the Step 2 command, `npx vitest run src/lib/i18n "src/routes/(app)/settings"` and `npm run check`.
Expected: PASS; 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/env.ts src/lib/server/config-store.ts src/lib/config src/routes/\(app\)/settings/_components/system/pages.ts src/lib/server/services/tool-health src/lib/client/degraded-capabilities.ts src/lib/server/services/app-shell.ts src/lib/i18n README.md .env.example
git commit -m "Add the picture server address and the cap on source pictures per image, and watch ComfyUI in Tool Health"
```

### Task 3: The fake ComfyUI and the ComfyUI client

**Files:**
- Create: `images/AGENTS.md`, `images/comfyui/types.ts`, `images/comfyui/client.ts`, `images/comfyui/client.test.ts`, `images/comfyui/testing/fake-comfyui.ts`
- Modify: root `AGENTS.md` (Folder Rules: `src/lib/server/services/images/`, one line), `src/lib/server/services/AGENTS.md` (the folder's role line and its "Rules In Other Files" line)

**Interfaces:**
- Produces, in `comfyui/types.ts` and `comfyui/client.ts`:

```ts
export type ComfyImageRef = { filename: string; subfolder: string; type: "input" | "output" | "temp" };
export type ComfyGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
export type ComfyEvent =
	| { type: "queued"; ahead: number }
	| { type: "started" }
	| { type: "progress"; value: number; max: number }
	| { type: "done"; images: ComfyImageRef[] };
export type ComfyUiErrorCode = "unreachable" | "rejected" | "execution_failed" | "timeout" | "missing_result" | "bad_response";
export class ComfyUiError extends Error { readonly code: ComfyUiErrorCode; readonly detail?: unknown }
export interface ComfyUiClient {
	uploadImage(bytes: Uint8Array, name: string): Promise<ComfyImageRef>;
	submit(graph: ComfyGraph): Promise<{ promptId: string }>;
	follow(promptId: string, options: { signal: AbortSignal; deadlineMs: number; onEvent: (event: ComfyEvent) => void }): Promise<ComfyImageRef[]>;
	fetchImage(ref: ComfyImageRef): Promise<Uint8Array>;
	cancel(promptId: string): Promise<"deleted" | "interrupted" | "not_found">;
	queueSize(): Promise<number>;
	free(): Promise<void>;
	close(): void;
}
export function createComfyUiClient(options: { baseUrl: string; fetchImpl?: typeof fetch; webSocketImpl?: typeof WebSocket; pollMs?: number; requestTimeoutMs?: number }): ComfyUiClient;
```

- Produces, in `comfyui/testing/fake-comfyui.ts`: `createFakeComfyUi(options?: FakeComfyUiOptions): Promise<FakeComfyUi>` with `baseUrl`, `requests` (method, path, json body), `prompts` (id → status), `uploads` (name → bytes), `setOptions(next)`, `holdQueue(held: boolean)`, `restart()` (forgets prompts and history, keeps uploads), `close()`. Options: `steps` (default 4), `stepDelayMs` (default 5), `startDelayMs` (default 0), `fail?: "reject" | "execution"`, `render?: (input: { graph: ComfyGraph; images: Uint8Array[]; seed: number; width: number; height: number }) => Promise<Uint8Array>`.

- [ ] **Step 1: Write the failing tests** (`client.test.ts`, every test against a real `createFakeComfyUi()`)

- "uploads a picture and gets its name back": the fake's `uploads` holds the bytes; the request was multipart with `type=input` and `overwrite=true`.
- "follows a prompt to its picture": events arrive in the order `queued` (ahead 0), `started`, `progress` 1/4 to 4/4, and `follow` resolves with one output whose fetched bytes start with the PNG signature `89 50 4E 47`.
- "says how many are ahead": with the queue held, prompt A then B are submitted; B's first event is `{ type: "queued", ahead: 1 }`.
- "deletes a prompt still waiting": `cancel` answers `"deleted"` and the fake's `/queue` no longer lists it.
- "interrupts only its own running prompt": with another client's prompt running, `cancel(ours)` on our pending prompt answers `"deleted"` and the fake received no `/interrupt`; with ours running, it answers `"interrupted"`.
- "fails fast when the server is down": a client for a closed port rejects `submit` with code `"unreachable"` in under 2 s.
- "reports a graph the server refused": `fail: "reject"` rejects `submit` with code `"rejected"` and the fake's `node_errors` in `detail`.
- "reports a render that failed": `fail: "execution"` rejects `follow` with code `"execution_failed"`.
- "gives up at its deadline": `stepDelayMs: 1000`, `deadlineMs: 200` rejects with code `"timeout"`.
- "still finishes without the socket": a `webSocketImpl` whose constructor throws: `follow` resolves through polling, with no `progress` events.
- "loses a prompt the server forgot": after `restart()`, `follow` of the old id rejects with code `"missing_result"`.

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/lib/server/services/images/comfyui`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement the client**

One WebSocket per client, opened on the first `submit` (`<ws or wss>://host/ws?clientId=<uuid>`) so it is listening before the prompt is queued; `submit` sends `{ prompt, client_id }`. `follow` polls `GET /queue` (our place among `queue_running` and `queue_pending`, by each entry's number) and `GET /history/{id}` every `pollMs` (default 1000) and is done when the history entry has `outputs`; socket messages for our prompt (`execution_start`, `progress`, `execution_error`, `execution_interrupted`) only add events. A history entry whose status is `error` is `"execution_failed"`. Unknown to both `/queue` and `/history` on two polls in a row is `"missing_result"`. `cancel`: delete when pending; interrupt (body `{ "prompt_id": id }`) only when `/queue` shows ours running. Network errors map to `"unreachable"`; non-JSON or wrong-shaped answers to `"bad_response"`. `requestTimeoutMs` (default 10 000) bounds every HTTP call.

- [ ] **Step 4: Implement the fake**

Node `http` on `127.0.0.1:0`. A minimal RFC 6455 server on the `upgrade` event: answer `101 Switching Protocols` with `Sec-WebSocket-Accept = base64(sha1(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))`, then send unmasked text frames (length < 126: `[0x81, len]`; < 65 536: `[0x81, 126, len16]`; else `[0x81, 127, len64]`); ignore what the client sends except a close frame. One prompt runs at a time; while `holdQueue(true)`, nothing starts. A run emits `execution_start`, `progress` for each step (`stepDelayMs` apart), then writes its history entry and `execution_success`. The default render: with uploaded inputs (the graph's `LoadImage` nodes name them), the first input with a centred square of side 20% painted in a colour derived from the seed; without inputs, a gradient PNG at the graph's `width` and `height` tinted by the seed. Imports: Node built-ins and sharp only, so Playwright specs can import it by relative path.

- [ ] **Step 5: Write the folder's AGENTS.md and the maps**

`images/AGENTS.md` starts with the Global Constraints above (address, routes, interrupt rule, one writer, no facade cycle, storage). Root `AGENTS.md` Folder Rules gains: "`src/lib/server/services/images/` — making and changing pictures: the ComfyUI client and its fake, graphs, pixel guards, picture files, cards and takes, the image job." `services/AGENTS.md` gains the same role line.

- [ ] **Step 6: Run the tests and check**

Run: `npx vitest run src/lib/server/services/images/comfyui` then `npm run check`.
Expected: PASS; 0 errors, 0 warnings.

- [ ] **Step 7: Commit**

```bash
git add src/lib/server/services/images AGENTS.md src/lib/server/services/AGENTS.md
git commit -m "Talk to ComfyUI through one client, built and tested against a fake ComfyUI first"
```

### Task 4: Graph templates, canvas sizes and seeds

**Files:**
- Create: `images/comfyui/templates.ts`, `images/comfyui/templates.test.ts`, `images/comfyui/graphs/reference-generate.api.json`, `images/comfyui/graphs/reference-edit.api.json`, `images/canvas.ts`, `images/canvas.test.ts`, `images/seeds.ts`, `images/seeds.test.ts`

**Interfaces:**
- Consumes: `ComfyGraph` (Task 3).
- Produces:

```ts
// comfyui/templates.ts
export type GraphName = "generate" | "edit" | "generate-transparent" | "edit-transparent";
export type GraphSlot = { node: string; input: string };
export type GraphTemplate = {
	name: GraphName;
	graph: ComfyGraph;
	slots: { prompt: GraphSlot; seed: GraphSlot; steps: GraphSlot; cfg: GraphSlot; width?: GraphSlot; height?: GraphSlot; images: Array<{ load: string; encoderInput: GraphSlot }>; output: string };
};
export const QWEN_STEPS = 40;
export const QWEN_CFG = 1;
export const GRAPH_TEMPLATES: Partial<Record<GraphName, GraphTemplate>>;
export class GraphBuildError extends Error {}
export function graphFor(mode: "generate" | "edit", transparent: boolean): { template: GraphTemplate; transparentApplied: boolean } | null;
export function buildPromptGraph(template: GraphTemplate, values: { prompt: string; seed: number; width?: number; height?: number; images: string[] }): ComfyGraph;
// canvas.ts
export type CanvasSize = { width: number; height: number };
export type PictureSize = "landscape" | "portrait" | "square" | "wide" | "tall";
export const NEW_PICTURE_CANVAS: Record<PictureSize, CanvasSize>;
export function canvasForNewPicture(size: PictureSize | undefined, print: boolean): CanvasSize;
export function canvasForEdit(base: CanvasSize, print: boolean): CanvasSize;
// seeds.ts
export const SEED_MAX = 2 ** 48 - 1;
export function freshSeed(avoid: readonly number[], random?: () => number): number;
```

- [ ] **Step 1: Write the failing tests**

```ts
// canvas.test.ts
it("defaults a new picture to 1248x832", () => expect(canvasForNewPicture(undefined, false)).toEqual({ width: 1248, height: 832 }));
it("doubles each side for print", () => expect(canvasForNewPicture("tall", true)).toEqual({ width: 1536, height: 2752 }));
it("keeps a photo's shape at about 1 MP in multiples of 32", () => expect(canvasForEdit({ width: 4032, height: 3024 }, false)).toEqual({ width: 1184, height: 896 }));
it("goes to about 4 MP for print", () => expect(canvasForEdit({ width: 4032, height: 3024 }, true)).toEqual({ width: 2368, height: 1760 }));
it("never edits at exactly 1024x1024", () => expect(canvasForEdit({ width: 3000, height: 3000 }, false)).toEqual({ width: 1056, height: 1056 }));
it("keeps a panorama inside the limits", () => expect(canvasForEdit({ width: 4000, height: 1000 }, false)).toEqual({ width: 2048, height: 512 }));
// seeds.test.ts
it("never returns a seed it must avoid", () => {
	const draws = [0.5, 0.5, 0.25];
	const avoided = freshSeed([], () => 0.5);
	expect(freshSeed([avoided], () => draws.shift()!)).not.toBe(avoided);
});
it("returns a whole number between 1 and SEED_MAX", () => { /* 1000 draws with Math.random */ });
```

- `templates.test.ts`: `buildPromptGraph` writes the prompt, the seed, `QWEN_STEPS` and `QWEN_CFG` into their slots; an edit with 2 images in a 3-image template keeps 2 `LoadImage` nodes named for the uploads and removes the third node and its encoder input key; 4 images in a 3-image template throws `GraphBuildError`; the template object is unchanged afterwards (deep copy); `graphFor("edit", true)` with no transparent template returns the edit template with `transparentApplied: false`; every slot of both reference templates names a node and an input that exist.

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/lib/server/services/images/comfyui/templates.test.ts src/lib/server/services/images/canvas.test.ts src/lib/server/services/images/seeds.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`NEW_PICTURE_CANVAS`: landscape 1248x832, portrait 832x1248, square 1056x1056, wide 1376x768, tall 768x1376; print doubles each side. `canvasForEdit`: target area 1,048,576 (or 4,194,304 for print); width `round(sqrt(area × w/h) / 32) × 32`, height `round(sqrt(area × h/w) / 32) × 32`, each clamped to [256, 2752]; 1024x1024 becomes 1056x1056. `freshSeed`: `1 + floor(random() × SEED_MAX)`, drawn again while it is in `avoid`.

**Plan's call (reference graphs):** the two JSON files are ComfyUI API-format graphs in the node set ComfyUI used for Qwen-Image-Edit in 2025, a starting point only, checked against the fake and replaced in plan 2c Task 3 by the installed server's own Qwen-Image 2.1 templates:
- generate: `UNETLoader` (`unet_name: "qwen_image_2.1_int8_convrot.safetensors"`), `CLIPLoader` (`type: "qwen_image"`, the encoder file), `VAELoader`, `ModelSamplingAuraFlow`, `CLIPTextEncode` ×2 (prompt, empty negative), `EmptySD3LatentImage` (width, height), `KSampler` (seed, steps, cfg, `euler`, `simple`), `VAEDecode`, `SaveImage`.
- edit: the same loaders, three `LoadImage` nodes feeding `TextEncodeQwenImageEditPlus` (`image1`..`image3`, positive and an empty negative), `VAEEncode` of the first image as the latent, `KSampler`, `VAEDecode`, `SaveImage`.
The encoder and VAE file names are placeholders until 2c Task 3 records the installed ones; `templates.ts` says so in its header.

- [ ] **Step 4: Run the tests and check**

Run: the Step 2 command, then `npm run check`.
Expected: PASS; 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/images
git commit -m "Size every picture in multiples of 32, never edit at 1024x1024, and draw a fresh seed each take"
```

### Task 5: The pixel guards

**Files:**
- Create: `images/guards/raw-image.ts`, `guards/align.ts`, `guards/change-mask.ts`, `guards/composite.ts`, `guards/guard-edit.ts`, `guards/thresholds.ts`, and `guards/align.test.ts`, `guards/change-mask.test.ts`, `guards/guard-edit.test.ts`

**Interfaces:**
- Consumes: `CanvasSize` (Task 4). Marks reach the guard as plain boxes in fractions of the picture, `{ x, y, w, h }`, which Task 6's `ImageMark` satisfies, so this task needs nothing from it.
- Produces:

```ts
export type RawImage = { data: Uint8Array; width: number; height: number }; // RGBA, 8 bits per channel
export async function decodeRaw(bytes: Uint8Array, size?: CanvasSize): Promise<RawImage>;
export async function encodePng(image: RawImage): Promise<Buffer>;
export function estimateAlignment(result: RawImage, base: RawImage): { dx: number; dy: number; scale: number };
export async function applyAlignment(result: RawImage, base: CanvasSize, alignment: { dx: number; dy: number; scale: number }): Promise<RawImage>;
export function changeMask(before: RawImage, after: RawImage): { mask: Float32Array; changedShare: number };
export function compositeOnto(base: RawImage, top: RawImage, mask: Float32Array): RawImage;
export type GuardMeasures = { dx: number; dy: number; scale: number; changedShare: number; insideMarksShare: number | null; global: boolean; reanchored: boolean; miss: "nothing_changed" | "outside_marks" | null };
export async function guardEdit(params: { base: RawImage; anchor: RawImage | null; chainSinceAnchor: number; result: RawImage; marks: ReadonlyArray<{ x: number; y: number; w: number; h: number }> | null }): Promise<{ picture: RawImage; measures: GuardMeasures; chainSinceAnchor: number; anchorIsResult: boolean }>;
```

- `thresholds.ts` (**Plan's call**, provisional until 2c Task 5): `GUARD = { workWidth: 256, diffThreshold: 24, minComponentShare: 0.001, dilateShare: 0.02, featherShare: 0.015, globalChangeShare: 0.6, nothingChangedShare: 0.002, marksMissShare: 0.5, reanchorEvery: 4, maxShiftShare: 0.06, scaleMin: 0.94, scaleMax: 1.06, scaleStep: 0.01 } as const`.

- [ ] **Step 1: Write the failing tests** (scenes built in the test with sharp: a 1248x832 gradient with five coloured rectangles)

- align: a result shifted by dx +12, dy −8 is recovered within 1 px; a result scaled 1.03 is recovered within 0.005; a result shifted 6, 4 with a 30% area recoloured is still recovered within 1 px.
- change mask: identical images give `changedShare` 0; a 100x80 box recoloured gives a mask of at least 0.95 inside the box, 0 at the far corners, and a `changedShare` within ±25% of the dilated box's share of the frame.
- composite: where the mask is 0 the output bytes equal the base's; where it is 1 they equal the top's.
- `guardEdit`, recolour: every pixel more than the dilation away from the box equals the base's bytes; `miss` is null; `chainSinceAnchor` goes from 0 to 1.
- `guardEdit`, nothing changed (the base with ±3 noise): `miss` is `"nothing_changed"`.
- `guardEdit`, change outside the marks (mark around the left rectangle, change on the right one): `miss` is `"outside_marks"` and `insideMarksShare` < 0.5.
- `guardEdit`, global change (a 70% repaint): `global` true, the picture is the aligned result, `anchorIsResult` true, chain 0.
- `guardEdit`, re-anchor (chain 3, an anchor that differs from the base in an earlier box): outside both changed boxes the picture equals the anchor's bytes; `reanchored` true; chain 0.
- `guardEdit`, transparency: a base with a transparent margin keeps alpha 0 there.

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/lib/server/services/images/guards`
Expected: FAIL.

- [ ] **Step 3: Implement** (**Plan's call** for the method)

- Alignment: both images to grey at `workWidth`, then Sobel gradient magnitude; search scale `scaleMin..scaleMax` by `scaleStep` and shifts up to `maxShiftShare` of the width, minimising the mean absolute difference over the central 80%; refine at twice the resolution within ±2 px of the best. `applyAlignment` resizes by the scale and extracts or extends (transparent) to the base's exact size.
- Change mask at `workWidth`: per pixel the largest channel difference (alpha included) after a 3x3 box blur; above `diffThreshold` is changed; open (erode then dilate one pixel); drop components smaller than `minComponentShare`; dilate by `dilateShare` of the short side; feather by `featherShare` (a box blur); upscale to full size. `changedShare` is the mask's mean.
- `guardEdit`: align; compare with the base; `changedShare > globalChangeShare` is global (keep the aligned result whole, `anchorIsResult` true, chain 0). Otherwise, when `chainSinceAnchor + 1 >= reanchorEvery` and an anchor of the same size exists, paste onto the anchor with the mask against the anchor (`reanchored`, chain 0); else paste onto the base (chain + 1). `miss`: `nothing_changed` when `changedShare < nothingChangedShare`; `outside_marks` when marks exist and less than `marksMissShare` of the change lies inside the marks grown by 5% of the short side.

- [ ] **Step 4: Run the tests and check**

Run: the Step 2 command, then `npm run check`.
Expected: PASS; 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/images/guards
git commit -m "Keep the room in place: align each result, paste back only what changed, re-anchor every fourth change"
```

### Task 6: The Image kind in the family

Adding `"image"` to `ArtifactKind` makes every exhaustive map fail to compile; this task fills each one.

**Files:**
- Create: `src/lib/shared/artifacts/image-body.ts`, `image-body.test.ts`, `src/lib/server/services/artifacts/serialize/image.ts`
- Modify: `shared/artifacts/kinds.ts` (`ArtifactKind`, `SHIPPED_ARTIFACT_KINDS`), `shared/artifacts/tours.ts` (`ArtifactTourType = Exclude<ArtifactKind, "file" | "image">`, with the reason: design 5.3 lists what pictures get and a tour is not among them), `shared/artifacts/history.ts` (`MomentDetail` image; `MomentKind` `"user_photo"`, `"picked_take"`), `shared/artifacts/version-summaries.ts`, `artifacts/types.ts` (`RowArtifactKind`, `CreatableArtifactKind`, `ImageCardPreview`, `ArtifactCardSummary.imagePreview`), `artifacts/record.ts` (`KNOWN_KINDS`, the row-kind check `createArtifact` uses), `artifacts/serialize/index.ts`, `artifacts/catalogue.ts` (`Image`), `artifacts/read-model.ts`, `artifacts/moments/detail.ts`, `knowledge/store/documents.ts` (`parseArtifactFamilyKind`), `workspace-search.ts` (an image's content is JSON: `<> 'app'` becomes `not in ('app', 'image')`), `cleanup/conversation-cleanup.ts` (an image item always goes with its chat), `components/artifacts/kind-icons.ts` (`Image`), `routes/(app)/knowledge/_components/DocumentsList.svelte` (`Image` icon), `components/artifacts/history/moment-text.ts`, `utils/tool-activity.ts` (`ARTIFACT_KINDS`), `src/lib/i18n/artifacts.ts`, `src/lib/i18n/common.ts` (`sidebar.deleteConversationsMessage`: the sidebar's bulk delete dialog names pictures among what goes)
- Test: `image-body.test.ts`, `artifacts/record.test.ts`, `artifacts/catalogue.test.ts`, `artifacts/moments/detail.test.ts`, `shared/artifacts/version-summaries.test.ts`, `knowledge/store/documents` tests, `workspace-search` tests, `cleanup/conversation-cleanup` test, `moment-text.test.ts`, `artifact-tools` tests

**Interfaces:**
- Produces, in `shared/artifacts/image-body.ts`:

```ts
export const MARK_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
export type MarkLetter = (typeof MARK_LETTERS)[number];
export const MAX_MARKS = 8;
export type ImageMark = { letter: MarkLetter; x: number; y: number; w: number; h: number }; // fractions of the picture
export const MARK_COLOURS: Record<MarkLetter, string>;      // A #E53935, B #1E88E5, C #43A047, D #FB8C00, E #8E24AA, F #00ACC1, G #D81B60, H #6D4C41
export const MARK_COLOUR_NAMES: Record<MarkLetter, string>; // red, blue, green, orange, purple, cyan, pink, brown
export type ImageVersionBody = {
	v: 1; fileId: string; width: number; height: number; hasAlpha: boolean;
	baseFileId: string | null; sources: Array<{ fileId: string; name: string }>; marks: ImageMark[] | null;
	prompt: string | null; takeId: string | null; seed: number | null;
	anchorFileId: string | null; chainSinceAnchor: number;
};
export type PictureRef = { imageFileId: string; number: number };
export type ImageMarksRequest = { imageFileId: string; marks: ImageMark[] };
export function parseImageVersionBody(stored: string | null): ImageVersionBody | null;
export function serializeImageVersionBody(body: ImageVersionBody): string;
export function parseImageMarks(value: unknown): ImageMark[] | null;
```

- `artifacts/types.ts`: `type RowArtifactKind = Exclude<ArtifactKind, "file">` (what `CreateArtifactInput.kind` takes); `type CreatableArtifactKind = Exclude<RowArtifactKind, "image">` (what the model-facing artifact tools take: pictures are `make_image`'s); `type ImageCardPreview = { fileId: string; width: number; height: number; hasAlpha: boolean }`.
- `MomentDetail` gains `{ type: "image"; fileId: string; sourceCount: number }`.
- `VERSION_SUMMARY` gains `userPhoto: "The user's photo"`, `pickedTake: "Picked another take"`, `alfyPicture: "Alfy made the picture"`, `alfyChangedPicture: "Alfy changed the picture"`; `classifyVersionSummary` maps the first two to `"user_photo"` and `"picked_take"`, the last two to Alfy's first draft and Alfy's edit.

- [ ] **Step 1: Write the failing tests**

- `image-body.test.ts`: a body survives serialize then parse; parse refuses a missing `fileId`, a negative width and `v: 2`. `parseImageMarks` refuses two marks with the same letter, `w` under 0.02, `x + w` over 1 and nine marks.
- `isShippedArtifactKind("image")` is true; `SHIPPED_ARTIFACT_TOUR_TYPES` is unchanged.
- `createArtifact({ kind: "image", body: serializeImageVersionBody(body), … })` succeeds; `advertisedArtifactKinds()` does not contain `"image"`.
- the catalogue lists an image item as `- Image: Cosy living room (id: <id>, just now)`.
- a version row with an image body derives the detail `{ type: "image", fileId, sourceCount: 2 }`; `classifyVersionSummary("The user's photo")` gives `"user_photo"` and `("Picked another take")` gives `"picked_take"`.
- the Documents tab lists an image item with kind `"image"`, and `kindFilter: "image"` returns only it.
- Workspace Search finds an image by its title and not by `"fileid"`.
- deleting a chat deletes its image item even when another chat links to it.
- the bulk delete dialog's message names pictures, in English and Hungarian (the strings in Step 3).
- `moment-text`: `user_photo` reads "Your photo" / "A fotód"; `picked_take` "You picked another take" / "Másik változatot választottál"; an image detail with `sourceCount` 3 reads "from 3 pictures" / "3 képből", and with 1 says nothing.

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/lib/shared/artifacts src/lib/server/services/artifacts src/lib/server/services/knowledge src/lib/server/services/workspace-search.test.ts src/lib/server/services/cleanup src/lib/components/artifacts/history src/lib/server/services/normal-chat-tools/artifact-tools`
Expected: FAIL.

- [ ] **Step 3: Implement**

The serializer in `serialize/image.ts` wraps the shared parser, so the browser and the server read one shape. `read-model.ts` sets `imagePreview` from the newest body. New i18n keys: `artifacts.type.image` "Image" / "Kép"; `artifacts.history.moment.userPhoto` "Your photo" / "A fotód"; `artifacts.history.moment.pickedTake` "You picked another take" / "Másik változatot választottál"; `artifacts.history.detail.fromPictures` "from {count} pictures" / "{count} képből". The bulk delete dialog (sidebar multi-select, merged after this plan was first written) lists what goes with the chats; `sidebar.deleteConversationsMessage` becomes "Their messages, files, reports, and the Documents and pictures made in them are deleted too. This can't be undone." / "Az üzeneteik, fájljaik, jelentéseik, valamint a bennük készült dokumentumok és képek is törlődnek. Ez nem vonható vissza." (the single delete dialog lists nothing, so it stays). Bulk delete runs `deleteConversationWithCleanup` for each chat, so the cleanup rule here covers it too. Alfy's own picture summaries go through the existing Alfy-edit and first-draft headlines.

- [ ] **Step 4: Run the tests and check**

Run: the Step 2 command, `npx vitest run src/lib/i18n src/routes/\(app\)/knowledge`, then `npm run check`.
Expected: PASS; 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/artifacts src/lib/server/services/artifacts src/lib/server/services/knowledge src/lib/server/services/workspace-search.ts src/lib/server/services/cleanup src/lib/components/artifacts src/routes/\(app\)/knowledge/_components/DocumentsList.svelte src/lib/utils/tool-activity.ts src/lib/i18n
git commit -m "Make Image the family's sixth kind: a version is a small JSON body that points at its picture"
```

### Task 7: Picture files

**Files:**
- Create: `images/files.ts`, `images/files.test.ts`, `src/routes/api/images/files/[fileId]/+server.ts` and its test, `drizzle/<next>_image_files.sql` and its journal entry
- Modify: `src/lib/server/db/schema.ts` (`imageFiles`), `src/lib/server/storage-containment.ts` (`storageRoots`), `account-lifecycle/user-scoped-tables.ts`, `account-lifecycle/index.ts` (erasure), `account-data-archive/index.ts` (`EXCLUSION_NOTES`: "Pictures Alfy made or changed are not included; download them from their cards or panel."), `cleanup/conversation-cleanup.ts`, `artifacts/record.ts` (`deleteArtifact`), `artifacts/library-delete.ts`

**Interfaces:**
- Produces:
  - Table `image_files`: `id` text primary key; `user_id` text not null → `users(id)` on delete cascade; `conversation_id` text not null → `conversations(id)` on delete cascade; `artifact_id` text → `artifacts(id)` on delete set null; `role` text not null (`input`, `take`, `marked`); `width`, `height`, `size_bytes` integer not null; `has_alpha` integer not null default 0; `storage_path` text not null; `created_at` integer not null default `unixepoch()`; indexes on (`conversation_id`, `created_at`), on `artifact_id`, on `user_id`.
  - In `files.ts`: `type ImageFileRole = "input" | "take" | "marked"`; `type ImageFile = { id; userId; conversationId; artifactId: string | null; role: ImageFileRole; width: number; height: number; hasAlpha: boolean; sizeBytes: number; createdAt: number }`; `IMAGE_THUMB_LONG_EDGE = 320`; `storeImageFile(params: { userId: string; conversationId: string; artifactId?: string | null; role: ImageFileRole; png: Uint8Array }): Promise<ImageFile>`; `getImageFile(params: { userId: string; fileId: string; conversationId?: string | null }): Promise<ImageFile | null>`; `readImageFileBytes(file: ImageFile, variant: "full" | "thumb"): Promise<Uint8Array>`; `attachImageFilesToArtifact(fileIds: readonly string[], artifactId: string): Promise<void>`; `deleteImageFilesForConversation(conversationId: string): Promise<number>`; `deleteImageFilesForArtifact(artifactId: string): Promise<number>`; `deleteImageFilesForUser(userId: string): Promise<number>`.
  - Route `GET /api/images/files/[fileId]?conversationId=&variant=full|thumb&download=1`.

- [ ] **Step 1: Write the failing tests**

- storing a PNG writes `data/image-files/<conversation>/<id>.png` and `<id>.thumb.png` (long side ≤ 320) and one row; an RGBA PNG has `hasAlpha` true; JPEG bytes are refused.
- "a chat deleted while a take renders" (Review Focus 5): storing into a chat that no longer exists throws and leaves no file on disk (the row insert fails, and the two files just written are removed).
- `getImageFile`: another user's file gives null; a file of an incognito chat gives null without that chat's `conversationId` and the file with it.
- deleting the chat removes the rows and the folder; `deleteArtifact` on an image item removes its files from disk and table and leaves the chat's other files; erasing the account removes the person's picture files.
- the route answers 200 `image/png` with `Cache-Control: private, max-age=31536000, immutable` and `X-Content-Type-Options: nosniff` for the owner; 404 for another user and for an unknown id; with `download=1`, `Content-Disposition: attachment` and a file name ending in `.png` (the item's title when the file belongs to one, else `picture.png`).

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/lib/server/services/images/files.test.ts src/routes/api/images src/lib/server/services/cleanup src/lib/server/services/account-lifecycle`
Expected: FAIL.

- [ ] **Step 3: Implement**

Write the migration by hand in the style of `drizzle/1777140000119_image_descriptions.sql` and append its journal entry. `storeImageFile` checks the PNG signature, reads size and alpha with sharp, writes the picture and its thumbnail (PNG, alpha kept), then inserts the row; when the insert fails it removes both files before rethrowing. Visibility follows the artifact ownership scope's rule: the owner, and an incognito chat's files only when the request names that chat. Every unlink goes through `resolveDeletablePath`. The route is thin (`requireApiUser`, then `getImageFile` and `readImageFileBytes`).

- [ ] **Step 4: Run the tests and check**

Run: the Step 2 command, `npm run check:migrations`, `npx vitest run tests/cross-cutting/incognito-artifact-containment.test.ts`, then `npm run check`.
Expected: PASS; 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add drizzle src/lib/server/db/schema.ts src/lib/server/storage-containment.ts src/lib/server/services/images src/routes/api/images src/lib/server/services/account-lifecycle src/lib/server/services/account-data-archive src/lib/server/services/cleanup src/lib/server/services/artifacts
git commit -m "Keep every picture as a PNG the chat owns, served only to its owner, gone with the chat"
```

### Task 8: Takes on the job engine

**Files:**
- Create: `images/take-request.ts`, `images/image-job.ts`, `images/image-runner.ts`, `images/idle-free.ts`, `images/testing/run-takes.ts`, `images/image-runner.test.ts`, `images/take-request.test.ts`, `drizzle/<next+1>_image_jobs.sql` and its journal entry
- Modify: `src/lib/server/db/schema.ts`, `src/hooks.server.ts` (`startJobs([..., imageJob])`), `account-lifecycle/index.ts` (erasure cancels the person's takes), `account-lifecycle/user-scoped-tables.ts`, `images/AGENTS.md`

**Interfaces:**
- Consumes: the client (Task 3), `graphFor`, `buildPromptGraph`, `QWEN_STEPS`, `QWEN_CFG` (Task 4), `guardEdit`, `decodeRaw`, `encodePng` (Task 5), `storeImageFile`, `getImageFile`, `readImageFileBytes` (Task 7).
- Produces:
  - Table `image_cards`: `id` pk; `user_id` → users cascade; `conversation_id` not null → conversations cascade; `turn_id` text not null; `artifact_id` → artifacts set null; `title` text not null; `made_from` text not null (`words`, `photo`, `pictures`, `change`); `source_count` integer not null default 0; `picked_take_id` text; `created_at`, `updated_at`; index (`conversation_id`, `created_at`).
  - Table `image_jobs` (the takes): `...jobColumns({ userId: () => users.id })`, then `card_id` → image_cards cascade; `conversation_id` → conversations cascade; `tool_call_id` text; `origin` text not null (`turn`, `retry`, `another`); `retry_of` text; `request_json` text not null; `seed` integer not null; `held_until` integer (ms); `hidden` integer not null default 0; `phase_at` integer (ms); `queue_ahead`, `progress_percent`, `eta_seconds` integer; `result_file_id` → image_files set null; `measures_json` text; `retried` integer not null default 0; `version_number` integer; `liveClaimIndex("image_jobs_live_claim_idx", table)`; index (`card_id`, `created_at`). Table `image_job_attempts`: `...jobAttemptColumns({ jobId: () => imageJobs.id })` with `jobAttemptIndexes`.
  - In `take-request.ts`: `type StoredTakeMeasures = GuardMeasures & { chainSinceAnchor: number; anchorIsResult: boolean }` (what `measures_json` holds); `type MadeFrom = "words" | "photo" | "pictures" | "change"`; `type TakeInput = { fileId: string; role: "base" | "reference" | "marked"; name: string }`; `type TakeRequest = { v: 1; mode: "generate" | "edit"; prompt: string; inputs: TakeInput[]; baseFromUpload: boolean; canvas: CanvasSize; transparent: boolean; avoidSeeds: number[]; anchor: { fileId: string; chainSinceAnchor: number } | null; marks: ImageMark[] | null; title: string; summary: string | null }` (`baseFromUpload`: the picture being changed is the person's upload, so a new item starts with it as version 1); `parseTakeRequest(json: string): TakeRequest | null`.
  - In `image-job.ts`: `imageJob` (the kind); `enqueueTake(input: { userId: string; conversationId: string; cardId: string; toolCallId: string | null; origin: "turn" | "retry" | "another"; retryOf: string | null; request: TakeRequest; seed: number; heldUntil: number | null }): Promise<{ takeId: string }>`; `cancelTake(userId: string, takeId: string): Promise<boolean>`; `retryTake(userId: string, takeId: string): Promise<boolean>`; `cancelImageTakesForUser(userId: string): Promise<{ cancelled: number }>`; `IMAGE_RENDER_DEADLINE_MS = 600_000`.
  - In `image-runner.ts`: `runImageTake(ctx: JobRunContext<typeof imageJobs>): Promise<void>`.
  - In `idle-free.ts`: `IMAGE_IDLE_FREE_MS = 15 * 60_000`; `scheduleIdleFree(): void`.
  - In `testing/run-takes.ts`: `drainImageTakes()` for tests, as `file-production/testing/run-once.ts` does for files.

- [ ] **Step 1: Write the failing tests** (`image-runner.test.ts`, through the engine's `drain`, with `getConfig().comfyuiUrl` pointed at a real `createFakeComfyUi()`)

- "a new picture renders to a stored PNG": the take succeeds; `result_file_id` names a 1248x832 PNG; `progress_percent` is 100; the phases passed `submitted`, `starting`, `rendering`, `finishing`.
- "an edit keeps everything it did not change": the fake recolours a square; `measures_json.miss` is null; outside the dilated square the stored PNG equals the base input file's pixels.
- "writes how many are ahead": with the fake's queue held by another prompt, `queue_ahead` reaches 1 before the hold is released.
- "a stop while waiting deletes the prompt": cancelled while pending, the fake's queue no longer lists it and the take is `cancelled`.
- "a stop while rendering interrupts our own prompt": the fake received `/interrupt` with our prompt id; the take is `cancelled`.
- "ComfyUI down fails fast" (Review Focus 1): with the fake closed, the take fails within 3 s with `error_code` `image_server_unreachable`, `retryable` true, and is not requeued.
- "a refused graph is not retryable": `fail: "reject"` gives `image_graph_rejected`, `retryable` false.
- "a worker lost after submitting resumes the same prompt" (Review Focus 1): the attempt is taken back after the checkpoint was written; the next attempt follows the same prompt id and the fake saw one `/prompt`.
- "a ComfyUI restart during the resume resubmits once": after `restart()`, the take is resubmitted once and succeeds.
- "frees ComfyUI after a quiet spell": with fake timers, 15 minutes after the last take and an empty queue the fake received one `POST /free`.
- `take-request.test.ts`: a request survives stringify then parse; parse refuses a `generate` with inputs, an `edit` without a `base` first, and a canvas side not a multiple of 32.

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/lib/server/services/images/image-runner.test.ts src/lib/server/services/images/take-request.test.ts src/lib/server/services/jobs/one-writer.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the kind**

`defineJobKind({ name: "image", logPrefix: "[IMAGES]", enabled: () => isImageMakingConfigured(getConfig()), limits: () => ({ global: 6, perUser: 4 }), lease: () => ({ heartbeatMs: 10_000, staleAfterMs: 90_000 }), phases: ["submitted", "starting", "rendering", "finishing"], lostAttempt: () => ({ code: "image_worker_lost", message: "The picture worker stopped before finishing." }), onFailure: (failure, { attempts }) => failure.code === "image_worker_lost" && attempts < 3 ? { requeue: true, delayMs: 2_000 } : { requeue: false, retryable: failure.retryable }, userRetry: { from: ["failed", "cancelled"] }, handler: () => import("./image-runner").then((m) => m.runImageTake) })`. **Plan's call:** six per app so prompts reach ComfyUI at once and its queue orders them.

- [ ] **Step 4: Implement the runner**

Without a checkpoint: read the inputs' files, upload each as `<takeId>-<n>.png`, build the graph (`graphFor(request.mode, request.transparent)`; none gives `image_graph_missing`), submit, then `ctx.progress({ phase: "submitted", checkpoint: { promptId } })`. Follow with `IMAGE_RENDER_DEADLINE_MS`: `queued` writes `queue_ahead`; `started` moves to `starting`; the first `progress` moves to `rendering`; progress writes `progress_percent` and `eta_seconds` (elapsed since the first step × steps left ÷ steps done, plus 3 s) at most once a second; each phase change writes `phase_at`. Fetch the first output (`finishing`). For an edit, decode the base (and the anchor) at the canvas and run `guardEdit`; for a new picture keep the output as PNG. Store the picture (`role: "take"`), then `ctx.succeed` writing `result_file_id`, `measures_json` (the measures plus the guard's `chainSinceAnchor` and `anchorIsResult`, which Task 9 copies into the version body; null for a new picture), `progress_percent` 100. On abort with reason `"cancelled"`, call `client.cancel(promptId)` inside a listener that catches everything; on `"lease-lost"` do nothing. With a checkpoint: follow that prompt; on `missing_result`, clear the checkpoint and submit once more. Failure codes: unreachable `image_server_unreachable` (retryable), rejected `image_graph_rejected` (not), execution failed `image_render_failed` (retryable), timeout `image_render_timeout` (retryable), missing result `image_result_missing` (retryable), a missing input file `image_input_missing` (not), no address `image_server_not_configured` (not). After each take ends, `scheduleIdleFree()`: one unref'd timer on `globalThis`; when it fires with no image job queued or running in this app and `queueSize()` 0, call `free()`. **Plan's call:** 15 minutes, tuned in plan 2c Task 4.

- [ ] **Step 5: Run the tests and check**

Run: the Step 2 command, `npm run check:migrations`, `npx vitest run src/lib/server/services/jobs src/lib/server/services/account-lifecycle`, then `npm run check`.
Expected: PASS; 0 errors, 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add drizzle src/lib/server/db/schema.ts src/hooks.server.ts src/lib/server/services/images src/lib/server/services/account-lifecycle
git commit -m "Render each take as a job: queued on ComfyUI, followed to its picture, guarded, stored"
```

### Task 9: From take to version

**Files:**
- Create: `images/cards.ts`, `images/cards.test.ts`
- Modify: `images/image-runner.ts` (after `ctx.succeed`, `settleCard` unless the take is held), `src/hooks.server.ts` (on boot, `settleHeldCards()`), `images/AGENTS.md` (the card rules below)

**Interfaces:**
- Consumes: `createArtifact`, `updateArtifactBody`, `getArtifact` (artifacts facade), `serializeImageVersionBody`, `VERSION_SUMMARY` (Task 6), `attachImageFilesToArtifact` (Task 7), the take columns (Task 8).
- Produces:

```ts
export async function createCard(input: { userId: string; conversationId: string; turnId: string; artifactId: string | null; title: string; madeFrom: MadeFrom; sourceCount: number }): Promise<{ cardId: string }>;
export async function settleCard(cardId: string, options?: { preferTakeId?: string }): Promise<{ pickedTakeId: string | null; artifactId: string | null; versionNumber: number | null }>;
export async function releaseHold(takeId: string): Promise<void>;
export async function hideTake(takeId: string): Promise<void>;
export async function useTake(params: { userId: string; takeId: string; conversationId?: string | null }): Promise<{ ok: true; versionNumber: number } | { ok: false; reason: "not_found" | "not_ready" | "already_in_use" | "item_deleted" }>;
export async function replacePick(params: { cardId: string; takeId: string }): Promise<{ versionNumber: number | null }>;
export async function settleHeldCards(now?: number): Promise<number>;
export function versionBodyForTake(take: { id: string; seed: number; request: TakeRequest; measures: StoredTakeMeasures | null }, file: ImageFile): ImageVersionBody;
export function versionBodyForPhoto(file: ImageFile): ImageVersionBody; // the upload's normalized copy (the take's base input): no prompt, seed or take; its own anchor
```

**Rules (Plan's call, design 5.4):**
- A card's pick is the take in use as of that card. While a take is held (`held_until` in the future) nothing promotes it.
- `settleCard`: when the card has no pick, the winner is `preferTakeId` if eligible, else the oldest eligible take (succeeded, not hidden, not held, with a file). The claim is `UPDATE image_cards SET picked_take_id = ? WHERE id = ? AND picked_take_id IS NULL`; only the caller whose update changed a row goes on. Without an item yet: when the take's request has `baseFromUpload` (a photo, or a composition into a photo), `createArtifact` with `versionBodyForPhoto` of the base input (author `"user"`, `VERSION_SUMMARY.userPhoto`) and then `updateArtifactBody` with the take's (author `"alfy"`, the request's summary or `alfyChangedPicture`); otherwise `createArtifact` with the take's body (author `"alfy"`, the summary or `alfyPicture`). With an item: `updateArtifactBody` (author `"alfy"`). Then set `card.artifact_id`, the take's `version_number`, and attach the card's files to the item. An artifact write that fails undoes the claim; an item that no longer exists undoes the claim and leaves the card without an item.
- `useTake` on a card without a pick settles it with that take; on a card with a pick it appends the take's body as a version (author `"user"`, `VERSION_SUMMARY.pickedTake`) and moves the pick.
- `replacePick` (the model's retry of the take in use) appends the new take's body (author `"alfy"`, the old take's summary), moves the pick and hides the old take: History keeps both versions.
- `hideTake` refuses the card's pick. `releaseHold` clears `held_until`, then `settleCard`. `settleHeldCards` settles cards whose takes succeeded while held and whose hold has run out (a process that died mid-call).
- The version body carries the take's file and size, the base input as `baseFileId`, the references as `sources`, the marks, the prompt, the seed, the take id, and the anchor: a new picture (and a photo's first version) is its own anchor with chain 0; for an edit, `anchorIsResult` makes the take's file the anchor with chain 0, otherwise the request's anchor with the guard's `chainSinceAnchor` from `measures_json`.

- [ ] **Step 1: Write the failing tests**

- a held take is not promoted on landing; after `releaseHold` a words card's item exists with one version authored by Alfy.
- a photo card's item gets version 1 authored by the person, summary "The user's photo", and version 2 authored by Alfy.
- "four parallel takes give one pick" (Review Focus 4): four takes of one card succeed and `settleCard` runs for each at once (`Promise.all`): one item, one version, three takes with no version number.
- `preferTakeId` beats an older eligible take; a hidden take is never picked; `hideTake` on the pick throws.
- `useTake` on a candidate of a settled card appends a version authored by the person with "Picked another take" and moves the pick; History derives `picked_take` for it.
- `replacePick` appends a version authored by Alfy with the old summary, moves the pick and hides the old take.
- "the item deleted while a take renders" (Review Focus 5): the take lands, no item comes back, the card has no pick, nothing throws.
- `settleHeldCards` promotes a take whose hold ran out and leaves one still held.
- the version body: `baseFileId`, `sources`, `marks`, `prompt`, `seed`, `takeId`; a global change makes the anchor the take's own file with chain 0.

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/lib/server/services/images/cards.test.ts src/lib/server/services/images/image-runner.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** as the rules say.

- [ ] **Step 4: Run the tests and check**

Run: the Step 2 command, `npx vitest run src/lib/server/services/artifacts`, then `npm run check`.
Expected: PASS; 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/images src/hooks.server.ts
git commit -m "Land a take as the item's version only once its tool call is done with it, one pick per card"
```

### Task 10: The card's actions and its read model

**Files:**
- Create: `images/read-model.ts`, `images/read-model.test.ts`, `src/routes/api/images/takes/[takeId]/use/+server.ts`, `.../stop/+server.ts`, `.../retry/+server.ts`, `src/routes/api/images/cards/[cardId]/another/+server.ts`, their tests, `src/lib/client/api/images.ts`, `src/lib/client/api/images.test.ts`
- Modify: `images/cards.ts` (`anotherTake`), `src/lib/server/services/conversation-detail/types.ts` and `read-model.ts` (`imageCards`, bootstrap gives `[]`)

**Interfaces:**
- Consumes: `useTake`, `settleCard` (Task 9), `enqueueTake`, `cancelTake`, `retryTake` (Task 8), `freshSeed` (Task 4).
- Produces:

```ts
export type ImageTakePhase = "submitted" | "starting" | "rendering" | "finishing";
export type ImageTakeView = {
	id: string; status: "queued" | "running" | "succeeded" | "failed" | "cancelled"; phase: ImageTakePhase | null; phaseAt: number | null;
	queueAhead: number | null; progressPercent: number | null; etaSeconds: number | null;
	canvas: { width: number; height: number }; // the request's canvas: the card reserves this box while the take renders
	fileId: string | null; width: number | null; height: number | null; hasAlpha: boolean;
	baseFileId: string | null; sourceFileIds: string[]; retried: boolean;
	errorCode: string | null; retryable: boolean; versionNumber: number | null; toolCallId: string | null; createdAt: number;
};
export type ImageCardView = { id: string; conversationId: string; turnId: string; artifactId: string | null; title: string; madeFrom: MadeFrom; sourceCount: number; pickedTakeId: string | null; takes: ImageTakeView[] };
export async function listConversationImageCards(userId: string, conversationId: string): Promise<ImageCardView[]>;
export const MAX_VISIBLE_TAKES_PER_CARD = 8;
export async function anotherTake(params: { userId: string; cardId: string; conversationId?: string | null }): Promise<{ ok: true; takeId: string } | { ok: false; reason: "not_found" | "too_many_takes" | "not_configured" }>;
// src/lib/client/api/images.ts
export function imageFileUrl(fileId: string, options?: { variant?: "full" | "thumb"; download?: boolean; conversationId?: string | null }): string;
export async function useImageTake(takeId: string, conversationId?: string | null): Promise<{ versionNumber: number }>;
export async function anotherImageTake(cardId: string, conversationId?: string | null): Promise<{ takeId: string }>;
export async function stopImageTake(takeId: string, conversationId?: string | null): Promise<void>;
export async function retryImageTake(takeId: string, conversationId?: string | null): Promise<void>;
```

- `ConversationDetail.imageCards: ImageCardView[]`.

- [ ] **Step 1: Write the failing tests**

- the read model lists cards oldest first and their takes oldest first without hidden ones, with phase, ahead, progress, file and sizes; another user's chat gives `[]`.
- `anotherTake` copies the card's first take's request with origin `"another"` and a seed unlike every seed in the card; the ninth visible take is refused `too_many_takes`; without an address it is `not_configured`.
- routes: `use` answers 200 with the version number, 409 `not_ready` for a take not finished, 404 for another user's take; `stop` on a finished take answers 409; `retry` works from `failed` and `cancelled` only; `another` answers 201 with the take id. All accept `?conversationId=` for an incognito chat.
- `imageFileUrl("f1", { variant: "thumb", conversationId: "c1" })` is `/api/images/files/f1?variant=thumb&conversationId=c1`.
- the conversation detail carries `imageCards`.

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/lib/server/services/images/read-model.test.ts src/lib/server/services/images/cards.test.ts src/routes/api/images src/lib/client/api/images.test.ts src/lib/server/services/conversation-detail`
Expected: FAIL.

- [ ] **Step 3: Implement**

Routes are thin (`requireApiUser`, one service call, the answer). `anotherTake` enqueues without a hold; when it lands, the runner's `settleCard` makes it the pick only if the card has none.

- [ ] **Step 4: Run the tests and check**

Run: the Step 2 command, then `npm run check`.
Expected: PASS; 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/images src/routes/api/images src/lib/client/api/images.ts src/lib/client/api/images.test.ts src/lib/server/services/conversation-detail
git commit -m "Give each card Another, Use this, Stop and Try again, and send the cards with the chat"
```

### Task 11: The turn's numbered pictures, Attach and marks

The open picture, the pictures attached from cards and the person's marks become numbered pictures of the message, beside the uploads. This changes the chat send and stream contract: the request, `chat-turn/*`, the browser transport and their tests move together.

**Files:**
- Create: `images/marks.ts`, `images/marks.test.ts`, `images/turn-pictures.ts`, `images/turn-pictures.test.ts`
- Modify: `chat-turn/request.ts` and `types.ts` (`pictureRefs`, `imageMarks`), `chat-turn/preflight.ts` (ownership; no picture count check), `chat-turn/context-selection.ts` (number and prepare every picture; `MAX_TURN_IMAGES` across all of them), `normal-chat-context.ts` (`PreparedModelContext.turnPictures`; the guidance lines, the cap's among them), `vision/turn-images.ts` (the `viewing_images` count counts every picture sent), `chat-turn/shared-normal-chat-model-run-helpers.ts` (`createToolPack` takes `turnPictures`), both model-run files, `chat-turn/finalize.ts` and `finalize-steps.ts` (the user message's `pictures` metadata), `messages.ts` (`PersistedMessageMetadata.pictures`, projected as `ChatMessage.pictures`), `chat-turn/conversation-history.ts` (history lines), `chat-turn/retry.ts` (accepts both fields), `src/lib/client/normal-chat-client-turn-runtime.ts` and `src/lib/services/streaming.ts` (send both fields)
- Test: `marks.test.ts`, `turn-pictures.test.ts`, `chat-turn/request` and `preflight` tests, `conversation-history.test.ts`, `normal-chat-model/index.test.ts`, `src/lib/services/streaming.test.ts`, `tests/integration/vision-current-turn.test.ts`

**Interfaces:**
- Consumes: `PictureRef`, `ImageMarksRequest`, `parseImageMarks`, `MARK_COLOURS`, `MARK_COLOUR_NAMES` (Task 6), `getImageFile`, `readImageFileBytes`, `storeImageFile` (Task 7), `pictureLabel`, `LabelledPicture` (Task 1), `getImageReferenceCap`, `isImageMakingConfigured` (Task 2).
- Produces:

```ts
// images/marks.ts
export async function paintMarks(png: Uint8Array, marks: readonly ImageMark[]): Promise<Buffer>;
export function marksLabel(baseNumber: number, marks: readonly ImageMark[]): string; // "Picture 3 with the user's marks: A = red box, B = blue box"
// images/turn-pictures.ts
export type TurnPictureSource =
	| { type: "upload"; artifactId: string; name: string; mimeType: string | null }
	| { type: "image_file"; fileId: string; name: string; artifactId: string | null; role: "attached" | "open" | "marked"; marks?: ImageMark[] };
export type TurnPicture = { number: number; source: TurnPictureSource };
export type TurnPictureIndex = { pictures: TurnPicture[]; byNumber(number: number): TurnPicture | null };
export async function resolveTurnPictures(params: { userId: string; conversationId: string; uploads: Array<{ artifactId: string; name: string; mimeType: string | null }>; pictureRefs: readonly PictureRef[]; openImageArtifactId: string | null; marks: ImageMarksRequest | null }): Promise<TurnPictureIndex>;
```

- `ParsedChatTurnRequest.pictureRefs: PictureRef[]` (at most 10) and `.imageMarks: ImageMarksRequest | null`; `PreparedModelContext.turnPictures: TurnPictureIndex`; `UserPicturesMetadata = { refs: Array<{ imageFileId: string; number: number; name: string }>; open: { imageFileId: string; name: string } | null; marks: { imageFileId: string; markedFileId: string; letters: MarkLetter[] } | null }` on the user message, projected as `ChatMessage.pictures`.

- [ ] **Step 1: Write the failing tests**

- numbering: uploads `a` and `b` with a ref `X` at number 1 give X = 1, a = 2, b = 3; the open picture is 4, labelled `<title> (open in the panel)`; marks on it add 5, labelled `Picture 5: Picture 4 with the user's marks: A = red box`.
- "one picture, one number" (Review Focus 2): a ref whose file is the open item's version in use is numbered once; the same upload twice is numbered once.
- refs with duplicate or out-of-range numbers are renumbered after the uploads, in the order given, and the turn goes on.
- `paintMarks`: the pixel at the middle of box A's top edge is within 8 of `#E53935` on each channel; pixels well outside every box are byte-equal to the input; it works with no font installed (the letters are strokes).
- preflight: eight uploaded pictures and one ref with the cap at 4 are accepted (the cap limits a picture request, not a message; Global Constraints); a ref to another user's file answers 404; marks on a file that is neither the open picture nor a ref answer 400.
- the outbound body for a model that can see holds each picture as a `Picture N: …` text part then its `image_url` part, the open picture and the marked copy included; for a model that cannot see, no picture part, and its turn guidance lists them by number so it can still hand them to `make_image`: `Pictures in this message: Picture 1: rug.jpg; Picture 2: Cosy living room (open in the panel).`
- with the cap at 4, a message of five pictures adds the turn guidance line `make_image takes at most 4 pictures per call: pass the ones the picture needs.`, for a model that can see and one that cannot; a message of four or fewer adds no such line.
- image-file pictures never reach `scheduleImageDescriptions` (R15); `viewing_images` counts them.
- the user message's metadata keeps `pictures`; a later turn's history shows `[picture: Cosy living room]` for a ref, `[open picture: Cosy living room]` for the open one and `[marks: A, B on Cosy living room]`, never pixels.
- the browser runtime and `streaming.ts` send `pictureRefs` and `imageMarks` in the stream body; the retry route accepts them.

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/lib/server/services/images/marks.test.ts src/lib/server/services/images/turn-pictures.test.ts src/lib/server/services/chat-turn src/lib/server/services/normal-chat-model/index.test.ts src/lib/services/streaming.test.ts src/lib/client tests/integration/vision-current-turn.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`resolveTurnPictures`: refs keep their numbers; image-category uploads fill the free numbers in attachment order; the open picture comes next when `activeDocumentArtifactId` is an image item (its body's `fileId`); the marked copy last: `paintMarks` on the marked file's full picture, stored with `role: "marked"`. A model that can see gets each picture prepared with `prepareImageForModel` at `ATTACHMENT_MAX_LONG_EDGE`, in number order, up to `MAX_TURN_IMAGES`; the rest are named by `heldBackImagesGuidance`. A model that cannot see gets `CANNOT_SEE_IMAGES_GUIDANCE` and the one `Pictures in this message: …` line (an English scaffold around the names). When the message holds more pictures than `getImageReferenceCap()`, either model also gets the cap's line, only while `isImageMakingConfigured` (with no picture server there is no `make_image` to limit). The marks painter draws each box as a stroke of width `max(4, 0.006 × long side)` in its colour, with a filled tag of side `max(28, 0.035 × long side)` at the box's top-left holding the letter as white strokes on a 5x7 grid (`LETTER_STROKES` in `marks.ts`), composited with sharp from one SVG.

- [ ] **Step 4: Run the tests and check**

Run: the Step 2 command, `npx vitest run tests/integration tests/cross-cutting`, then `npm run check`.
Expected: PASS; 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/images src/lib/server/services/chat-turn src/lib/server/services/normal-chat-context.ts src/lib/server/services/vision src/lib/server/services/messages.ts src/lib/client src/lib/services tests/integration
git commit -m "Number the open picture, the pictures attached from cards and the marked copy with the uploads"
```

### Task 12: The `make_image` tool

**Files:**
- Create: `src/lib/server/services/normal-chat-tools/make-image.ts`, `make-image.test.ts`, `images/requests.ts`, `images/requests.test.ts`, `images/inputs.ts`, `images/inputs.test.ts`, `images/turn-takes.ts`, `images/wait.ts`, `images/wait.test.ts`
- Modify: `normal-chat-tools/index.ts` (`TOOL_TEXT.make_image`; the tool only when `isImageMakingConfigured`; `CreateNormalChatToolsContext.turnPictures`), `normal-chat-tools/shared.ts` (`TOOL_TIMEOUTS_MS.make_image: 120_000`), `normal-chat-tools/index.test.ts` (the full config gains `comfyuiUrl`; the tool list; the ceiling), `normal-chat-tools/tool-catalogue.en.snapshot.txt` (`-u`), `vision/prepare-image.ts` (`decodeImageToPng`), `src/lib/utils/tool-calls.ts` (`make_image` → `"artifact"` icon type), `src/lib/utils/tool-activity.ts` (the row's words), `src/lib/i18n/chat.ts`
- Test: those files' tests, `src/lib/utils/tool-activity.test.ts`

**Interfaces:**
- Consumes: `TurnPictureIndex` (Task 11), `createCard`, `releaseHold`, `settleCard` (Task 9), `enqueueTake`, `cancelTake` (Task 8), `canvasForNewPicture`, `canvasForEdit`, `freshSeed` (Task 4), `storeImageFile` (Task 7), `getImageReferenceCap` (Task 2).
- Produces:

```ts
// make-image.ts
export const makeImageInputSchema: z.ZodObject<…>; export type MakeImageInput = z.infer<typeof makeImageInputSchema>;
export type MakeImagePayload =
	| { ok: true; status: "succeeded"; takeId: string; imageId: string | null; title: string; inUse: boolean; retried: boolean; note: string }
	| { ok: true; status: "running"; takeId: string; title: string; note: string }
	| { ok: false; status: "failed"; takeId: string; errorCode: string; message: string; retryable: boolean }
	| { ok: false; errorCode: MakeImageRefusal | "not_configured"; message: string };
export const IMAGE_TOOL_WAIT_MS = 100_000;
export async function runMakeImageTool(params: { userId: string; conversationId: string; turnId: string; toolCallId: string; input: MakeImageInput; turnPictures: TurnPictureIndex | null; turnTakes: TurnTakes; requestText: string; signal: AbortSignal; onTick?: () => void; stepImages?: StepImageQueue }): Promise<{ modelPayload: MakeImagePayload; metadata: Record<string, string | number | boolean | null> }>;
// images/turn-takes.ts (one per turn, made in createNormalChatTools beside the produce_file verdict maps)
export const MAX_IMAGE_CALLS_PER_TURN = 8; export const MAX_TAKES_PER_CARD_PER_TURN = 4;
export type TurnTakeRecord = { takeId: string; cardId: string; cardKey: string; seed: number; request: TakeRequest; isRetry: boolean; retried: boolean };
export type TurnTakes = {
	countCall(): number;                                  // this call's count, the first being 1
	cardFor(cardKey: string): string | undefined;
	rememberCard(cardKey: string, cardId: string): void;
	noteTake(record: Omit<TurnTakeRecord, "retried">): void;
	takesInCard(cardId: string): number;                 // visible takes this turn
	take(takeId: string): TurnTakeRecord | undefined;
	markRetried(takeId: string): void;
};
export function createTurnTakes(): TurnTakes;
// images/requests.ts
export type MakeImageRefusal = "unknown_picture" | "too_many_pictures" | "too_many_takes" | "too_many_calls" | "retry_unknown" | "retry_twice";
export async function resolveMakeImageRequest(params: { userId: string; conversationId: string; input: MakeImageInput; turnPictures: TurnPictureIndex | null; turnTakes: TurnTakes; requestText: string }): Promise<{ ok: true; plan: TakePlan } | { ok: false; refusal: MakeImageRefusal; message: string }>;
export type TakePlan = { cardKey: string; cardId: string | null; artifactId: string | null; madeFrom: MadeFrom; title: string; sourceCount: number; request: TakeRequest };
// images/inputs.ts
export type PictureSourceRef =
	| { kind: "upload"; artifactId: string; mimeType: string | null; name: string }
	| { kind: "image_file"; fileId: string; name: string };
export async function prepareTakeInputs(params: { userId: string; conversationId: string; base: PictureSourceRef | null; references: PictureSourceRef[]; marked: { source: PictureSourceRef; marks: ImageMark[] } | null; canvas: CanvasSize }): Promise<TakeInput[]>;
// images/wait.ts
export type TakeSnapshot = { takeId: string; status: "queued" | "running" | "succeeded" | "failed" | "cancelled"; phase: ImageTakePhase | null; resultFileId: string | null; measures: StoredTakeMeasures | null; errorCode: string | null; retryable: boolean };
export async function waitForTake(takeId: string, options: { budgetMs: number; signal: AbortSignal; onTick?: () => void }): Promise<TakeSnapshot>;
// vision/prepare-image.ts
export async function decodeImageToPng(input: Uint8Array, mimeType: string | null): Promise<{ png: Buffer; width: number; height: number; hasAlpha: boolean }>;
```

**The tool's words (Plan's call 1).** `TOOL_TEXT.make_image.description`, exactly:

> Make a new picture from words, or change one: a picture in this message (its number) or an Image from "In this chat" (its id). One picture per call; for options, repeat the call (up to 4). Write `prompt` in English: what changes and what stays. Do not use it to find, show or describe existing pictures.

`errorPrefix`: "Making the picture failed". Parameters (zod, with these `.describe()` texts):
- `prompt` (1 to 2,000 chars): "The instruction for the picture model, in English: what to make or change, and what must stay as it is. Refer to `pictures` as <image1>, <image2> in their order."
- `pictures` (≤ 10 strings): "Pictures to start from: a picture number from this message (\"3\") or an Image id from \"In this chat\". Put the picture being changed first. When the user says \"it\", it is the picture open in the panel, else the newest Image in \"In this chat\"." (design 5.4)
- `title` (≤ 80): "For a new picture: a short title in the conversation's language."
- `summary` (≤ 200): "What you changed, in the conversation's language: one short past-tense line with no subject and never in the first person; shown in History." (the words `edit_artifact` uses)
- `size` (`landscape`, `portrait`, `square`, `wide`, `tall`): "Only for a new picture, when the user's words ask for a shape (\"for my phone\" is tall). A change keeps its picture's shape."
- `print` (boolean): "True only when the user wants print or wallpaper quality (about 4 MP, slower)."
- `transparent` (boolean): "True when the user wants a cut-out on a transparent background."
- `startNew` (boolean): "True to start a separate picture even though the first picture is an existing Image."
- `retryOf` (≤ 64): "A takeId from this turn whose result clearly missed: makes it again once; the better one is kept."

**Resolution (Plan's call 7).** A picture number resolves through `turnPictures`; an id resolves only to an Image item reachable from this chat (its body's `fileId`). More pictures than `getImageReferenceCap()` is `too_many_pictures`, with the message `make_image takes at most <cap> pictures per call. Pass the ones the picture needs, or ask the user which.` This is the only place the cap applies (Plan's call 10). The card key: `retryOf`'s card; else, when the first picture is an Image item's picture and `startNew` is not set, `item:<artifactId>`; else `new:<sha256 of prompt, pictures, size, print, transparent>`. The base of an item is this turn's newest unhidden finished take on that item's card, else the item's version in use; `avoidSeeds` holds the base version's seed; the anchor is the base body's anchor (or its own file) with its chain. `baseFromUpload` is true when the first picture is an upload. `madeFrom`: no pictures `words`; an upload with nothing else but its marked copy `photo`; an item's picture with nothing else but its marked copy `change`; else `pictures` (`sourceCount` counts the pictures other than the marked copy). The title falls back to the first eight words of the person's message (`requestText`), which are in their language.

- [ ] **Step 1: Write the failing tests** (`make-image.test.ts` with a real fake ComfyUI and the image kind started on the engine)

- "makes a new picture from words": one card, one take; the payload is `{ ok: true, status: "succeeded", takeId, imageId, title, inUse: true, note }` and the metadata carries `imageCardId`, `imageTakeId`, `imageArtifactId`.
- `"3"` resolves to the message's picture 3; `"9"` is refused `unknown_picture`; a Document's id is refused `unknown_picture`.
- with the cap at 4, a call naming five of the message's six pictures is refused `too_many_pictures` and its message names 4; the same call naming four goes through.
- four identical calls in one turn share one card; the fifth is refused `too_many_takes`; the ninth call of a turn `too_many_calls`.
- an edit of the open item uses its version's file as `<image1>`, the edit canvas, and a seed unlike the version's.
- a photo starts an item whose version 1 is the photo.
- "still being made": with a budget of 300 ms and a slow fake, the payload is `status: "running"`; when the take lands later it becomes the version in use.
- a failed render gives `{ ok: false, status: "failed", errorCode: "image_render_failed", retryable: true }`.
- with `COMFYUI_URL` empty the tool is not in the set.
- `index.test.ts`: the full catalogue lists `make_image`; its description contains "Do not use" and stays under `PER_TOOL_TOKEN_CEILING`; `TOOL_TIMEOUTS_MS.make_image` is 120 000; the whole catalogue equals the raised ceiling.
- `wait.test.ts`: `onTick` runs at least once a second while the take is queued or running and stops when it settles; the budget returns the take still running.
- `inputs.test.ts`: an uploaded 4032x3024 JPEG becomes a 1184x896 PNG base; a reference is resized to about 1 MP keeping its shape; a marked copy is repainted on the canvas-sized base.
- `tool-activity.test.ts`: a finished new picture reads "Made" + title, an edit "Changed" + title, a running call "Making a picture"; a retried take adds the meta "retried once" / "egyszer újrapróbálva".

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/lib/server/services/normal-chat-tools/make-image.test.ts src/lib/server/services/images src/lib/server/services/normal-chat-tools/index.test.ts src/lib/server/services/vision/prepare-image.test.ts src/lib/utils`
Expected: FAIL.

- [ ] **Step 3: Implement**

The call: count it; resolve; prepare the inputs; create or reuse the card; enqueue the take held until `now + 130_000`; wait with `IMAGE_TOOL_WAIT_MS`; then `releaseHold(takeId)`, which settles the card (a take still rendering is then promoted by the runner when it lands), and answer. The payload carries ids and never a URL: the card shows the picture, and the model has no address to embed. Strings: `toolCalls.makeImage` "Make a picture" / "Képkészítés"; `toolActivity.makingPicture` "Making a picture" / "Kép készül"; `toolActivity.madePicture` "Made" / "Elkészült:"; `toolActivity.changedPicture` "Changed" / "Módosult:"; `toolActivity.retriedOnce` "retried once" / "egyszer újrapróbálva".

- [ ] **Step 4: Pay for the words**

Run `npx vitest run src/lib/server/services/normal-chat-tools/index.test.ts`, read the measured total, set `CATALOGUE_TOKEN_CEILING` to exactly that number, and add a comment above it, dated the day it is written: "<date>: make_image (design section 5, images part 2) adds <N> estimated tokens, paid by a measured raise (plan-part-2-images.md, Plan's call 1, approved by the owner). No margin added." Then update the snapshot with `npx vitest run src/lib/server/services/normal-chat-tools/index.test.ts -u`.

- [ ] **Step 5: Run the tests and check**

Run: the Step 2 command, `npx vitest run tests/integration/english-request-purity.test.ts src/lib/i18n`, then `npm run check`.
Expected: PASS; 0 errors, 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/services/normal-chat-tools src/lib/server/services/images src/lib/server/services/vision/prepare-image.ts src/lib/utils src/lib/i18n
git commit -m "Let Alfy make and change pictures with one tool (catalogue ceiling raised by its measured cost, snapshot updated)"
```

### Task 13: The tool inside the turn: the watchdog, Stop, the retry and the look

**Files:**
- Modify: `normal-chat-tools/make-image.ts`, `normal-chat-tools/index.ts` (`ctx.onToolActivity`, `ctx.stepImages` to the tool), `chat-turn/stream-idle-timeout.ts` (`touch`), `chat-turn/stream-orchestrator.ts` (wire `onToolActivity` to `idleTimeout.touch(latestUpstreamAttempt)`), `chat-turn/shared-normal-chat-model-run-helpers.ts` (`NormalChatSendModelBaseParams.onToolActivity`, passed through `createToolPack`), `images/cards.ts` (used: `hideTake`, `replacePick`), `vision/AGENTS.md` (result looks share the step queue), `images/AGENTS.md`
- Test: `make-image.test.ts`, `chat-turn/stream-idle-timeout.test.ts`, `chat-turn/stream-orchestrator` tests, `normal-chat-model/index.test.ts`, `tests/integration/vision-photo-look.test.ts`

**Interfaces:**
- Consumes: `waitForTake`, `TurnTakes` (Task 12), `guardEdit` measures (Task 5), `hideTake`, `releaseHold`, `replacePick` (Task 9), `cancelTake` (Task 8), `StepImageQueue`, `prepareImageForModel` (part 1).
- Produces: `UpstreamIdleTimeout.touch(attempt: number): void` (reschedules only while a timer is pending, never arms a cleared one); `NormalChatSendModelBaseParams.onToolActivity?: () => void`; `CreateNormalChatToolsContext.onToolActivity?: () => void`; `pickBetterTake(first: TakeSnapshot, retry: TakeSnapshot): "first" | "retry"`; `resultLookLabel(takeId: string, beforeNumber: number | null): string`.

**Behaviour (Plan's calls 2 and 3):**
- Every wait tick calls `onToolActivity`, so a picture's wait never trips the idle watchdog; `touch` never revives a stream that has ended.
- The turn's abort (the composer's Stop) cancels this call's takes whose phase is still none or `submitted`, leaves started ones, and releases every hold.
- A take that landed with `measures.miss` set, when at least 25 s of the budget is left and it is not itself a retry, gets one retry in the same call: the same request, a seed avoiding both, origin `"retry"`, held. `pickBetterTake`: the retry, unless it failed, or it also missed while the first did not; when both missed, the one with more change inside the marks (or more change overall). The loser is hidden, the winner released; the payload and the metadata say `retried: true`.
- `retryOf` names a take of this turn that is not hidden and was not retried; the new take replaces it the same way, through `replacePick` when the old one is already in use. A second retry of the same take is `retry_twice`.
- The look: when the step queue grants room, the winner's picture is prepared like an attachment and queued with the label `Result of make_image (takeId <id>), changed from picture <n>:` (or `Result of make_image (takeId <id>):` for a new picture); when the base was not among the message's pictures, the base goes first under `Before:` (two of the turn's eight). The succeeded payload's `note`: "The result follows as a picture: say in one or two sentences what changed. If it clearly missed (the wrong thing changed), call make_image once with retryOf \"<takeId>\"." With no room left, or for a late picture, there is no look and the note says the picture is on its card.

- [ ] **Step 1: Write the failing tests**

- `stream-idle-timeout.test.ts`: with fake timers and a 60 s idle, `touch` at 50 s moves the firing to 110 s; after `clear()`, `touch` arms nothing.
- an orchestrator test: a tool that calls `onToolActivity` every second for 90 s does not end the stream with a 60 s idle watchdog.
- "the composer's Stop deletes a waiting prompt" (Review Focus 3): the fake's queue is held by another prompt, the turn is stopped, our prompt disappears from the fake's queue and the take is cancelled; a take already rendering is left to land.
- automatic retry: the fake answers "no change" first and a change second; one visible take (the retry), the first hidden, one version, `retried` true in payload and metadata.
- a change outside the marks is retried; when both miss, the one with more change inside the marks is kept; with less than 25 s left there is no retry.
- `retryOf`: the old take is hidden and the pick moves, with two versions in History; `retryOf` a retry is refused `retry_twice`; an unknown take is `retry_unknown`.
- the look: in the next step's request (`normal-chat-model/index.test.ts`, injected fetch), after the tool result, a user message holds the label and one `image_url`; an attempt on a model that cannot see gets the label and `STRIPPED_IMAGE_NOTE`; a photos look and a picture look in one turn share the eight.

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/lib/server/services/normal-chat-tools/make-image.test.ts src/lib/server/services/chat-turn src/lib/server/services/normal-chat-model/index.test.ts tests/integration/vision-photo-look.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** as described.

- [ ] **Step 4: Run the tests and check**

Run: the Step 2 command, `npx vitest run tests/integration tests/cross-cutting src/lib/server/services/vision`, then `npm run check`.
Expected: PASS; 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/normal-chat-tools src/lib/server/services/chat-turn src/lib/server/services/images src/lib/server/services/vision tests/integration
git commit -m "Keep a picture's wait alive, let Stop cancel what has not started, retry a clear miss once, and show Alfy the result"
```

### Task 14: End to end, the docs and the gate

**Files:**
- Create: `tests/e2e/images-pipeline.spec.ts`, `tests/e2e/images-helpers.ts`
- Modify: `tests/mocks/ai-provider/openai-compatible-provider.ts` (a marker that makes the fake model call `make_image`, then reply once the tool result comes back), `images/AGENTS.md` (final read-through), root `AGENTS.md` (Mandatory Verification: the image specs; Folder Rules check), `tests/AGENTS.md` ("Making pictures" row), `README.md`

**Interfaces:**
- Produces, in `tests/e2e/images-helpers.ts`: `startFakeComfyUiForSpec(page: Page): Promise<FakeComfyUi>` (starts the fake in the spec's process and sets `COMFYUI_URL` through the admin config route, as `settings-admin.spec.ts` sets keys) and `stopFakeComfyUiForSpec(page: Page, fake: FakeComfyUi)` (`clearAdminConfig(page, ["COMFYUI_URL"])`, then close); `AI_SMOKE_MAKE_IMAGE_MARKER` exported by the mock provider.

- [ ] **Step 1: Write the spec**

`@smoke` "a picture made from words lands as an Image": with a temporary provider (as `vision.spec.ts` makes one) and the fake ComfyUI, send a message holding the marker; after the turn, the conversation detail's `imageCards[0]` has one succeeded take that is the pick; the chat's artifact list has one item of kind `image`; `GET /api/images/files/<fileId>` answers a PNG; the fake received one `/prompt`. Clean up the provider (`deleteProvidersWithPrefix`) and the setting.

- [ ] **Step 2: Run the spec on its own**

Run: `npm run build`, then `E2E_PORT=4700 npx playwright test tests/e2e/images-pipeline.spec.ts`
Expected: PASS.

- [ ] **Step 3: Run the agent gate once**

Run: `scripts/gates.sh agent /Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/<worktree>/.superpowers/sdd/plan-part-2a-pipeline/gates --port 4600 tests/e2e/images-pipeline.spec.ts tests/e2e/vision.spec.ts tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts tests/e2e/conversation.spec.ts tests/e2e/composer-chips.spec.ts tests/e2e/settings-admin.spec.ts tests/e2e/knowledge.spec.ts` (with the worktree's literal path)
Expected: every step exits 0; the build reports zero warnings; Fallow shows the four known cycles and nothing new.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e tests/mocks tests/AGENTS.md AGENTS.md src/lib/server/services/images/AGENTS.md README.md
git commit -m "Cover making a picture end to end against the fake ComfyUI"
```
