# Slice 4 — Slides: a deck the user and Alfy edit, and a PPTX at the end

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking. Read `plan.md` first. **This slice needs Slice 0** (the `artifacts/` boundary, the panel shell,
> `ArtifactCard.svelte`, versions, comments, the ops route) and **Slice 1's refusal contract** (a per-block
> `baseHash` patch that the server refuses when the user changed the block since). It does **not** need
> Slice 2 or Slice 3.

**Goal:** Make `Slides` a real artifact type: a deck with a small fixed set of layouts, edited in the panel
slide by slide, presented full-screen, exportable to `.pptx` through the file-production engine, and
editable by Alfy through the same block-addressed, refusable patch contract the Document type uses.

**Architecture:** One lazy-loaded panel editor, `SlidesEditor.svelte`, mounted by the artifact panel when the
open artifact's type is `slides`. The deck is JSON in `artifacts.content_text`:
`{version, layouts, slides[]}`. Layouts are a closed, app-owned set — the model picks a layout id and fills
fields; it never writes markup, CSS or coordinates. Text is edited in place (ADR-0065), each text field is
a block with its own hash, and every edit is a version. The PPTX export is a **server-built program** run
through the existing file-production sandbox, not a model call: the deck JSON is inlined into a
deterministic generator script, so the same deck always produces the same file.

**Tech Stack:** SvelteKit + Svelte 5 runes, `@lucide/svelte`, Vitest, Playwright. No new runtime
dependencies. The PPTX generator runs **inside the sandbox** on packages the deployment already installs:
`pptxgenjs` 4.x (already a dependency, bind-mounted read-only for the JavaScript runtime) and/or
`python-pptx` (already in `SANDBOX_PYTHON_PACKAGES`, installed by `scripts/deploy-lib.sh`).

**Spec:** `docs/plans/claude-at-home-2-artifacts-spec.md` §1 (the type), §2 (decisions 4, 5, 6, 15),
§3 (the record and the body), §5 (panel, card, export matrix), §6 (Slice 4), §7 (testing). ADRs:
[ADR-0066](../../adr/0066-artifacts-are-a-family-of-five-types.md) (the family; "Artifact" is never shown in
the UI; a type whose contract the model cannot hold changes its design rather than its evidence),
[ADR-0065](../../adr/0065-living-documents-are-edited-in-place.md) (editing in place).
Mockup: `claude-at-home-2-artifact-types-mockups.html` §3 (Slides) — the editable heading with a caret, the
bullet list, the illustration, `Ask Alfy about this slide`, and the `SPEAKER NOTES` block.

**Feasibility note, stated up front.** Slides is the one type the prototypes did **not** exercise (spec §1:
"not prototyped (lower risk)"). Spec §9 question 1 asks the owner whether to prototype it first. This slice
therefore treats **Slice 5's eval suite 4 as a hard precondition**: if slide generation cannot produce valid
JSON in the right language without invented facts, the design changes (Alfy proposes, the user approves) and
this slice does not merge. See Task T7.

## Global Constraints

Same as `plan.md` §Global Constraints. In addition, for this slice:

- **Svelte 5 runes only.** `$props()`, `$state`, `$derived`, callback props, `onclick`, `{@render}`.
- **Lucide icons only.** No hand-written `<svg>` for icons. `ContextUsageRing.svelte`-style visualisation
  exceptions do not apply here.
- **Tokens only** from `src/app.css`; the slide surfaces use the existing `--surface-*`, `--text-*`,
  `--border-*` and radius tokens. No hex in a layout component.
- **EN + HU in the same commit** for every user-visible string.
- **"Artifact" never appears in the UI.** The type is **Slides** (HU: **Diasor**), per ADR-0066.
- **One user, permanently.** No sharing, no co-editing, no presenter-to-audience link, no exported
  "share a deck" affordance.
- **Ownership checked server-side** on every read and write through the Slice 0 record boundary. The client
  never sends a `userId`.
- **Incognito:** a deck made in an incognito chat is contained like every other artifact (no library listing,
  no retrieval elsewhere) — Task T8.
- **The deck round-trips through `content_text` only.** No side tables for slides.
- **Layouts are app-owned.** The model's vocabulary is field values and layout ids; a slide whose layout id
  is unknown is dropped-with-report on load and refused on write, never rendered as raw HTML.
- **No new runtime dependency.** The PPTX generator runs in the sandbox, on packages the deploy already
  installs. Do not add a PPTX library to the app's own bundle.
- **`npm run check` stays at 0 errors, 0 warnings; `npm run build` emits 0 warnings.**

## Gates

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run check && npx biome check src scripts tests && npm test && npm run build
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json
npx playwright test tests/e2e/artifact-slides.spec.ts tests/e2e/artifacts-panel.spec.ts \
  tests/e2e/chat.spec.ts tests/e2e/incognito-indicator.spec.ts
node --experimental-strip-types scripts/eval-artifact-contracts/run.ts --only slides   # Slice 5's harness
```

The eval run is a gate, not a report: a slide suite that regresses blocks this slice's merge (Task T7).

## Review Focus

1. **Every text field is a block with its own hash, and the refusal is real (Tasks T3, T5).** If a slide's
   title carries no `baseHash` and a user edit is silently overwritten, the type has broken §2.5 — the
   single decision that makes editing-in-place safe. The e2e test edits a title in the panel, asks Alfy for a
   change to that same title, and asserts the refusal notice plus the fact that the *other* patches landed.
2. **The model never writes markup (Tasks T2, T4).** A slide is `{layout, eyebrow, title, bullets[], notes}`;
   if a layout component ever renders model-supplied HTML, the type has an injection surface and the layout
   promise is gone. The layout id is validated against the registry on load and on write.
3. **The export is a server-built program, and it is deterministic (Task T6).** The same deck must produce
   byte-comparable slides on every run. A model-written generator would make the export a second, unverified
   generation path — and the sandbox has no network, so a failed run is a failed run.
4. **The phone layout is a different layout, not a squeezed one (Task T2).** The Document prototype's toolbar
   ate 29 % of a 390 px viewport; a slide rail plus a toolbar plus a notes pane will do worse. Below 720 px
   the rail becomes a horizontal filmstrip and editing a text field opens a bottom sheet.
5. **Language is a field, not a guess (Tasks T4, T7).** The deck carries `language`, the layouts do not
   translate anything, and the eval asserts the deck's language matches the request's.

---

## Contracts

### The deck body

`artifacts.content_text` holds this JSON, and nothing else about the deck:

```ts
// src/lib/shared/artifacts/slides.ts — client-safe, no server imports.
export type SlidesLanguage = "en" | "hu";
export type SlidesTheme = "paper" | "ink";

/** The closed set. Adding one is a code change plus an i18n row plus a test. */
export type SlideLayoutId = "title" | "bullets" | "two-column" | "image" | "section";

export type SlideBullet = { id: string; text: string };

export type Slide = {
	id: string;
	layout: SlideLayoutId;
	/** Optional eyebrow, e.g. the mockup's "2 · HONNAN ERED?". */
	eyebrow?: string;
	title: string;
	subtitle?: string;
	bullets?: SlideBullet[];
	/** `two-column` only. */
	columns?: { left: SlideBullet[]; right: SlideBullet[] };
	/** `image` only: an existing artifact or chat file, never a remote URL. */
	image?: { kind: "artifact"; artifactId: string } | { kind: "generated_file"; fileId: string };
	imageAlt?: string;
	imageCaption?: string;
	/** Speaker notes. Free text; the model may write them. */
	notes?: string;
};

export type SlidesBody = {
	version: 1;
	/** The deck's own settings. Named `layouts` to match the spec's body shape. */
	layouts: { theme: SlidesTheme; aspect: "16:9" };
	title: string;
	language: SlidesLanguage;
	slides: Slide[];
};
```

**On the name `layouts`.** Spec §3 writes the Slides body as `{layouts, slides[]}`. This slice reads
`layouts` as the deck's layout/theme configuration (the object above) rather than as a per-deck layout
definition set, because the layouts themselves are app-owned and must not be redefinable from the body —
otherwise a stored body could ship its own CSS. Flagged in Open questions; if the owner meant something
else, only the field's shape changes, not the design.

**Text fields are the blocks.** `title`, `subtitle`, `eyebrow`, each bullet's `text`, each column bullet,
`imageCaption` and `notes` are addressable patch targets. Their ids are stable and persist with the deck
(bullets carry `id`; the single-string fields are addressed by the slide id plus the field name), and a
patch carries the hash the model last read for that target.

### The patch model

```ts
// src/lib/shared/artifacts/slides-patch.ts
export type SlideFieldId = "title" | "subtitle" | "eyebrow" | "imageCaption" | "notes" | string; // or a bullet id

export type SlideTarget = { slideId: string; fieldId: SlideFieldId };

export type SlidePatch =
	| { op: "replace_text"; target: SlideTarget; baseHash: string; text: string }
	| { op: "add_bullet"; slideId: string; after?: string; text: string }
	| { op: "remove_bullet"; slideId: string; bulletId: string; baseHash: string }
	| { op: "reorder_bullets"; slideId: string; order: string[] }
	| { op: "set_layout"; slideId: string; baseHash: string; layout: SlideLayoutId }
	| { op: "add_slide"; after?: string; slide: SlideInput }
	| { op: "remove_slide"; slideId: string }
	| { op: "reorder_slides"; order: string[] }
	| { op: "set_deck"; title?: string; language?: SlidesLanguage; theme?: SlidesTheme };

export type SlideOpResult = {
	applied: number;
	refused: { op: number; target?: SlideTarget; reason: SlideRefusalReason }[];
};

export type SlideRefusalReason =
	| "unknown_slide"
	| "unknown_field"
	| "stale_base_hash"
	| "layout_dropped_field"
	| "invalid_text"
	| "limit_exceeded";
```

`stale_base_hash` is §2.5 exactly: the user changed that field after the model last read it, so the patch is
refused and the model is told, while every other patch in the batch still applies. `layout_dropped_field` is
the one slides-specific refusal: moving a slide to a layout that cannot show the content it has (a `title`
layout has no bullets) is refused with that reason rather than silently discarding the bullets — the model
can then choose to drop them explicitly in a second op.

### The layout registry

`src/lib/components/artifact/slides/_lib/layout-registry.ts` is the one place layout → fields and component
live. Adding a layout must not edit the editor.

```ts
export type LayoutFieldId = "eyebrow" | "title" | "subtitle" | "bullets" | "columns" | "image" | "imageCaption" | "notes";

export type LayoutRegistryEntry = {
	id: SlideLayoutId;
	component: Component<{ slide: Slide; editing: SlideFieldId | null; bundle: SlidesBundle }>;
	/** Which fields this layout renders, in reading order. */
	fields: readonly LayoutFieldId[];
	/** Fields the layout can never show; a patch that fills one is refused. */
	forbidden: readonly LayoutFieldId[];
	/** The i18n key for the layout's name in the Insert-slide / Change-layout menu. */
	labelKey: string;
	/** True when the layout is a candidate for a deck's first slide. */
	firstSlide: boolean;
};

export const LAYOUT_REGISTRY: Record<SlideLayoutId, LayoutRegistryEntry>;
```

The five layouts and what each owns:

| id | fields | forbidden | notes |
|---|---|---|---|
| `title` | `title`, `subtitle`, `notes` | `bullets`, `columns`, `image` | the deck's opening slide; `firstSlide: true` |
| `bullets` | `eyebrow`, `title`, `bullets`, `notes` | `columns`, `image` | the mockup's slide 2 |
| `two-column` | `title`, `columns`, `notes` | `bullets`, `image` | comparison-shaped content |
| `image` | `title`, `image`, `imageAlt`, `imageCaption`, `bullets`, `notes` | `columns` | the mockup's illustration slide |
| `section` | `eyebrow`, `title`, `notes` | `bullets`, `columns`, `image` | a divider |

An `image` layout with no `image` renders an empty frame with a locate-a-file affordance, not a broken image
and not a blank rectangle.

### Routes

| Route | Method | Purpose |
|---|---|---|
| `/api/artifacts/[id]/ops` | POST | the type-dispatched op endpoint; **SlidePatch batches are one branch** |
| `/api/artifacts/[id]/exports/pptx` | POST | kicks off the export job, returns the job id |
| `/api/artifacts/[id]/slides/[slideId]/notes` | POST | saves speaker notes (a plain user edit, not a patch batch) |

`/api/artifacts/[id]/ops` is **created by Slice 3** for the Canvas BoardDiff. This slice adds a second
branch dispatched on the artifact's type; if Slice 3 has not landed, this slice creates the route with the
`slides` branch and the shared envelope (auth → ownership → load → validate → one version row → respond) and
Slice 3 adds its branch to it. Whichever lands first, the route is written once. The shared envelope lives in
`src/lib/server/services/artifacts/ops.ts`; **do not** grow a second route per type.

### The PPTX export path (the engine, exactly)

```ts
// src/lib/server/services/artifacts/slides/pptx-program.ts
/**
 * Builds a deterministic generator program from a deck body. The deck JSON is
 * inlined as a literal; the program contains no randomness, no network access
 * and no clock reads, so the same body always yields the same slides.
 */
export function buildSlidesPptxProgram(body: SlidesBody, opts: { title: string }): {
	language: "javascript";
	sourceCode: string;
	filename: string;
};
```

Facts this path is built on, verified in the repo:

- **No PPTX renderer exists in `file-production/renderers/`.** `DocumentRenderKind` is
  `"pdf" | "docx" | "html" | "markdown"`, and `selectDocumentOutputs` refuses anything else — so a PPTX
  cannot come from `document_source`. It comes from **`sourceMode: "program"`**.
- **`pptxgenjs` 4.x is already a dependency** (`package.json`), and the JavaScript sandbox runtime
  (`node:22-bookworm-slim`) already bind-mounts the app's `node_modules` read-only at
  `/workspace/node_modules`. The sandbox execution service already patches `pptxgenjs` chart data through a
  `module._load` interceptor, which is independent evidence that this path is in use.
- **`python-pptx` is installed for the Python runtime**: `SANDBOX_PYTHON_PACKAGES` in
  `src/lib/server/sandbox/python-version.ts` includes `python-pptx` (import name `pptx`), installed by
  `scripts/deploy-lib.sh` and verified by `scripts/verify-sandbox-packages.sh`. Both runtimes are therefore
  available; the JavaScript one is chosen because the dependency needs no extra deploy step.
- **Only `/output` is collected** (`OUTPUT_DIR`), the container has no network, the rootfs is read-only, and
  the JS runtime drains 500 ms before exit. The program therefore writes `/output/<name>.pptx` and nothing
  else.
- **Limits:** `maxOutputFileBytes` 100 MiB, `maxTotalOutputBytes` 250 MiB, `SANDBOX_MAX_OUTPUT_FILES` 20,
  `sandboxTimeoutMs` default 5 min. A deck export is one file of a few hundred kB.

The export is **app-initiated**, not model-initiated. The panel calls
`submitFileProductionIntake` with `{ sourceMode: "program", outputs: [{ type: "pptx" }], program: … }`,
exactly as `produce_file` does — `produce_file` stays the engine (§5), and the model-facing tool is not
involved. Consequence worth stating: the `MAX_SAME_TURN_PRODUCE_FILE_SUBMISSIONS` caps do not apply, and the
export shows up as a job-backed card in the conversation like every other produced file.

### i18n

New namespace rows in `src/lib/i18n/artifacts.ts` under `artifacts.slides.*`. Slice 0 owns
`artifacts.card.*` / `artifacts.panel.*`; Slice 3 owns `artifacts.canvas.*` and `artifacts.type.*`
(`artifacts.type.slides` = `Slides` / `Diasor` is Slice 3's row — this slice consumes it).

| Key | EN | HU |
|---|---|---|
| `artifacts.slides.slideCount` | `{count} slides` | `{count} dia` |
| `artifacts.slides.rail` | `Slides` | `Diák` |
| `artifacts.slides.addSlide` | `Add slide` | `Dia hozzáadása` |
| `artifacts.slides.changeLayout` | `Change layout` | `Elrendezés módosítása` |
| `artifacts.slides.duplicateSlide` | `Duplicate slide` | `Dia duplikálása` |
| `artifacts.slides.moveUp` | `Move up` | `Mozgatás fel` |
| `artifacts.slides.moveDown` | `Move down` | `Mozgatás le` |
| `artifacts.slides.deleteSlide` | `Delete slide` | `Dia törlése` |
| `artifacts.slides.deleteSlideConfirm` | `Delete this slide? Its notes go with it.` | `Törlöd ezt a diát? A jegyzetei is törlődnek.` |
| `artifacts.slides.present` | `Present` | `Előadás` |
| `artifacts.slides.presentExit` | `Exit presentation` | `Előadás bezárása` |
| `artifacts.slides.presentNotes` | `Notes` | `Jegyzetek` |
| `artifacts.slides.presentNotesToggle` | `Show notes` | `Jegyzetek megjelenítése` |
| `artifacts.slides.slideNofM` | `Slide {n} of {m}` | `{n}. dia, összesen {m}` |
| `artifacts.slides.askAboutSlide` | `Ask Alfy about this slide` | `Kérdezd Alfyt erről a diáról` |
| `artifacts.slides.askPlaceholder` | `What should change on this slide?` | `Mi változzon ezen a dián?` |
| `artifacts.slides.askSend` | `Ask` | `Küldés` |
| `artifacts.slides.speakerNotes` | `Speaker notes` | `Előadói jegyzetek` |
| `artifacts.slides.speakerNotesEmpty` | `No notes on this slide.` | `Ezen a dián nincsenek jegyzetek.` |
| `artifacts.slides.notesPlaceholder` | `Write what you want to say…` | `Írd le, amit el szeretnél mondani…` |
| `artifacts.slides.notesSaved` | `Notes saved` | `Jegyzetek mentve` |
| `artifacts.slides.titlePlaceholder` | `Slide title` | `Dia címe` |
| `artifacts.slides.subtitlePlaceholder` | `Subtitle` | `Alcím` |
| `artifacts.slides.eyebrowPlaceholder` | `Section label` | `Szakasz címke` |
| `artifacts.slides.bulletPlaceholder` | `List item` | `Listaelem` |
| `artifacts.slides.addBullet` | `Add item` | `Elem hozzáadása` |
| `artifacts.slides.imagePlaceholder` | `Add an image` | `Kép hozzáadása` |
| `artifacts.slides.imageAltlabel` | `Image description` | `Kép leírása` |
| `artifacts.slides.captionPlaceholder` | `Caption` | `Képaláírás` |
| `artifacts.slides.layout.title` | `Title` | `Cím` |
| `artifacts.slides.layout.bullets` | `Bullets` | `Felsorolás` |
| `artifacts.slides.layout.two-column` | `Two columns` | `Két hasáb` |
| `artifacts.slides.layout.image` | `Image` | `Kép` |
| `artifacts.slides.layout.section` | `Section` | `Szakasz` |
| `artifacts.slides.theme.paper` | `Paper` | `Papír` |
| `artifacts.slides.theme.ink` | `Ink` | `Tinta` |
| `artifacts.slides.deckTitle` | `Deck title` | `Diasor címe` |
| `artifacts.slides.emptyDeck` | `Empty deck. Add a slide to start.` | `Üres diasor. Adj hozzá egy diát a kezdéshez.` |
| `artifacts.slides.export` | `Export` | `Exportálás` |
| `artifacts.slides.exportPptx` | `Export as PowerPoint (.pptx)` | `Exportálás PowerPointként (.pptx)` |
| `artifacts.slides.exportQueued` | `Building the deck…` | `A diasor készül…` |
| `artifacts.slides.exportReady` | `The deck is ready.` | `A diasor elkészült.` |
| `artifacts.slides.exportFailed` | `Could not build the deck: {reason}` | `Nem sikerült elkészíteni a diasort: {reason}` |
| `artifacts.slides.exportNoSlides` | `A deck needs at least one slide.` | `A diasorhoz legalább egy dia kell.` |
| `artifacts.slides.refusal.stale_base_hash` | `You changed this after Alfy read it, so its change was not applied` | `Te módosítottad, miután Alfy olvasta, ezért a változtatása nem került rá` |
| `artifacts.slides.refusal.unknown_slide` | `that slide is gone` | `az a dia már nincs meg` |
| `artifacts.slides.refusal.unknown_field` | `that field is not on this layout` | `ez a mező nincs ezen az elrendezésen` |
| `artifacts.slides.refusal.layout_dropped_field` | `the new layout cannot show this content` | `az új elrendezés nem tudja megjeleníteni ezt a tartalmat` |
| `artifacts.slides.refusal.invalid_text` | `the text was empty or too long` | `a szöveg üres vagy túl hosszú volt` |
| `artifacts.slides.refusal.limit_exceeded` | `the deck is at its limit` | `a diasor elérte a korlátját` |
| `artifacts.slides.refusalSummary` | `{count} change(s) were skipped: {reasons}` | `{count} módosítás kimaradt: {reasons}` |
| `artifacts.slides.unsupportedLayout` | `This slide's layout is not available any more.` | `Ez a diaelrendezés már nem érhető el.` |
| `artifacts.slides.tooManySlides` | `A deck can hold at most {max} slides.` | `Egy diasor legfeljebb {max} diát tartalmazhat.` |

## File ownership

| File | Change |
|---|---|
| `src/lib/shared/artifacts/slides.ts` | create — the body types |
| `src/lib/shared/artifacts/slides-patch.ts` | create — the patch types and reasons |
| `src/lib/server/services/artifacts/serialize/slides.ts` + test | create — validate, normalise, caps (`MAX_SLIDES = 120`, `MAX_BULLETS_PER_SLIDE = 12`, `MAX_FIELD_CHARS = 400`, `MAX_NOTES_CHARS = 4000`) |
| `src/lib/server/services/artifacts/ops.ts` + test | create — the shared op-route envelope (Slice 3 adds its branch) |
| `src/lib/server/services/artifacts/slides/pptx-program.ts` + test | create — the deterministic generator script |
| `src/lib/server/services/artifacts/slides/patch.ts` + test | create — `validateSlidePatch`, hashes, refusal reasons |
| `src/lib/components/artifact/slides/SlidesEditor.svelte` + test | create — the lazy panel editor |
| `src/lib/components/artifact/slides/SlideRail.svelte` | create — the slide list and reordering |
| `src/lib/components/artifact/slides/SlideStage.svelte` | create — renders one slide through the registry and owns the editing state |
| `src/lib/components/artifact/slides/layouts/*.svelte` (title, bullets, two-column, image, section) | create — one per registry row |
| `src/lib/components/artifact/slides/EditableText.svelte` | create — the inline text editor (**shared with Slice 1** if it lands first; the same caret-on-click behaviour the Document uses) |
| `src/lib/components/artifact/slides/SpeakerNotes.svelte` | create |
| `src/lib/components/artifact/slides/PresentMode.svelte` + test | create |
| `src/lib/components/artifact/slides/AskAboutSlide.svelte` | create |
| `src/lib/components/artifact/slides/_lib/layout-registry.ts` + test | create |
| `src/lib/components/artifact/slides/_lib/deck.ts` + test | create — `emptyDeck`, `addSlide`, `removeSlide`, `reorder`, `firstSlideIndex` |
| `src/lib/client/api/artifacts.ts` | extend — `saveSlideOps`, `saveSpeakerNotes`, `exportSlidesPptx` (**Slice 0 creates this file**; append) |
| `src/routes/api/artifacts/[id]/ops/+server.ts` + test | create (or extend, if Slice 3 landed first) |
| `src/routes/api/artifacts/[id]/exports/pptx/+server.ts` + test | create |
| `src/routes/api/artifacts/[id]/slides/[slideId]/notes/+server.ts` + test | create |
| `src/lib/i18n/artifacts.ts` + test | extend — `artifacts.slides.*` |
| `tests/e2e/artifact-slides.spec.ts` | create |
| `tests/cross-cutting/incognito-artifact-containment.test.ts` | extend — the slides additions |

## Tasks

### Task T1: The deck model and its serialisation

**Files:** `src/lib/shared/artifacts/slides.ts`, `src/lib/shared/artifacts/slides-patch.ts`,
`_lib/deck.ts` + test, `src/lib/server/services/artifacts/serialize/slides.ts` + test
**Test:** unit

- [ ] **Step 1: Write the failing tests**

```ts
it("round-trips a deck through JSON and normalizeSlidesBody unchanged", ...);
it("drops a slide whose layout id is unknown and reports it", ...);
it("keeps a slide whose optional fields are absent", ...);
it("drops a bullet with an empty id and re-mints it deterministically", ...);
it("caps the slide count and reports how many it dropped", ...);
it("caps bullets per slide and field length", ...);
it("fills a missing deck language from the conversation's language", ...);
it("tolerates a body with a missing aspect by defaulting to 16:9", ...);
it("refuses a body that is not an object at all, without throwing", ...);
it("adds a slide after a given id and at the end", ...);
it("reorders slides by an explicit id order and ignores ids it does not know", ...);
```

- [ ] **Step 2: Run them to verify they fail**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run src/lib/components/artifact/slides/_lib/deck.test.ts \
  src/lib/server/services/artifacts/serialize/slides.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Write the shared types, then `deck.ts` as pure functions, then the server serialiser using the same
validate-never-throw posture as the Canvas body.

- [ ] **Step 4: Run them to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/shared/artifacts src/lib/components/artifact/slides/_lib \
  src/lib/server/services/artifacts/serialize
git commit -m "Give Slides a deck model that survives a reload

A stored deck is user-editable JSON and can be a version behind, so the loader
validates instead of trusting: an unknown layout id is dropped and reported
rather than rendered as raw markup, because layouts are the app's vocabulary and
not the body's."
```

### Task T2: The layouts, the rail and the stage

**Files:** `_lib/layout-registry.ts` + test, `SlideRail.svelte`, `SlideStage.svelte`,
`layouts/*.svelte`, `EditableText.svelte`, `SlidesEditor.svelte`
**Test:** component + e2e

- [ ] **Step 1: Write the failing tests**

```ts
it("has a registry entry for every SlideLayoutId", ...);
it("marks exactly the title layout as a first-slide candidate", ...);
it("marks each layout's forbidden fields", ...);
it("renders only the fields its layout declares", ...);
it("renders an empty image frame for an image layout with no image", ...);
it("never renders model-supplied HTML in any layout", ...);
it("shows the caret on click and commits on blur and on Escape", ...);
it("shows the rail as a filmstrip under 720px and a column above it", ...);
it("changes a slide's layout and keeps the fields the new layout shows", ...);

// e2e (artifact-slides.spec.ts)
it("opens a slides artifact in the panel and paints its first slide", ...);
it("adds a slide from the rail and it lands after the selected one", ...);
it("edits a title in place and the deck JSON carries the new text", ...);
it("reorders slides by dragging in the rail and it persists", ...);
it("shows the five layouts in the change-layout menu, in both languages", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

Write the registry, then the layouts as pure presentational components taking `{slide, editing, bundle}`.
`SlideStage` owns which field is being edited; `EditableText` owns the caret, the Escape behaviour and the
blur-commit. Below 720 px the rail is a horizontal filmstrip and a text edit opens a bottom sheet — this is a
separate layout branch, not a CSS squeeze.

- [ ] **Step 4: Run them to verify they pass**, plus
  `npx vitest run src/lib/components/chat` to prove nothing shared broke. Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/components/artifact/slides src/app.css
git commit -m "Put five fixed layouts and a slide rail in the artifact panel

The model chooses a layout id and fills fields; it never writes markup, so a
stored deck cannot smuggle CSS or HTML into the panel. On a phone the rail
becomes a filmstrip and text edits open a bottom sheet, because a rail plus a
toolbar plus a notes pane on a 390-pixel viewport is the mistake the Document
prototype already made."
```

### Task T3: The patch contract and the refusal

**Files:** `src/lib/server/services/artifacts/slides/patch.ts` + test,
`src/lib/server/services/artifacts/ops.ts` + test, `_lib/hashes.ts`
**Test:** unit + integration

- [ ] **Step 1: Write the failing tests**

```ts
it("hashes a field so the same text yields the same hash", ...);
it("refuses a patch whose baseHash is not the field's current hash", ...);
it("applies every other patch in a batch when one is refused", ...);
it("returns one refusal per refused op, in batch order", ...);
it("refuses a bullet patch on a slide whose layout has no bullets", ...);
it("refuses set_layout when the new layout cannot show content the slide has", ...);
it("accepts set_layout when the slide's content fits the new layout", ...);
it("refuses an empty title and one over the character cap", ...);
it("refuses a whole batch over the op cap without applying part of it", ...);
it("refuses a patch against another user's artifact with a 404", ...);
it("persists an accepted batch as one version with the batch's summary", ...);
it("refuses a batch built on a stale baseVersionId with a 409", ...);
it("keys notes saves as a plain user edit, not an alf y version", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

Write the hashing and validator, then the shared op-route envelope
(`src/lib/server/services/artifacts/ops.ts`: auth → ownership → load → dispatch on type → validate → one
version row → respond) with the Slides branch. If Slice 3 landed first, add the branch to its route instead
of duplicating the envelope.

- [ ] **Step 4: Run them to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/server/services/artifacts src/lib/shared/artifacts/slides-patch.ts
git commit -m "Refuse a slide patch that was written against text the user has since changed

The whole point of editing in place is that neither writer can silently
overwrite the other. A slide field carries the hash the model last read; if the
user typed into it since, the patch is refused with a reason and the rest of the
batch still lands."
```

### Task T4: "Ask Alfy about this slide"

**Files:** `AskAboutSlide.svelte`, `SlideStage.svelte`, `src/lib/client/api/artifacts.ts`
**Test:** component + e2e

The action is a **scoped** request: it sends the slide's own JSON plus the deck's title and language, and the
panel then renders the returned patch batch exactly as the Canvas renders a BoardDiff. It is not a chat
message with an artifact attached — the answer arrives as patches to this slide.

- [ ] **Step 1: Write the failing tests**

```ts
it("sends only the current slide, not the whole deck", ...);
it("includes the deck language so the edit stays in the deck's language", ...);
it("renders the returned refusal notice beside the slide it concerns", ...);
it("shows the pending state while the patch is in flight and clears it on failure", ...);
it("does not create a chat message as a side effect", ...);

// e2e
it("asks about a slide, sees the title change, and sees the version badge advance", ...);
it("refuses when the user edited that same field first, and says why", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

The action posts to the ops route via the panel's own client helper, and reuses the same
refusal-notice component Slice 3 built for a partly-refused BoardDiff (`CanvasBoard`'s notice). If Slice 3
has not landed, create the notice as a shared `artifact/RefusalNotice.svelte` and let Slice 3 adopt it —
one notice, not two.

- [ ] **Step 4: Run them to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/components/artifact/slides src/lib/client/api/artifacts.ts
git commit -m "Ask about one slide, get patches to that slide

The request carries the slide, not the deck, so the model's edit is scoped by
construction rather than by a prompt asking it to stay in scope. The answer
arrives as the same refusable patch batch any other edit does, which is what
keeps the user's own typing safe."
```

### Task T5: Speaker notes and present mode

**Files:** `SpeakerNotes.svelte`, `PresentMode.svelte` + test,
`/api/artifacts/[id]/slides/[slideId]/notes/+server.ts` + test, `src/lib/client/api/artifacts.ts`
**Test:** component + integration + e2e

- [ ] **Step 1: Write the failing tests**

```ts
it("saves notes on blur and shows a saved confirmation", ...);
it("saves notes without minting a version row", ...);
it("refuses notes over the character cap instead of truncating silently", ...);
it("advances with ArrowRight and Space, and goes back with ArrowLeft", ...);
it("exits on Escape and returns focus to the slide it was on", ...);
it("shows the presenter's notes in present mode and hides them by default", ...);
it("announces the slide position to assistive tech", ...);
it("does not autoplay, animate between slides, or capture the pointer", ...);

// e2e
it("presents a deck, walks to the end, and exits back to the panel", ...);
it("keeps the deck's language when presenting", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

Notes save through their own route (a plain user edit; the version stream stays for content a reader would
notice). Present mode is a full-screen surface inside the app shell: no new window, no pointer lock, keyboard
only plus swipe on touch, `aria-live` position announcement, focus trapped while open and restored on exit.

- [ ] **Step 4: Run them to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/components/artifact/slides src/routes/api/artifacts src/lib/client/api/artifacts.ts
git commit -m "Speak a deck out loud, with notes only the speaker sees

Present mode is a surface inside the app, not a new window: it inherits the
session, the theme and the language, and it cannot become a second app the user
has to find again. Notes save on blur and do not mint a version, because a
reader of the deck never sees them."
```

### Task T6: The PPTX export

**Files:** `src/lib/server/services/artifacts/slides/pptx-program.ts` + test,
`/api/artifacts/[id]/exports/pptx/+server.ts` + test, `src/lib/client/api/artifacts.ts`
**Test:** unit + integration + e2e

- [ ] **Step 1: Write the failing tests**

```ts
it("inlines the deck JSON as a literal and imports nothing outside pptxgenjs", ...);
it("opens no network API and reads no clock in the generated program", ...);
it("produces the same program for the same body", ...);
it("writes exactly one file into /output/<slug>.pptx", ...);
it("maps every registry layout to a pptxgenjs layout", ...);
it("carries the deck language into the generator so the text is not translated", ...);
it("refuses an export for a deck with no slides", ...);
it("refuses an export for another user's artifact", ...);
it("submits through the file-production intake with sourceMode program and outputs [pptx]", ...);
it("links the produced file back to the slides artifact as a generated output", ...);
it("surfaces a sandbox failure as a readable message, not a stack", ...);

// e2e
it("exports a deck and the produced file is offered for download", ...);
it("shows the job's failure reason when the export fails", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

Write the program builder and the route. The program is built from the deck body only; it must not read the
clock, the locale, or the network. The produced file links back to the artifact through the existing
file-production link path so the chat shows a job-backed card and the panel shows the export.

**Verified facts the implementation must respect:** the sandbox collects only `/output`; the JavaScript
runtime is `node:22-bookworm-slim` with the app's `node_modules` bind-mounted read-only; `pptxgenjs` is
already a dependency and the execution service already patches its chart data; `python-pptx` is also present
in the Python runtime if the JS path proves unworkable, and switching to it is a change to this one module.

- [ ] **Step 4: Run them to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/server/services/artifacts/slides src/routes/api/artifacts src/lib/client/api/artifacts.ts
git commit -m "Build the PPTX from the deck, not from a model

The generator is app code with the deck JSON inlined, so the export of a given
deck is the same file every time and a bad export is a bug we can read rather
than a generation we have to re-run. It goes through the file-production engine
that produce_file uses, which is what keeps produced files in one ledger."
```

### Task T7: The eval suite 4 gate

**Files:** `scripts/eval-artifact-contracts/` (Slice 5 owns the harness; this slice adds its suite and its
scoring), `tests/e2e/artifact-slides.spec.ts`
**Test:** eval

- [ ] **Step 1: Write the failing suite**

The suite is a fixed list of prompts against a real model, each scored automatically:

```ts
// scripts/eval-artifact-contracts/suites/slides.ts
// 1. "Make a 5-slide deck about the Vienna trip" (HU prompt too)
// 2. "Turn this itinerary into a deck" with the itinerary as source material
// 3. "Make a deck about <topic with numbers>" where the numbers exist only in the source
// 4. "Add a slide about the budget" on an existing deck (an edit, not a create)
it("returns JSON that validates against SlidesBody", ...);
it("uses only registered layout ids", ...);
it("writes the deck in the request's language", ...);
it("finds the request's language through the same detector the title generator uses", ...);
it("invents no number that is absent from the source material", ...);
it("invents no proper noun that is absent from the source material", ...);
it("stays within the slide and bullet caps", ...);
it("fills the fields its chosen layout declares and no forbidden field", ...);
```

Scoring is automatic, not judged by eye: schema validity is a parse; layout ids are a registry lookup;
language is the repo's own detector (`src/lib/server/services/language.ts`); "no invented facts" is a
deterministic extraction of every number and capitalised proper noun in the deck and a check that each
appears in the supplied source material or is a direct arithmetic relation of values in it. The known App
bug classes from §4.5 (wrong key, mislabelled aggregate, wrong unit) are scored by the same verification pass
Slice 2 uses for Apps; suite 4 fails if the verification pass finds a class it cannot classify.

- [ ] **Step 2: Run it to verify it fails**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
node --experimental-strip-types scripts/eval-artifact-contracts/run.ts --only slides
```
Expected: FAIL or a written result below the gate.

- [ ] **Step 3: Record and act on the result**

If the suite passes at the agreed bar, the slice continues. If it does not, **the design changes, not the
evidence** (ADR-0066, spec §8 risk 1): the named fallback is that Alfy *proposes* a deck and the user
approves it slide by slide before it is written. That change is an owner decision — record the measured
result in the slice's PR body and stop.

- [ ] **Step 4: Run it to verify it passes**, or record the decision that changes the design.

- [ ] **Step 5: Commit**

```
git add scripts/eval-artifact-contracts
git commit -m "Gate Slides on the model contract, because Slides was never prototyped

Apps were; decks were not. This runs the real model against real prompts and
scores the answer without a human in the loop: schema, layout ids, language,
and whether a number in the deck came from anywhere. A weak result changes the
design rather than being argued away."
```

### Task T8: i18n, incognito, ownership, archive

**Files:** `src/lib/i18n/artifacts.ts` + test, `tests/cross-cutting/incognito-artifact-containment.test.ts`,
`src/lib/server/services/account-data-archive/*` + test
**Test:** unit + cross-cutting

- [ ] **Step 1: Write the failing tests**

```ts
it("has both en and hu for every artifacts.slides key", ...);
it("never shows the word Artifact in either locale", ...);
it("never lists a deck made in an incognito chat in the library", ...);
it("never picks a deck from an incognito chat as evidence elsewhere", ...);
it("refuses to read another user's deck body, ops, notes or export", ...);
it("carries deck bodies, versions and comments into the account archive", ...);
it("erases deck bodies, versions and comments on account deletion", ...);
it("does not carry deck text into any telemetry event", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

Fill both dictionaries, extend the containment suite's PART A behaviours for slides, extend PART B's guard if
a new file queries `artifacts` by user, and cover the archive and erasure of the deck's rows. If an incognito
test fails, the single ownership scope is wrong: fix the scope, not the test.

- [ ] **Step 4: Run them to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/i18n tests/cross-cutting src/lib/server/services/account-data-archive
git commit -m "Say Diasor, and hold the incognito promise for decks

The Hungarian name is the ratified one, and a deck is a second place the user's
words live, so the promise that an incognito chat is not remembered has to hold
for it too."
```

## Non-goals

- **No free positioning, no per-slide CSS, no custom layouts.** Five layouts, app-owned, and the model picks
  one. This is the decision that keeps the type safe and the export faithful.
- **No transitions, animations, builds or timings.** A slide appears; that is all.
- **No presenter view across two screens**, no audience link, no live polling.
- **No PDF export in this slice.** The mockup's matrix lists `Slides → PPTX · PDF`; the parent spec's Slice 4
  line says "PPTX export through `produce_file`". PDF is a second generator program over the same deck and is
  deliberately not on this slice's critical path — see Open questions.
- **No image generation and no remote images.** An image is an existing artifact or chat file.
- **No charts or tables inside a slide.** A deck that needs one links to the Canvas or Document that has it;
  the layout set stays small.
- **No `.pptx` import.** Uploaded decks stay uploaded files and are not turned into artifacts.
- **No slide comments in this slice.** The comment layer is Slice 1 and Slice 3's; the same
  `artifact_comments` envelope can carry a `slide` anchor later, and this slice does not invent one.
- **No new runtime dependency.**

## Risks

| Risk | Why it bites | Mitigation |
|---|---|---|
| Slides is unprototyped | The model may not hold a structured deck contract, and the whole slice would be built on an unverified assumption | Slice 5's eval suite 4 runs before merge and a weak result changes the design (T7) |
| A refused patch is applied anyway | The user's own typing gets overwritten, which is the exact thing §2.5 protects | `baseHash` per field, server-side refusal, an e2e that edits first and asks Alfy second |
| Model text ends up rendered as markup | An injection surface and a broken layout promise | Layouts render typed fields only; the layout id is validated on load and on write |
| The export program reads a clock or the locale | The same deck exports differently twice and the gate cannot compare | The program is built from the body alone; a test greps the generated source for `Date`, `Math.random` and `Intl` |
| `pptxgenjs` under the sandbox's chart patch behaves differently | The export works in dev and fails in the sandbox | The generator avoids charts entirely (non-goal), and an integration test runs the real sandbox path |
| The phone layout is a squeezed desktop | The rail plus toolbar plus notes is unusable at 390 px | A separate filmstrip + bottom-sheet branch below 720 px, with its own e2e viewport |
| Notes saves mint versions | The version list fills with invisible changes | Notes have their own route and do not append a version |
| Text fields drift between layouts | Moving a slide loses content silently | `layout_dropped_field` is a refusal, not a discard |

## Verification checklist

- [ ] Every task's tests were seen failing first, then green.
- [ ] `npm run check` — 0 errors, 0 warnings.
- [ ] `npx biome check src scripts tests` — clean.
- [ ] `npm test` — green, including the i18n key parity test and the deck unit suites.
- [ ] `npm run build` — 0 warnings.
- [ ] `npx fallow --no-cache --format json --quiet --score` — no new findings, no new ignores.
- [ ] `npx playwright test tests/e2e/artifact-slides.spec.ts tests/e2e/artifacts-panel.spec.ts tests/e2e/chat.spec.ts tests/e2e/incognito-indicator.spec.ts` — green.
- [ ] `node --experimental-strip-types scripts/eval-artifact-contracts/run.ts --only slides` — at or above the agreed bar, with the numbers in the PR body.
- [ ] **Real-app visual check** against `claude-at-home-2-artifact-types-mockups.html` §3 at **1440×900 and 390×844, light and dark**: the eyebrow, the editable heading with its caret, the bullets, the illustration, `Ask Alfy about this slide` and `SPEAKER NOTES` are all present; the filmstrip is a filmstrip on the phone and a column on the desktop; nothing overflows the right edge.
- [ ] **Staging, real model:** "Készíts 5 diás diasort a bécsi útról" → a deck in Hungarian appears, opens in the panel, is answerable with the five layouts, presents full-screen, and edits in place.
- [ ] **Staging:** edit the title of slide 2 myself, then ask Alfy to change the same title → refused, with the reason visible and the rest of the batch applied.
- [ ] **Staging:** export → the job appears in the chat as a card, the `.pptx` downloads, and it opens in PowerPoint/Keynote/LibreOffice with the text and images in place.
- [ ] **Staging:** the same deck inside an **incognito** chat is not listed in the Knowledge library and is not cited by a later normal conversation.
- [ ] Read the staging service journal for new warnings.

## Open questions for the owner

1. **The `layouts` field in the body.** Spec §3 writes Slides as `{layouts, slides[]}`. This slice reads
   `layouts` as the deck's theme/aspect configuration, because a body that could define its own layouts
   would let a stored deck ship its own rendering rules. If something else was meant, only that field's shape
   changes.
2. **Slides → PDF.** The mockup's export matrix lists `PPTX · PDF`; the parent spec's Slice 4 line lists
   PPTX. The honest options are a second generator program (reportlab is not installed, so it would have to
   come from the JS runtime), or PDF derived from the PPTX through the existing document pipeline, or no PDF.
   Which one is wanted?
3. **Prototype first?** Spec §9 question 1 offers to prototype Slides before this slice. This slice answers it
   with the eval harness instead of a prototype (cheaper, and it measures the actual risk). Say so if the
   prototype is wanted anyway.
4. **Images in decks.** The `image` layout accepts an existing artifact or chat file. Whether the model may
   *choose* a library image, and how it would know what exists, is a Slice 5 question (retrieval for
   artifacts) and this slice does not answer it — it accepts whatever id it is given and validates ownership.
