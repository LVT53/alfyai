# Images and vision: design

Date: 2026-10-26. Status: design agreed in conversation with the owner; nothing built.
Wireframes: [`wireframes.html`](./wireframes.html) in this folder, also published privately at https://claude.ai/artifact/83CKxG5coohSLd7Xcs9kq6.
Backlog: item 2 of the owner's ranked backlog (image generation and editing).

## 1. Why

The owner described the use that matters: make a picture of a sofa, repaint the same sofa in the same room, then move it around inside a real photo of their own room, "so a lot of back and forth and comparative image generation, not just stand alone". The core need is conversational editing with reference photos. Making a picture from nothing is the smaller part.

Two facts shape the work:

- AlfyAI cannot make or change pictures today.
- AlfyAI cannot see pictures today either. An uploaded image goes to MinerU, which extracts its text; no image pixels ever reach the chat model (no `image_url` part is built anywhere in `src/lib/server`, checked 2026-10-26). The local chat model, Flash-Next, has been served with vision since 2026-09-30, so this is app work only. The owner: if the model cannot see the picture, every round of "make it better" is guesswork.

So the work has two parts, built and shipped in this order:

1. **Alfy can see.** Every chat: images the person attaches or pastes, and the person's Immich photos when a question needs it. Useful on its own.
2. **Images.** Making and changing pictures, as a sixth kind in the artifact family. It depends on part 1.

AlfyAI is a private, self-hosted assistant for the owner's family. The owner's standing rules apply: few choices in the UX, every user-facing string in English and Hungarian (short, natural Hungarian that fits a 360 px row), self-hostable, no cross-account sharing.

## 2. Goals, non-goals, anti-goals

Goals:

- G1. In any chat, Alfy sees images the person attaches or pastes, and answers about what is in them.
- G2. Alfy can look at small thumbnails of the person's Immich photo results when a question needs it ("which of these has the best light?").
- G3. Make a new picture from words.
- G4. Change an uploaded photo from words. The photo itself is never changed.
- G5. Keep changing a picture round after round, compare versions, and go back to any of them.
- G6. Combine several pictures into one result ("put the sofa from 1 and the rug from 2 into our room, 3").
- G7. Point at parts of a picture (marks) and refer to them in words ("move A to B").
- G8. All of it works on a phone, in English and Hungarian.

Non-goals for this version:

- Size, shape, style or quality controls, and a "make a picture" mode switch. Alfy reads all of that from the person's words.
- Brush masks with a strength setting, extending a picture past its frame, pose or depth guides, upscaling. Qwen-Image 2.1 documents none of them.
- A content checker on the app's side (owner's decision, section 5.2).
- Alfy looking at web image search results.
- A picker for this chat's pictures or for Immich photos inside the Attach menu. Every image card has Attach instead.
- Ask me first (backlog item 5) asking which photo the person meant. It can come later.
- A storage quota for pictures.
- A per-person switch for who may make pictures. Every account can (my call; proposed to the owner, who did not object).
- A follow-up turn the server starts by itself to check a picture that lands after the reply ended (section 5.5).

Anti-goals. The work fails, even if it runs, when:

- the room changes when the person only asked to change the sofa;
- long sessions get slow or expensive because every picture is sent to the model again on every turn;
- the person has to handle file names, ids or re-uploads to keep going;
- settings panels appear;
- pictures get a second undo or history system beside the family's History;
- anything is inserted above prose that is still streaming (rule F16).

## 3. Constraints

- **Chat model.** Flash-Next on GPU0 serves vision through OpenAI `image_url` parts: about one token per 32x32 px (a 1600x1000 image costs 1,631 prompt tokens, a 1280x720 screenshot about 976), about 1.5 s for a 2 MB body. Its prefix cache gives no hits, so anything re-sent is paid again in full.
- **Image model and card.** Qwen-Image 2.1 on GPU1, an RTX PRO 5000 (48 GB) with about 33 GiB free beside the TEI embedder and reranker and the MinerU vLLM (early-October figure; re-check with `nvidia-smi`). One image job at a time.
- **Tool catalogue.** The model-facing tool catalogue sits at its token ceiling (`CATALOGUE_TOKEN_CEILING`, 5,222 estimated tokens, `src/lib/server/services/normal-chat-tools/index.test.ts`) with nothing spare. A new tool pays for its words by cutting words elsewhere or by a measured raise.
- **Ruling 79.** Everything the app writes into a model request is English. The chat model turns a Hungarian request into an English image prompt. Read `src/lib/server/services/chat-turn/AGENTS.md` before adding a model call.
- **ADR-0068.** An address the app requests without a click comes from the person's words or a tool's result. Immich thumbnails come from the photos tool's results through the app's own authenticated proxy, so they qualify.
- **The artifact family's rules** (`src/lib/components/artifacts/AGENTS.md`, `history/AGENTS.md`, `document-workspace/AGENTS.md`): the word "Artifact" never reaches the UI; each kind is named through `artifacts.type.*`; History is a mode of the panel with Restore inside it; no version numbers outside History's fine print (ruling 76); the registries are append-only, one entry per kind; what a turn made is drawn after what it said (F16).
- **Code rules:** Svelte 5 runes, Lucide icons, the design tokens in `src/app.css`, and the repo's gates (`npm run check` clean, `npm run build` with zero warnings, the Fallow baseline, the relevant e2e specs).

## 4. Part 1: Alfy can see

### 4.1 What the person gets

- Attach or paste a photo, a screenshot, a receipt, a handwritten note or a chart, and Alfy sees it. A photo with no text in it stops being a blank.
- Ask about Immich photos ("which of these shows the whole house?") and Alfy looks at small thumbnails of the results before answering.
- No new controls. The activity row says when Alfy looked ("Looked at the photo", "Looked at 6 photos").

### 4.2 Decided

- **Which images the model sees.** Images attached or pasted into the current message (the image types the file-type table routes to MinerU today: jpg, png, gif, webp, bmp, heic, heif; AVIF stays refused with its existing "convert" message). Immich photo results, as small thumbnails, when the question needs them (owner, 2026-10-26). In part 2, also the picture open in the panel with its marks, and each fresh result.
- **How images reach the model.** The pixels go only into the turn where they matter. After that turn, the conversation history carries a short description of the image, written when the model first saw it, never the pixels again. No new tool. (The owner parked a choice between "images inside the messages" and a `look_at_image` tool on 2026-09-30; this mixes the two and was proposed in conversation without objection.)
- **Size budgets.** An attachment is sent at no more than about 1,600 tokens (about 1600 px on its long side). An Immich thumbnail at about 250 tokens (about 512 px).

### 4.3 My calls (not the owner's)

- **MinerU stays.** Image uploads keep the `mineru` intake route, so their text still feeds Knowledge Base search and serves as the fallback for a model that cannot see. Vision adds pixels to the turn; it does not replace intake. The reserved `vision` intake route in `src/lib/shared/file-types/types.ts` may therefore stay unused; that is the builder's call.
- **A per-model switch.** A new per-model setting, "Can see images" (Hungarian first guess: "Lát képeket"), stored on `provider_models` (`src/lib/server/db/schema.ts`) and shown in the admin's model settings. Off by default; the admin ticks it for Flash-Next after deploy. A model without it gets no pixels: Alfy works from the MinerU text and says in one short line that it could not look at the image. Pictures reach a cloud model only when the admin ticked that model. A turn that fails over to `fallbackProviderModelId` follows the fallback model's own setting.
- **Memory and incognito.** Profile memory sees the description, never the pixels. Incognito chats keep their existing rules; vision must not leave anything behind that outlives an incognito chat.
- **Text-free photos can be sent.** Today they cannot: MinerU returns `empty_result` for an image with no text, the extraction counts as failed, and `validateAttachmentReadiness` in `chat-turn/preflight.ts` refuses the send (the chip says "No readable text found"). With a model that can see, an image attachment never blocks the send. MinerU runs in the background, and an empty result on an image reads as "no text in this image", not as a failure. When MinerU's text is ready it travels with the pixels, so a screenshot gets both. A model that cannot see keeps today's behaviour.
- **Immich pixels follow the existing connector privacy rules** (`src/lib/server/services/connections/locality.ts`). For a person with local summarising on (`connectionLocalDistill`) whose chat model is a cloud model, a local model that can see does the looking and passes on text through the existing distill gate; with no such local model, the pixels are withheld. Everyone else on a cloud model gets the existing one-time warning (`connectionCloudAck`). Pictures the person attaches themselves follow the model's "Can see images" setting alone.

### 4.4 Done when

- A photo with no text in it gets a correct description.
- A screenshot is read correctly.
- "Which of these has the best light?" over Immich results gets an answer that names one photo.
- A 20-turn chat with 10 images keeps its prompt size bounded: earlier images appear only as their descriptions.
- A model without "Can see images" behaves as today, plus the one-line note.

## 5. Part 2: Images

### 5.1 Model and serving (decided)

The owner chose Qwen-Image 2.1 on 2026-10-26 without the trial the comparison report proposed. What the report says to run:

- One headless ComfyUI on GPU1, in its own venv: NVIDIA driver 580 or newer, torch 2.14.1+cu130, ComfyUI pinned to a commit at or after v0.41.3, no xformers, Dynamic VRAM on, `--reserve-vram` set so the other tenants keep a margin, `--listen 127.0.0.1`.
- Comfy-Org's official INT8-ConvRot DiT (`qwen_image_2.1_int8_convrot.safetensors`), the INT8 or W4A8 Qwen3-VL-8B encoder, the bf16 VAE. 40 steps, CFG 1. The community NVFP4 pair is an optional speed comparison, not the default. The Turbo files (8 steps, about 3 s) return near-identical images across seeds, so they suit neither Another nor retries.
- Default canvas 1248x832 (multiples of 32). Never an exact 1024x1024 edit: it gives noise in ComfyUI.
- A fresh random seed on every turn. Editing with the seed that made the input corrupts the result (the "same-seed trap").
- References addressed as `<image1>`, `<image2>`, with the photo being changed first.
- PNG for every stored picture.
- ai.dev and production share this one ComfyUI, because the card cannot hold two. A card's "N ahead" therefore comes from ComfyUI's own queue, not from either app's job rows (my call).
- Build against a fake ComfyUI (its HTTP and WebSocket API) first (my call). An agent then installs the real one over ssh, with the owner approving each command (owner, 2026-10-26): its venv, pinned torch and ComfyUI, about 16 GiB of weights, a systemd unit with `--reserve-vram`. The same agent takes the first memory and timing measurements beside TEI and MinerU. That first session on the real card is a gate before the pixel guards are tuned.
- Estimated peak for a two-reference edit: about 19 to 22 GiB. Estimated time: about 11 to 13 s per picture on this card. Both are extrapolations; nobody has measured them on an RTX PRO 5000.

The full report, with sources and version pins, is the Claude memory note `alfyai-image-model-comparison-2026-10-26.md` in the owner's Claude Code memory folder for this project.

### 5.2 No content checker (decided)

The owner does not want to maintain a checker. The image model runs as shipped, with no uncensored finetunes or LoRAs, and a tame or failed result is acceptable. Note: the open Qwen-Image 2.1 pipeline has no refusal step and no safety checker, so a blocked request comes back as a tamer or odd picture, not as a refusal. There is no "held back" state.

### 5.3 A sixth kind: Image / Kép (decided)

Pictures join the artifact family as a new kind, `image`, labelled Image / Kép through `artifacts.type.*`. They get what the other kinds have: the card, the panel, History, the chat's list of what it made, the Knowledge Base, Workspace Search and Download.

- **The card** sits under the reply's text (F16) and shows the picture that turn made. Older cards keep showing their own turn's picture, so the chat reads as a log of tries. This breaks the family's "one latest moment on every surface" rule on purpose, for this kind's card image only (owner, 2026-10-26). Actions: Another, Attach, Download, and a "…" menu. An edit's card has a Before / After switch. A result made from several pictures shows a "Made from" row with their numbered thumbnails.
- **The panel** shows the picture large, with the Mark tool, a Before / After switch, and a strip of the picture's versions, oldest first with the original pinned at the start. While a picture is open, the composer is about it and uses the App's wording ("Ask Alfy to change {title}…").
- **History** is the family's mode with one thumbnail per version, the family's moment phrases ("Alfy moved the sofa · just now"), a wipe slider comparing a version with the one before it, and Restore. Clicking a frame in the strip opens it in History.
- **On a phone** the panel is the existing full-screen sheet; pinch to zoom.
- **Knowledge Base:** pictures appear in the Documents tab like the other kinds (owner, 2026-10-26).
- **No switch:** Alfy decides from the words when to make or change a picture (owner, 2026-10-26).

### 5.4 Versions and lineage (decided)

- One item, many versions. A change adds a version to the same item; an unrelated request starts a new item. Alfy decides which, as it does for Documents.
- The person's upload is never modified. The first time they ask to change a photo, a new Image item starts with the photo as its first version.
- **Another** asks for one more take, with a new seed, and adds it to the same turn's card. "Use this" on a take makes it the version in use. Takes not picked stay in the card and can be picked later. The version in use is what the next change starts from.
- One take per tool call. Asked for options in words ("show me four"), Alfy makes up to four takes in the turn, one call each; takes made in one turn for one picture share one card. Each take gets the look, and a take that clearly missed is retried once (my call).
- Restore in History makes an older version the version in use. Nothing is deleted.
- "It" means the picture open in the panel, or else the newest picture in the chat. The person never names files or ids.

### 5.5 A turn that makes or changes a picture

1. The person asks, with words and possibly attachments or marks.
2. Alfy looks at the pictures involved (part 1).
3. Alfy writes an English prompt that names what changes and what stays.
4. A job runs on the job engine and its card shows progress, its place in the queue, Stop and Try again (my call: a job kind, like file production, because a picture takes seconds to tens of seconds and the card can wait its turn).
5. Alfy looks at the result and says what actually changed. When the result clearly missed (nothing changed, the wrong object changed), Alfy tries once more on its own (owner, 2026-10-26). Only the better take is shown; the activity row says a retry happened (my call).

Time limits (my calls). A chat turn has hard limits: the stream's idle watchdog fires after 60 to 150 s without a model event (150 s by default; `getUpstreamIdleTimeoutMs` in `chat-turn/stream-orchestrator.ts`), and each tool has its own timeout (`TOOL_TIMEOUTS_MS` in `normal-chat-tools/shared.ts`; `produce_file` waits only 20 s in the turn, `PRODUCE_FILE_VERDICT_WAIT_MS`). The picture tool's reply waits up to about 100 s, and job progress counts as activity for the watchdog. A warm picture with its look and one retry fits inside that. When the queue or a cold start pushes past it, Alfy says the picture is still being made, the card fills in when it lands, and that late picture gets no look and no retry; nothing starts a follow-up turn by itself. The composer's Stop ends the reply and cancels a picture job that has not started; a running job finishes onto its card, whose own Stop cancels it.

The pixel guards from the comparison report run inside the job and are not drawn: a fresh seed every turn; frames aligned and only the changed area pasted back onto the version in use; every four or five rounds, a re-render from the original; PNG throughout. These are what keep the room from drifting (anti-goal 1).

### 5.6 Several pictures in one request

- Each attached picture gets a number in the order it was added, shown on its composer chip and matching `<imageN>`. Alfy works out which picture is the scene and which are the pieces.
- Attach on any card or version puts that picture into the next message without uploading it again.
- A cap per message: default 4, admin-set, never above 10 (my call; the wireframes say 6, but each extra 1 MP reference costs Qwen about 2 GiB more on a shared card).

### 5.7 Marks

- One Mark tool that draws boxes, nothing else (my call: Qwen also reads freehand marks, but one tool keeps it simple). Each box gets a letter and its own colour. Tapping a box removes it.
- Marks travel with the next message as one chip; the chip's × removes them all, and sending clears them.
- Qwen has no box control. The app paints the boxes, with their letters, onto a copy of the picture and sends that copy together with the clean picture.
- Moving objects and inserting them are Qwen's weak spots (inserts can look pasted on, with weak shadows). Another, the automatic retry and Restore are the answers to that; nothing else in the UI changes for it.

### 5.8 Transparent pictures

Qwen can make pictures with a transparent background. Show them on a checkerboard; Download keeps the transparency.

### 5.9 Card states

Making (progress and Stop); waiting for its turn (how many are ahead, and Stop); starting up (the model loads after a quiet spell, so this one takes longer); checking and retrying (in the activity row); failed (Try again); too many pictures (the cap, with "remove one to send"); unavailable (the existing degraded-tools banner, fed by a Tool Health check on the ComfyUI service).

### 5.10 Size and shape

Words only. A new picture defaults to the 1248x832 landscape canvas unless the words ask for another shape ("for my phone"). A change keeps the shape of the picture it changes, at about 1 MP; Alfy may go up to about 4 MP when the words ask for print or wallpaper quality.

### 5.11 Storage

Every version and every take is a PNG the chat owns. Deleting the chat deletes them through the existing cleanup (`src/lib/server/services/cleanup/conversation-cleanup.ts`). No quota in this version (my call).

### 5.12 Done when (my proposal, calibrated on the first real run)

- The sofa session works end to end on the owner's own photos of a room, a sofa and a rug: a new picture, a recolour, new upholstery, a cushion added in a marked box, the sofa moved to a marked spot, the sofa put into the real room photo, then five more chained changes.
- The room stays put. Outside the edited area, a change differs from the version it started from by an LPIPS of at most 0.10, and the frame shifts by at most 4 px. After five chained changes, at most 0.20 against the original photo. With the paste-back guard, at most 0.05, with no visible seam. These are the comparison report's proposed thresholds.
- No edit reuses the seed that made its input.

## 6. Owner decisions, in order

| Date | Decision |
|---|---|
| 2026-10-25 | Image generation is backlog priority 2; the use case is the sofa session. |
| 2026-10-26 | Qwen-Image 2.1, without the one-hour trial. |
| 2026-10-26 | Shape B: a card in the chat, the picture in the panel, a sixth kind. |
| 2026-10-26 | Older cards keep their own turn's picture; pictures appear in the Knowledge Base; no "make a picture" switch. |
| 2026-10-26 | Vision is a prerequisite, for every chat, shipped first. |
| 2026-10-26 | Alfy checks every new picture and retries once on a clear miss. |
| 2026-10-26 | No content checker on the app's side. |
| 2026-10-26 | Alfy may look at Immich thumbnails when a question needs it. |
| 2026-10-26 | Server setup: an agent installs and runs ComfyUI on GPU1 over ssh, and the owner approves each command. |

## 7. My calls, for the owner to check

1. How images reach the model: pixels in the turn that needs them, a description in history afterwards, no new tool.
2. MinerU keeps extracting text from image uploads.
3. A per-model "Can see images" setting; pictures reach a cloud model only when it is ticked.
4. One picture per request, plus Another.
5. Marks are boxes only, each with its own colour and letter.
6. The English prompt is kept per version, folded away in History, not on the card.
7. No size or shape control.
8. A cap of 4 pictures per message, admin-set, up to 10.
9. A picture job runs on the job engine with a card.
10. After an automatic retry, only the better take is shown.
11. No storage quota yet.
12. Hungarian labels are first guesses: Kép, Másik (Another), Ez legyen (Use this), Előtte / utána, Jelölés (Mark), Csatolás (Attach), Lát képeket (Can see images).
13. A picture's reply waits up to about 100 s; a picture that lands later gets no look and no retry. This narrows the owner's self-check decision in that one case.
14. For a model that can see, text-free photos no longer block the send, and an empty MinerU result on an image reads as "no text", not as a failure.
15. Immich pixels follow the existing per-person connector privacy rules.
16. One take per tool call; asked for options, Alfy makes up to four in one turn.
17. ai.dev and production share one ComfyUI, and the queue count comes from ComfyUI itself.
18. Every account may make pictures; no per-person switch.
19. Part 2 is accepted on the sofa session with the owner's own photos, against the report's drift thresholds.

## Decided during the build

- BMP is not shown to the model, while TIF and SVG are (section 4.2 listed bmp, but the prebuilt image library cannot decode it).
- Thumbnails are decided for each attempt, by the attempt model's locality as well as its sight. Someone with local summarising on never has thumbnails, or their file names, sent to a cloud model, failover included.
- At most 8 thumbnails a turn, shared by every look.
- A look has its own deadline (8 s showing, 12 s describing) and never costs the search results.
- Hungarian for several pictures reads "{count} képet nézek meg…", with no article, because the right article depends on the number.
- The release checklist is [`part-1-release-checklist.md`](./part-1-release-checklist.md).

## 8. Left to the builder

- How pixels attach to a turn. Check whether vLLM accepts image parts in tool messages for Flash-Next; if not, a picture the model must see mid-turn (an Immich thumbnail, a fresh result) needs another carrier, such as an image part in a following message.
- How and when the description of an image is written and stored, and its wording.
- The model-facing tool: one tool for making and changing pictures is the obvious shape under the catalogue ceiling (an English prompt, input pictures by id, marks, a size hint; one take per call, section 5.4), but the schema, its name and how its words are paid for are the builder's.
- The ComfyUI API graphs, the alignment and compositing method, the re-anchoring threshold, and how a "clear miss" is detected.
- The job kind's tables and the card component.
- The History preview component for the new kind, and every English and Hungarian string, within the rules above.
- Which e2e specs to add.

## 9. Where it lands

Read each folder's AGENTS.md before changing code there.

Part 1:

- `src/lib/server/services/chat-turn/conversation-history.ts` (`buildHistoryModelMessages`, `buildHistoryToolDigest`): history as native messages, where earlier images become descriptions.
- `chat-turn/streaming-normal-chat-model-run.ts`, `chat-turn/plain-normal-chat-model-run.ts`, `chat-turn/context-selection.ts`: the current turn. This is a send/stream contract change, so the route, `chat-turn/*`, the browser stream consumer and their tests move together (root AGENTS.md, Known Traps).
- `src/lib/server/services/normal-chat-model/`: the request builders and provider families.
- `provider_models` in `src/lib/server/db/schema.ts`, a migration, the admin model settings, and `config-store.ts` where the setting must respect admin overrides.
- `src/lib/server/services/normal-chat-tools/photos.ts`: the photos tool and its thumbnail proxy, `/api/connections/immich/thumbnail/[assetId]`.
- `src/lib/shared/file-types/`: unchanged unless the builder uses the reserved `vision` route.

Part 2:

- `src/lib/shared/artifacts/kinds.ts` (`ArtifactKind`, `SHIPPED_ARTIFACT_KINDS`), `src/lib/server/services/artifacts/`, `src/lib/components/artifacts/` (`ArtifactCard.svelte`, `artifact-bodies.ts`), `history/history-previews.ts` (`HISTORY_PREVIEWS`), and `src/lib/i18n/artifacts.ts` (`artifacts.type.image`).
- `src/lib/server/services/jobs/` (`defineJobKind`; the file-production job in `file-production/production-job.ts` and `FileProductionCard.svelte` are the precedent for a job with a card).
- `src/lib/server/services/tool-health/` for the ComfyUI health check and the degraded banner.
- `src/lib/server/config-store.ts` and `src/lib/config/admin-config-registry.ts` for the ComfyUI address, the reference cap and the other admin settings.
- `src/lib/server/services/normal-chat-tools/` for the tool, with the catalogue snapshot test re-run.
- `src/lib/components/chat/MessageInput.svelte` and the composer chips for numbered picture chips and the marks chip. Chip kinds are a closed, owner-approved list (`composer-chip-kinds.ts`); the marks chip needs that board's blessing or a fit inside an existing kind.
