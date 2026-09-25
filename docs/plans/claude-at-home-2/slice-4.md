# Slice 4 — Slides: a deck the user and Alfy edit, and a PPTX at the end

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking. Read `plan.md` first. **This slice needs Slice 0** (the `artifacts/` boundary, the panel shell,
> `ArtifactCard.svelte`, versions, comments, the ops route) and **Slice 1's refusal contract** (a per-block
> `baseHash` patch that the server refuses when the user changed the block since). It does **not** need
> Slice 2 or Slice 3, but it consumes Slice 3's shared op envelope, its route and (if Slice 3 lands it)
> `RefusalNotice.svelte`, and it shares one file with Slice 5
> (`src/lib/components/chat/file-production-helpers.ts`) — see **File ownership** for the landing order. Per
> **ruling 14** this slice supplies the Slides **vocabulary** as its own file and modifies **nothing** inside
> the shared ops module.

**Goal:** Make `Slides` a real artifact type: a deck with a small fixed set of layouts, edited in the panel
slide by slide, presented full-screen, exportable to `.pptx` through the file-production engine, and
editable by Alfy through the same block-addressed, refusable patch contract the Document type uses.

**Architecture:** One lazy-loaded panel editor, `SlidesEditor.svelte`, mounted by the artifact panel when the
open artifact's type is `slides`. The deck is JSON in `artifacts.content_text`:
`{version, layouts, title, language, slides[]}`. Layouts are a closed, app-owned set of **seven** — the model
picks a layout id and fills fields; it never writes markup, CSS or coordinates, and it never mints ids. Text
is edited in place (ADR-0065), each text field is a block with its own hash, and every edit — the user's and
Alfy's — is a version. The PPTX export is a **server-built program** run through the existing file-production
sandbox, not a model call: the deck JSON and its images are inlined into a deterministic generator script, so
the same deck always produces the same file.

**Tech Stack:** SvelteKit + Svelte 5 runes, `@lucide/svelte`, `zod` 4, Vitest, Playwright. No new runtime
dependency. The PPTX generator runs **inside the sandbox** with `python-pptx`, which the deployment already
installs for program mode: `SANDBOX_PYTHON_PACKAGES` includes `python-pptx`
(`src/lib/server/sandbox/python-version.ts:40-45`), mirrored by `scripts/sandbox-python-version.sh:39,42`,
checked by `scripts/verify-sandbox-packages.sh:59`, and named by `scripts/deploy-lib.sh:538` in the warning
that fires when the packages are present but not importable. `pptxgenjs` 4.x is the JavaScript alternative
(`package.json:91`) and switching to it is a change to one module.

**Spec:** `docs/plans/claude-at-home-2-artifacts-spec.md` §1 (the type), §2 (decisions 4, 5, 6, 15),
§3 (the record and the body), §5 (panel, card, export matrix), §6 (Slice 4), §7 (testing). ADRs:
[ADR-0066](../../adr/0066-artifacts-are-a-family-of-five-types.md) (the family; "Artifact" is never shown in
the UI; a type whose contract the model cannot hold changes its design rather than its evidence),
[ADR-0065](../../adr/0065-living-documents-are-edited-in-place.md) (editing in place).
Rulings applied here: `decisions.md` **2** (layouts are code-owned, seven of them, the body carries the deck
theme and slides — the one-layout-set contradiction in this slice's earlier draft is fixed, and Open
questions 1 and 2 are closed by the ruling), **3** (PPTX only in v1; PDF deferred; export through
`sourceMode: "program"` with `python-pptx`), **10** (the panel keeps its path and name), **12** (the hash
substrate needs one canonical form, pinned by a test).

Mockup: `claude-at-home-2-artifact-types-mockups.html` §3 (lines 326-378) — the deck grid
(`.deck{grid-template-columns:118px minmax(0,1fr)}`, `:126`), the thumbnail rail (`.th`, `.th.on`,
`:127-132`), the stage (`.stage`, `:133`), the slide itself (`.sl`, `:134` — `max-width:560px`,
`aspect-ratio:16/9`, `grid-template-columns:1.25fr 1fr`, `padding:26px 30px`), the eyebrow (`.eb`, `:135`),
the editable heading with its caret (`.edbox` `:140`, `.caret` `:139`), the bullets (`:137-138`),
`Ask Alfy about this slide` (`.askslide`, `:143`) and the `SPEAKER NOTES` block (`.notes`, `:141-142`).
The mockup shows **one** layout (`image`-like: eyebrow + heading + bullets + right-column illustration) plus
the panel chrome; the other six layouts are ruling 2's and have no mockup cell, so they inherit this type
scale and spacing rather than inventing their own.

**Feasibility note, stated up front.** Slides is the one type the prototypes did **not** exercise (spec §1:
"not prototyped (lower risk)"). Verified: none of the five prototype branches
(`proto/artifact-canvas`, `proto-canvas-agent`, `proto/artifact-apps-quality`, `proto/artifact-document-editor`,
`proto/artifact-document-editor-r2`) contains a slides or deck prototype route. Spec §9 question 1 asks the
owner whether to prototype it first. This slice therefore treats **Slice 5's eval suite 4 as a hard
precondition**: if slide generation cannot produce valid JSON in the right language without invented facts,
the design changes (Alfy proposes, the user approves) and this slice does not merge. See Task T7.

## Global Constraints

Same as `plan.md` §Global Constraints. In addition, for this slice:

- **Svelte 5 runes only.** `$props()`, `$state`, `$derived`, callback props, `onclick`, `{@render}`.
- **Lucide icons only.** No hand-written `<svg>` for icons. `ContextUsageRing.svelte`-style visualisation
  exceptions do not apply here.
- **Tokens only** from `src/app.css`; the slide surfaces use the existing `--surface-*`, `--text-*`,
  `--border-*` and radius tokens. No hex in a layout component.
- **One deliberate exception, with its reason:** a deck's theme must not follow the app's light/dark mode — a
  `paper` deck shown in dark mode is still a paper deck, and the exported file has to match what the panel
  showed. There is no app token for "always-light slide surface", so the theme palette is one shared constant
  (`src/lib/shared/artifacts/slides-theme.ts`, four values per theme) which the layout components read as CSS
  custom properties (`var(--slide-surface)`, `var(--slide-text)`, `var(--slide-muted)`, `var(--slide-accent)`)
  and the PPTX generator receives as arguments. Hex lives in that one file and in neither a component nor the
  generator.
- **EN + HU in the same commit** for every user-visible string.
- **"Artifact" never appears in the UI.** The type is **Slides** (HU: **Diasor**) — the type name is Slice 3's
  row `artifacts.type.slides`; this slice consumes it and does not redefine it.
- **One user, permanently.** No sharing, no co-editing, no presenter-to-audience link, no exported
  "share a deck" affordance.
- **Ownership checked server-side** on every read and write through the Slice 0 record boundary. The client
  never sends a `userId`.
- **Incognito:** a deck made in an incognito chat is contained like every other artifact (no library listing,
  no retrieval elsewhere) — Task T8.
- **The deck round-trips through `content_text` only.** No side tables for slides, no notes in `artifact_kv`.
- **Layouts are app-owned.** The model's vocabulary is field values and layout ids; a slide whose layout id is
  unknown is dropped-with-report on load and refused on write, never rendered as raw HTML.
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
# Slice 5's harness. `--suite` (not `--only`, which selects fixture ids); `--replay` needs no API key,
# the model run is the real gate. Both read `scripts/eval-artifact-contracts/config.ts`'s EVAL_ARTIFACTS_* switches.
npx tsx scripts/eval-artifact-contracts/run.ts --suite slides --replay
npx tsx scripts/eval-artifact-contracts/run.ts --suite slides --model "$EVAL_MODEL"
```

`tests/e2e/artifacts-panel.spec.ts` is **plural** (ruling 26) — Slice 0 creates that file and every type is
tested through it. The harness runs through `npx tsx`, the same runner Slice 5 documents: node's own
`--experimental-strip-types` does not resolve the SvelteKit `$lib` alias the eval's imports need. The eval run
is a gate, not a report: a slide suite that regresses blocks this slice's merge (Task T7).

## Review Focus

1. **Every text field is a block with its own hash, and the refusal is real (Tasks T3, T5).** If a slide's
   title carries no `baseHash` and a user edit is silently overwritten, the type has broken §2.5 — the
   single decision that makes editing-in-place safe. The e2e test edits a title in the panel, asks Alfy for a
   change to that same title, and asserts the refusal notice plus the fact that the *other* patches landed.
2. **The model never writes markup (Tasks T2, T4).** A slide is a layout id plus typed fields; if a layout
   component ever renders model-supplied HTML, the type has an injection surface and the layout promise is
   gone. The layout id is validated against the registry on load and on write, and the fields a layout cannot
   show are refused rather than ignored.
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
export type SlidesLanguage = "en" | "hu";   // mirrors SupportedLanguage (src/lib/server/services/language.ts:1)
export type SlidesTheme = "paper" | "ink";
export type SlideAspect = "16:9";

/** Ruling 2: the closed, code-owned set. Adding one is a code change plus an i18n row plus a test. */
export type SlideLayoutId =
	| "title"
	| "section"
	| "bullets"
	| "two-column"
	| "image"
	| "quote"
	| "closing";

export type SlideBullet = { id: string; text: string };
export type SlideColumns = { left: SlideBullet[]; right: SlideBullet[] };
export type SlideQuote = { text: string; attribution?: string };

/**
 * An image is a file the user already has. The two variants are the two storage paths the app already
 * serves — `DocumentWorkspaceSource` (src/lib/server/services/knowledge/types.ts:238-240) is exactly
 * `"chat_generated_file" | "knowledge_artifact"`, and both have a download route today. Never a remote URL:
 * the sandbox has no network and a deck must not depend on one.
 */
export type SlideImageSource =
	| { source: "knowledge_artifact"; artifactId: string }
	| { source: "chat_generated_file"; fileId: string };

export type Slide = {
	/** `s_` + 8 hex. Minted by the app; the model never writes an id. */
	id: string;
	layout: SlideLayoutId;
	eyebrow?: string;
	title?: string;
	subtitle?: string;
	/** `b_` + 8 hex ids. */
	bullets?: SlideBullet[];
	/** `two-column` only. */
	columns?: SlideColumns;
	/** `quote` only. */
	quote?: SlideQuote;
	/** `image` only. */
	image?: SlideImageSource;
	imageAlt?: string;
	imageCaption?: string;
	/** Speaker notes. Free text; the model may write them. */
	notes?: string;
};

export type SlidesBody = {
	version: 1;
	/** The deck's own settings. Named `layouts` to match the spec's body shape (§3). */
	layouts: { theme: SlidesTheme; aspect: SlideAspect };
	title: string;
	language: SlidesLanguage;
	slides: Slide[];
};
```

**On the name `layouts`.** Spec §3 writes the Slides body as `{layouts, slides[]}`. Ruling 2 reads it as *deck
theme and aspect*, not as a body-defined layout set, because a body that could define its own layouts would
let a stored deck ship its own rendering rules — and because fixed layouts are what makes the PPTX export
reliable. So `layouts` is the object above, and the layout vocabulary is `SlideLayoutId`, compiled into the
app. Open questions 1 and 2 of the earlier draft are closed by the two rulings and are gone from this file.

**What the model may fill.** The model never writes `id`, never writes `version`, and never writes a value the
chosen layout cannot show. Its payload is the draft shape below; the app mints the ids and normalises.

### The layout contract the model must emit

Two schemas, one shape. The model sends a **draft** (no ids, bullets as plain strings); the normaliser turns it
into the stored **body** (ids minted, layout-legal fields only). Both live in
`src/lib/shared/artifacts/slides-schema.ts` (zod 4 — the repo's tool schemas are zod, e.g.
`normal-chat-tools/produce-file.ts:1,36`) so Slice 5's tool, Slice 4's ask route and the eval suite all
validate against one definition.

```ts
// src/lib/shared/artifacts/slides-schema.ts
import { z } from "zod";
import { SLIDE_LAYOUT_IDS } from "./slides-layouts";   // the const tuple below

export const MAX_SLIDES = 120;
export const MAX_BULLETS_PER_SLIDE = 12;
export const MAX_BULLETS_PER_COLUMN = 8;
export const MAX_EYEBROW_CHARS = 60;
export const MAX_TITLE_CHARS = 140;
export const MAX_SUBTITLE_CHARS = 200;
export const MAX_BULLET_CHARS = 240;
export const MAX_QUOTE_CHARS = 400;
export const MAX_ATTRIBUTION_CHARS = 80;
export const MAX_CAPTION_CHARS = 160;
export const MAX_ALT_CHARS = 200;
export const MAX_NOTES_CHARS = 4000;
export const MAX_DECK_TITLE_CHARS = 160;

/** The model's payload. No ids anywhere: ids are the app's addresses, not the model's to invent. */
export const slideDraftSchema = z
	.object({
		layout: z.enum(SLIDE_LAYOUT_IDS),
		eyebrow: z.string().min(1).max(MAX_EYEBROW_CHARS).optional(),
		title: z.string().min(1).max(MAX_TITLE_CHARS).optional(),
		subtitle: z.string().min(1).max(MAX_SUBTITLE_CHARS).optional(),
		bullets: z.array(z.string().min(1).max(MAX_BULLET_CHARS)).max(MAX_BULLETS_PER_SLIDE).optional(),
		columns: z
			.object({
				left: z.array(z.string().min(1).max(MAX_BULLET_CHARS)).max(MAX_BULLETS_PER_COLUMN),
				right: z.array(z.string().min(1).max(MAX_BULLET_CHARS)).max(MAX_BULLETS_PER_COLUMN),
			})
			.optional(),
		quote: z
			.object({
				text: z.string().min(1).max(MAX_QUOTE_CHARS),
				attribution: z.string().min(1).max(MAX_ATTRIBUTION_CHARS).optional(),
			})
			.optional(),
		/** Only ids the turn's context handed the model may appear here; an unresolvable id is dropped. */
		image: z
			.object({
				source: z.enum(["knowledge_artifact", "chat_generated_file"]),
				id: z.string().min(1),
			})
			.optional(),
		imageAlt: z.string().min(1).max(MAX_ALT_CHARS).optional(),
		imageCaption: z.string().min(1).max(MAX_CAPTION_CHARS).optional(),
		notes: z.string().min(1).max(MAX_NOTES_CHARS).optional(),
	})
	.strict();

export const slidesDraftSchema = z
	.object({
		title: z.string().min(1).max(MAX_DECK_TITLE_CHARS),
		language: z.enum(["en", "hu"]).optional(),
		theme: z.enum(["paper", "ink"]).optional(),
		slides: z.array(slideDraftSchema).min(1).max(MAX_SLIDES),
	})
	.strict();

export type SlideDraft = z.infer<typeof slideDraftSchema>;
export type SlidesDraft = z.infer<typeof slidesDraftSchema>;

export const SLIDE_LAYOUT_IDS = [
	"title", "section", "bullets", "two-column", "image", "quote", "closing",
] as const;
export type SlideLayoutId = (typeof SLIDE_LAYOUT_IDS)[number];
```

`SLIDE_LAYOUT_IDS` lives in `slides-layouts.ts` (a tiny module with no zod import) so the registry, the
client components and the eval scorer can import the id list without pulling zod into the browser bundle.

**The seven layouts.** `fields` is what the layout renders, in reading order; `required` is the minimum for the
slide to make sense (the normaliser drops a slide that fails it, with a report); `forbidden` is what the layout
can never show — a patch that fills one is **refused**, never ignored.

| id | fields | required | forbidden | notes |
|---|---|---|---|---|
| `title` | `eyebrow`, `title`, `subtitle`, `notes` | `title` | `bullets`, `columns`, `quote`, `image` | the deck's opening slide; `firstSlide: true` |
| `section` | `eyebrow`, `title`, `notes` | `title` | `subtitle`, `bullets`, `columns`, `quote`, `image` | a divider between parts |
| `bullets` | `eyebrow`, `title`, `bullets`, `notes` | `title` | `subtitle`, `columns`, `quote`, `image` | the ordinary content slide |
| `two-column` | `title`, `columns`, `notes` | `title` | `subtitle`, `bullets`, `quote`, `image` | comparison-shaped content |
| `image` | `title`, `image`, `imageAlt`, `imageCaption`, `bullets`, `notes` | `title` | `subtitle`, `columns`, `quote` | the mockup's slide 2 (bullets **and** an illustration) |
| `quote` | `quote`, `notes` | `quote` | `eyebrow`, `title`, `subtitle`, `bullets`, `columns`, `image` | one sentence, large, with attribution |
| `closing` | `title`, `subtitle`, `notes` | `title` | `eyebrow`, `bullets`, `columns`, `quote`, `image` | thanks / questions / contact |

An `image` layout with no `image` renders an empty frame with a locate-a-file affordance, not a broken image
and not a blank rectangle. `notes` is on every layout, because a speaker note is about the slide, not about a
field. `notes` is never *rendered* to the audience — only in the panel and in present mode's notes pane.

**One worked example per layout**, in the draft shape (what the model sends) with the stored shape after
normalisation for the first one. Attribution of what the mockup contains: the second example is the mockup's
own slide 2 (HU, `2 · HONNAN ERED?`, three bullets, an illustration).

1. `title` — the deck's opening slide.

```json
{ "layout": "title", "eyebrow": "Iskola", "title": "A Duna", "subtitle": "Kiselőadás Annának · 2026",
  "notes": "Bemutatkozás: ma a Dunáról mesélek, mert Anna ezt kérte." }
```

2. `bullets` — with the mockup's content (the mockup's slide 2, minus the illustration; the illustration case is
   `image` below). Draft in, body out:

```json
{ "layout": "bullets", "eyebrow": "2 · HONNAN ERED?", "title": "Honnan ered a Duna?",
  "bullets": ["A Fekete-erdőben, Németországban", "2 850 km hosszú", "10 országon folyik át"],
  "notes": "Mutasd meg a térképen a forrást." }
```

```json
{ "id": "s_41c0a9e2", "layout": "bullets", "eyebrow": "2 · HONNAN ERED?",
  "title": "Honnan ered a Duna?",
  "bullets": [
    { "id": "b_9a10c4d1", "text": "A Fekete-erdőben, Németországban" },
    { "id": "b_2f77b0e8", "text": "2 850 km hosszú" },
    { "id": "b_c31d88a5", "text": "10 országon folyik át" }
  ],
  "notes": "Mutasd meg a térképen a forrást." }
```

3. `section` — a divider. No bullets: a section slide is a place to pause.

```json
{ "layout": "section", "eyebrow": "Második rész", "title": "Hol találkozunk vele?", "notes": "Rövid szünet." }
```

4. `two-column` — a comparison. Both columns always present in the body (the normaliser fills an empty side
   with `[]`) so the layout has stable geometry.

```json
{ "layout": "two-column", "title": "Itt és ott",
  "columns": {
    "left": ["A Szigetközben lassabb", "Kavicsos a part"],
    "right": ["Budapestnél szélesebb", "Homokos a part"]
  },
  "notes": "Bal oldal: a felső szakasz. Jobb oldal: Budapest." }
```

5. `image` — a picture with optional bullets, exactly the mockup's slide.

```json
{ "layout": "image", "title": "Honnan ered a Duna?",
  "bullets": ["A Fekete-erdőben", "10 országon folyik át"],
  "image": { "source": "knowledge_artifact", "id": "art_7c2f" },
  "imageAlt": "Kézzel rajzolt térképvázlat a Duna vonaláról",
  "imageCaption": "A Duna útja a Fekete-erdőtől a Fekete-tengerig",
  "notes": "Itt mutasd meg a térképen a forrást." }
```

6. `quote` — one sentence, large. The quote is the slide; a title would compete with it.

```json
{ "layout": "quote", "quote": { "text": "A Duna több országon folyik át, mint bármelyik más folyó.",
  "attribution": "Földrajzi atlasz" }, "notes": "Mondd el lassan, és várj egy kicsit utána." }
```

7. `closing` — thanks / questions / contact.

```json
{ "layout": "closing", "title": "Köszönöm a figyelmet!", "subtitle": "Kérdés? Szívesen válaszolok.",
  "notes": "Maradjon idő két kérdésre." }
```

**The normaliser's rules**, in this order (`src/lib/server/services/artifacts/serialize/slides.ts`):

1. Body is not an object, or `slides` is not an array → an empty deck plus a report; never a throw.
2. A slide whose `layout` is not in `SLIDE_LAYOUT_IDS` → dropped, reported (`unknown_layout`).
3. A slide missing a `required` field → dropped, reported (`missing_required_field`).
4. A field that is `forbidden` for the chosen layout → dropped from the slide, reported
   (`field_not_on_layout`). The slide survives: losing one stray bullet beats losing the slide.
5. Bullets and columns get minted ids when missing; an id that does not match `^b_[0-9a-f]{8}$` is re-minted
   (deterministically, from the slide id plus the index) rather than trusted.
6. Caps: slide count, per-slide bullet count, per-column bullet count, per-field characters. Over-cap content
   is dropped, reported with the count; the deck is never refused wholesale for a long bullet.
7. An `image` whose id does not resolve to a file the user owns → the field is dropped, reported
   (`image_not_found`), and the slide renders its empty frame.
8. A missing `language` → filled from `detectLanguage` (`src/lib/server/services/language.ts:195`) over the
   deck's own text, falling back to the conversation's language, falling back to `"en"`.
9. A missing/invalid `aspect` → `"16:9"`; a missing/invalid `theme` → `"paper"`.

The report is `{ dropped: Array<{ slideIndex: number; reason: SlidesDropReason }> }`, returned to the caller and
(only for the panel's own load path) surfaced as one dismissible notice — the same posture as
`normalizeCanvasBody`'s `dropped`. It is **not** stored: the body that is written back is already normalised.

### Text fields are the blocks

Every addressable text field is a block with its own hash, and the hash is what makes a refusal possible:

| Field | `fieldId` | Addressing |
|---|---|---|
| slide title | `"title"` | `{ slideId, fieldId }` |
| subtitle | `"subtitle"` | `{ slideId, fieldId }` |
| eyebrow | `"eyebrow"` | `{ slideId, fieldId }` |
| every bullet | `"b_…"` (its own id) | `{ slideId, fieldId }` |
| every column bullet | `"b_…"` | `{ slideId, fieldId }` — column bullets are bullets, not a special kind |
| quote text | `"quote.text"` | `{ slideId, fieldId }` |
| quote attribution | `"quote.attribution"` | `{ slideId, fieldId }` |
| image caption | `"imageCaption"` | `{ slideId, fieldId }` |
| image alt | `"imageAlt"` | `{ slideId, fieldId }` |
| speaker notes | `"notes"` | `{ slideId, fieldId }` |

`slideId` is **not** hashed (a reorder does not change any text); `layout` is not a text field and is guarded by
`baseHash` of the slide's *content hash* — see `set_layout` below.

`hashSlideField` is `sha256` of the field's text in the canonical form of ruling 12 (trim, collapse internal
runs of whitespace, no trailing newline, NFC), hex-truncated to 16 chars, prefixed with the field's kind
(`t1:` for a single-line field, `tx:` for a multiline field). Two fields with the same text in different slides
hash the same, which is correct: the hash answers "is this the text the model read?", and the target
(`slideId` + `fieldId`) answers "which field?".

### The patch model

One diff shape, shared with Slice 3's route envelope (`POST /api/artifacts/[id]/ops`) and with Slice 3's 409
rule: the request is `{ baseVersionId, diff }`, the response is `{ versionId, applied, refused }`.

```ts
// src/lib/shared/artifacts/deck-ops.ts — the Slides vocabulary (ruling 14). The generic envelope — parse
// `{baseVersionId, diff}`, validate against this vocabulary, apply in order, collect `applied`/`refused` —
// is Slice 3's `src/lib/shared/artifacts/ops.ts`, and this slice changes nothing in it.
import type { SlideBullet, SlideImageSource, SlideLayoutId, SlidesLanguage, SlidesTheme } from "./slides";
import type { SlideDraft } from "./slides-schema";

export type SlideFieldName =
	| "title" | "subtitle" | "eyebrow" | "quote.text" | "quote.attribution" | "imageCaption" | "imageAlt" | "notes";
/** A bullet's id is a field id. Bullets are minted with the `b_` prefix precisely so this is unambiguous. */
export type SlideFieldId = SlideFieldName | `b_${string}`;

export type SlideTarget = { slideId: string; fieldId: SlideFieldId };

export type SlideOp =
	| { op: "replace_text"; target: SlideTarget; baseHash: string; text: string }
	| { op: "add_bullet"; slideId: string; column?: "left" | "right"; after?: string; text: string }
	| { op: "remove_bullet"; slideId: string; bulletId: string; baseHash: string }
	| { op: "reorder_bullets"; slideId: string; column?: "left" | "right"; order: string[] }
	| { op: "set_layout"; slideId: string; baseHash: string; layout: SlideLayoutId }
	| { op: "set_image"; slideId: string; image: SlideImageSource | null; alt?: string; caption?: string }
	| { op: "add_slide"; after?: string; slide: SlideDraft }
	| { op: "remove_slide"; slideId: string }
	| { op: "reorder_slides"; order: string[] }
	| { op: "set_deck"; title?: string; language?: SlidesLanguage; theme?: SlidesTheme };

export const MAX_SLIDE_OPS_PER_DIFF = 60;
export const MAX_NEW_SLIDES_PER_DIFF = 12;

export type SlidesDiff = { id: string; summary: string; ops: SlideOp[] };

export type SlideRefusalReason =
	| "unknown_slide"
	| "unknown_field"
	| "stale_base_hash"
	| "layout_dropped_field"
	| "invalid_text"
	| "invalid_layout"
	| "limit_exceeded";

/** `index` is the op's position in `diff.ops`, so the client can point at the op it refused. */
export type SlideOpRefusal = {
	index: number;
	op: SlideOp["op"];
	slideId?: string;
	target?: SlideTarget;
	reason: SlideRefusalReason;
};

/**
 * Validates against the body as it is right now, in one pass, first-failure-per-op. Returns the ops that
 * apply, in order, plus one refusal per rejected op — a partly-applied batch is still a coherent deck.
 */
export function validateSlidesDiff(
	diff: SlidesDiff,
	body: SlidesBody,
): { accepted: SlideOp[]; refused: SlideOpRefusal[] };
```

`stale_base_hash` is §2.5 exactly: the user changed that field after the model last read it, so the patch is
refused and the model is told, while every other patch in the batch still applies. `layout_dropped_field` is the
one slides-specific refusal: moving a slide to a layout that cannot show the content it has (a `quote` layout
has no bullets) is refused with that reason rather than silently discarding the bullets — the model can then
choose to drop them explicitly in a second op. `invalid_layout` is an unknown layout id (the closed set is the
app's, not the model's).

**Order of validation** (inside `validateSlidesDiff` in `deck-ops.ts`), mirroring Slice 3's
(`slice-3.md §The board `_lib` modules`):

1. `diff.ops.length > MAX_SLIDE_OPS_PER_DIFF` → the whole diff is refused with `limit_exceeded`; nothing is
   applied (a runaway batch is not partly applied).
2. Ops creating slides: more than `MAX_NEW_SLIDES_PER_DIFF`, or the deck would exceed `MAX_SLIDES` → refused
   with `limit_exceeded`.
3. `unknown_slide` — any op naming a `slideId` the deck does not have.
4. `invalid_layout` — `set_layout.layout` not in `SLIDE_LAYOUT_IDS`, or `add_slide.slide.layout` invalid.
5. `unknown_field` — `replace_text`/`remove_bullet` naming a `fieldId` the slide does not have, or one that is
   `forbidden` for the slide's layout (the model cannot fill a field the layout cannot show).
6. `stale_base_hash` — `baseHash` present and not equal to the field's current hash. For `set_layout`, the
   `baseHash` is the slide's **content hash** (`hashSlideContent`: every field's canonical form, joined in
   reading order) so a user edit to any field blocks a layout change the model derived from the old content.
7. `invalid_text` — empty after trim, or over the field's cap.
8. `layout_dropped_field` — `set_layout` where the slide currently holds content the new layout forbids.

Tags are re-checked after the batch is applied: a bullet added to a slide and then referenced by id in a later
op of the same batch is valid (ids are addresses, and the batch creates them earlier, exactly as Slice 3's
`add_node` parent rule works).

### Routes

| Route | Method | Request | Response |
|---|---|---|---|
| `/api/artifacts/[id]/ops` | POST | `{ baseVersionId: string; diff: SlidesDiff \| BoardDiff }` | `200 { ok: true, versionId, version, applied, refused: SlideOpRefusal[] \| BoardRefusal[] }` · `409 { ok: false, reason: "version_conflict", version }` · `404` · `400` (a kind with no `OPS_BRANCHES` row) · `413` |
| `/api/artifacts/[id]/slides/[slideId]/ask` | POST | `{ baseVersionId: string; instruction: string }` | `200 { ok: true, versionId, version, applied, refused, summary }` · `409 { ok: false, reason: "version_conflict", version }` · `422 { ok: false, reason: "no_diff" \| "instruction_too_long" }` · `404 { ok: false, reason: "not_found" }` |
| `/api/artifacts/[id]/exports/pptx` | POST | `{}` | `202 { job: FileProductionJob, reused: boolean }` · `409 { ok: false, reason: "artifact_has_no_conversation" \| "export_image_missing" }` · `422 { ok: false, reason: "export_no_slides" \| "source_too_large" }` (with `job`) |

**The ops route and its envelope already exist** — Slice 3 creates the shared module
`src/lib/shared/artifacts/ops.ts` (the generic mechanism, `decisions.md` ruling 14), the per-type vocabulary
`board-ops.ts`, and the thin route over them, and explicitly asks this slice to *extend* rather than duplicate
(`slice-3.md §Open questions for the owner`, which corrects this slice's earlier "create it"). **This slice
creates `deck-ops.ts` — its vocabulary — registers it at Slice 3's kind-dispatch seam (`OPS_BRANCHES`, the
`Record<ArtifactKind, …>` in `src/lib/server/services/artifacts/ops.ts`, `slice-3.md §File ownership`), and
modifies nothing inside `src/lib/shared/artifacts/ops.ts`.** The envelope's shape and order are both fixed and
shared, so this slice restates neither: the response is Slice 3's
(`{ ok: true, versionId, version, applied, refused: SlideOpRefusal[] }` for this vocabulary), a stale base is
`409 { ok: false, reason: "version_conflict", version }`, and the order is
auth (`requireAuth`, `$lib/server/auth/hooks.ts`) → ownership (`getArtifact`, `slice-0.md §The boundary`) →
`baseVersionId` check (409 before any validation) → dispatch on `kind` → vocabulary validation → one
`updateArtifactBody` call with the batch's summary → respond. If Slice 3 has not landed when this slice
starts, **stop and land Slice 3's route first**: two routes is the failure this seam exists to prevent.

The **ask route is this slice's own**, and it is the panel's "Ask Alfy about this slide": scoped by
construction (the request body carries one slide's id, not the deck), no chat message, no second model
transport in the browser. The server builds the diff and applies it in the same request, through the same
`validateSlidesDiff` and the same version write as the ops route — the model's answer is never applied
unvalidated.

The **export route** is this slice's own; its body is exactly below.

### The PPTX export path (the engine, exactly)

Facts this path is built on, each verified in the repo:

- **No PPTX renderer exists in `file-production/renderers/`.** `DocumentRenderKind` is
  `"pdf" | "docx" | "html" | "markdown"` (`src/lib/shared/file-types/types.ts:65`) and the renderers on disk
  are chart-svg plus standard-report-{docx,html,markdown,pdf} — so a PPTX **cannot** come from
  `document_source`, and it comes from **`sourceMode: "program"`** (ruling 3).
- **`python-pptx` is installed for the Python runtime**: `SANDBOX_PYTHON_PACKAGES` includes it and its import
  name `pptx` (`src/lib/server/sandbox/python-version.ts:40-45,48-53`), mirrored in
  `scripts/sandbox-python-version.sh:39,42`, installed by `scripts/deploy-lib.sh:397` and checked by
  `scripts/verify-sandbox-packages.sh:59`. The shipping `run_python` tool description states it outright:
  "openpyxl, xlsxwriter, python-docx and python-pptx are present for produce_file's program mode, not this
  tool" (`src/lib/server/services/normal-chat-tools/index.ts:300`).
- **`pptxgenjs` 4.0.1 is the JavaScript alternative** (`package.json:91`), and the JS runtime bind-mounts the
  app's `node_modules` read-only at `/workspace/node_modules`
  (`src/lib/server/sandbox/config.ts:34,54,57-58`). The execution service even patches its chart data through a
  `module._load` interceptor (`src/lib/server/services/sandbox-execution.ts:230-240`, which patches the
  module named `pptxgenjs`) — independent evidence that path is in use. Switching to it is a change to
  `pptx-program.ts` alone.
- **Python is the chosen runtime** (ruling 3 names `python-pptx`). Its bootstrap is
  `import os; os.makedirs('/output', exist_ok=True); <code>` (`sandbox-execution.ts:253-257`), so the program
  can assume `/output` exists and writes `prs.save("/output/<name>.pptx")` there and nothing else.
- **Only `/output` is collected** (`OUTPUT_DIR = "/output"`, `sandbox-execution.ts:43`), the container has no
  network (`config.ts:353`), the rootfs is read-only (`config.ts:355`) with a writable tmpfs at `/output`
  (`config.ts:365-371`), and the produced filename is whatever basename the sandbox finds in `/output`
  (`sandbox-execution.ts:283,364-367`) — so the program's own `save` path decides the produced file's name.
- **The effective deadline** for a file-production program is `limits.sandboxTimeoutMs`
  (`execution-adapter.ts:635-648`), default 5 min (`limits.ts:82`), admin key `fileProductionSandboxTimeoutMs`
  (`config-store.ts:332`). The hard-coded 90 s Python / 135 s JS constants
  (`sandbox/config.ts:11-12`) apply only to callers that do not pass a timeout (`run_python`).
- **The other caps** the export inherits: `maxRequestedOutputs` 5 (`limits.ts:71`), `maxSourceJsonBytes` 2 MiB
  (`limits.ts:72` — measured on `JSON.stringify(requestJson)`, `intake.ts:720-723`),
  `maxOutputFileBytes` 100 MiB and `maxTotalOutputBytes` 250 MiB (`limits.ts:84-85`), plus the sandbox's own
  `SANDBOX_MAX_OUTPUT_FILES` 20 and its in-memory extraction. A deck export is one file of a few hundred kB;
  the binding cap is `maxSourceJsonBytes` when images are inlined (see **Limits and configuration**).
- **The intake body contract** (`intake.ts:460-503,611-671`): `conversationId`, `idempotencyKey` and
  `requestTitle` are required (400 each when missing); `sourceMode` must be `program`/`document_source`/
  `inline_text` (422 `unsupported_source_mode`); program mode needs `program.language` of `python` or
  `javascript` (422 `invalid_program_language`) and a non-empty `program.sourceCode` (422
  `missing_program_source`), and an output type from `requestedOutputs`/`outputs` or a `filename` extension
  (422 `missing_program_output_type`, 422 `unsupported_program_output_type`). A caller-authored
  `program.sourceCode` is exempt from the mixed-output-family rule (`intake.ts:524-527`).
- **`pptx` is a producible, requestable output type** — `src/lib/shared/file-types/table.ts:739-760`
  (`production.requestable: true`, `types.pptx: ".pptx"`), and the app can preview it
  (`preview.kind: "pptx"`, backed by `pptxviewjs` `package.json:92`).

**The generator.**

```ts
// src/lib/server/services/artifacts/slides/pptx-program.ts
export interface SlidesPptxProgramInput {
	body: SlidesBody;
	/** The deck's own title, un-translated: it is data, not UI copy. */
	title: string;
	/** Already inlined as `data:` URIs, keyed by the slide id that uses them. */
	images: Record<string, { dataUri: string; mimeType: string } | undefined>;
	/** The theme palette (slides-theme.ts) so the export matches the panel exactly. */
	theme: SlideThemePalette;
}

/**
 * Builds a deterministic generator program from a deck body. The deck JSON, the theme palette and every
 * image's bytes are inlined as literals; the program contains no randomness, no network access and no
 * clock reads, so the same body always yields the same slides.
 */
export function buildSlidesPptxProgram(input: SlidesPptxProgramInput): {
	language: "python";
	sourceCode: string;
	filename: string;   // "<slug>.pptx"; the type hint AND the name the program writes under /output
};
```

The program is built from the body alone: one function per registry layout, absolute positions in inches on a
13.333 × 7.5 in (16:9) canvas (the mockup's `16/9` slide and its `1.25fr 1fr` split become `x=0.55 … 7.6` and
`7.9 … 12.78`), the theme palette's four colours, `add_textbox` + `text_frame` for text, `add_picture` from a
`BytesIO` of the inlined bytes for images, `slide.notes_slide.notes_text_frame.text = …` for notes, and
`prs.save("/output/" + FILENAME)`. The generated source is a template literal with the JSON embedded through a
single `JSON.stringify` call and **no `f-string` interpolation of user text** (a quote character in a deck must
not be able to break the program).

> **Unverified in this session, and marked so:** the exact `python-pptx` API surface used above
> (`prs.slide_width`/`slide_height`, blank-layout index, `add_textbox`, `add_picture(BytesIO(…))`,
> `notes_slide.notes_text_frame`) is **not** verifiable on this machine — `python-pptx` is not installed
> locally (`import pptx` fails) and the package's own source is not in the repo. The implementer must confirm
> it where it runs: `npx tsx` a `run_python` call on the box, or read the installed package through
> `scripts/verify-sandbox-packages.sh`. Everything else in this section is read from the repo and cited.
> If one call in that list proves wrong, it is a change inside this one function, not to the design.

**The export route.**

```ts
// src/routes/api/artifacts/[id]/exports/pptx/+server.ts
export const POST: RequestHandler = async (event) => { … };
```

Order, and this order is the contract:

1. `requireAuth` → the **302** to `/login` at this layer (`$lib/server/auth/hooks.ts:9-15`); an unauthenticated
   `/api/**` fetch is answered **401** by `hooks.server.ts` before the route runs (`decisions.md` ruling 19).
2. `getArtifact({ userId, artifactId })` → 404 `not_found` for another user's deck, never a 403
   (`slice-0.md §The boundary`).
3. Parse and normalise the body (the same `normalizeSlidesBody` the panel uses) → 422 `export_no_slides` when
   the deck has no slides left after normalisation.
4. `artifact.conversationId` — intake requires one (`intake.ts:480-487`). A deck with no conversation **cannot
   be exported**: 409 `artifact_has_no_conversation`. (An artifact created outside a chat has
   `conversationId: null`, `slice-0.md §The boundary`.)
5. Read every referenced image through the ownership-scoped byte readers —
   `readChatFileContentByUser(fileId, userId)` (`src/lib/server/services/chat-files.ts:1113`) for
   `chat_generated_file`, `resolveWorkingDocumentFileServing({ userId, artifactId, mode: "download" })`
   (`src/lib/server/services/knowledge/store/working-document-file-serving.ts:35`) for `knowledge_artifact` —
   and base64-inline them. Any image that is missing or unreadable → 409 `export_image_missing` **before** a
   job is created, so a broken deck does not burn a sandbox run.
6. Pre-check the built source against the **same** limits module the intake uses
   (`getFileProductionLimits(getConfig())`, `limits.ts:98-156`): over `maxSourceJsonBytes` → 422
   `source_too_large`. No second limit constant; this only saves the round trip, the intake re-checks.
7. Submit, exactly as `produce_file` does, through the public facade
   (`src/lib/server/services/file-production/index.ts:226`, the same function `produce_file` calls in-process
   at `normal-chat-tools/index.ts:1444`, and the only thing the HTTP adapter
   `src/routes/api/chat/files/produce/+server.ts:98` wraps):

```ts
const result = await submitFileProductionIntake({
	userId,
	body: {
		conversationId: artifact.conversationId,
		// Data, not copy: the deck's own title. Never translated by the server.
		requestTitle: deck.title,
		// Deterministic per (deck, version): re-clicking Export on the same version returns the same job
		// instead of a second card. Unique on (user_id, conversation_id, idempotency_key)
		// (src/lib/server/db/schema.ts:1610-1614), and the ledger reuses any existing row regardless of
		// status (job-ledger.ts:216-246), so a failed export is retried from the card, not duplicated.
		idempotencyKey: `slides-export:${artifactId}:${versionId}`,
		sourceMode: "program",
		requestedOutputs: [{ type: "pptx" }],
		program: { language: "python", sourceCode, filename },
	},
});
```

8. Map the result with the intake's own response shape (`{ job, reused }` at 202, `{ error, job }` at the
   failure status — `produce/+server.ts:60-76`) and never a stack: the intake's failures already carry a code
   from a fixed vocabulary and its job row.
9. **No produced-file link is written to the artifact in v1.** The `.pptx` appears where every produced file
   appears: a job-backed card in the conversation, downloadable through the canonical
   `/api/chat/files/[id]/download`. The panel knows only the `jobId` it was handed. See **Open questions** 1.

**The failure path when the sandbox is unavailable** — the honest sequence, because the job row exists before
the sandbox is touched (intake persists the job, then the worker runs it):

| What happened | Where | `job.error.code` | Card shows (EN / HU) | Retry? |
|---|---|---|---|---|
| Docker unreachable, image pull refused, container create failed | `execution-adapter.ts:686-694` catch | `program_execution_threw` | the raw message, **host paths redacted to `<path>`** (`error-message.ts:29-38`) | yes (`retryable: true`) |
| The program hit the deadline | `execution-adapter.ts:672-678` | `sandbox_timeout` | "Program execution timed out." / "A program futása időtúllépés miatt leállt." (`i18n/chat.ts:678,1788`) | yes |
| The program exited non-zero (e.g. a bad API call in the generator) | `execution-adapter.ts:672-678` | `program_execution_failed` | the program's own stderr line, redacted | yes |
| The program wrote no file | the sandbox's zero-output path | `program_execution_failed` (or the empty-output 422 when it is a real zero-output run) | same as above | yes |
| The program wrote a partial file and then failed | `acceptOutputWrittenBeforeFailedExit` (`execution-adapter.ts:650-661`) | **accepted** — the partial output is kept with a warning | the file is offered, the warning is on the job | — |
| Source over 2 MiB (inlined images) | `intake.ts:720-755` | `source_too_large` | "The file production source is too large." / "A fájlkészítés forrása túl nagy." (`i18n/chat.ts:679,1788`) | no |

The card that renders all of this already exists: `FileProductionCard.svelte` with its
`ERROR_MESSAGE_KEYS` map (`FileProductionCard.svelte:29`, read at `:119`). The panel **reuses the card** for its export row
(`<FileProductionCard job={exportJob} onRetry={…} />`) instead of inventing a second failure UI, and the
`code → i18n key` map moves from the card into the shared
`src/lib/components/chat/file-production-helpers.ts` as `fileProductionErrorKey(code)` so there is exactly one
map. The panel's "Try again" calls the existing `retryFileProductionJob(jobId)`
(`src/lib/client/api/file-production.ts:8`) — no new retry route.

### i18n

New namespace rows in `src/lib/i18n/artifacts.ts` under `artifacts.slides.*`. **Slice 0 owns that file**
(creates it, registers it in `I18N_MODULES` and adds `artifacts.` to `AUDITED_PREFIXES`, `slice-0.md §i18n`);
this slice appends its rows and its test cases. Slice 1 owns `artifacts.document.*`, Slice 3 owns
`artifacts.canvas.*`, and the shared `artifacts.type.*` names are **Slice 0's** (ruling 22) —
`artifacts.type.slides` = `Slides` / `Diasor` is one of Slice 0's five rows, and this slice consumes it.

| Key | EN | HU |
|---|---|---|
| `artifacts.slides.rail` | `Slides` | `Diák` |
| `artifacts.slides.slideCount` | `{count} slides` | `{count} dia` |
| `artifacts.slides.addSlide` | `Add slide` | `Dia hozzáadása` |
| `artifacts.slides.changeLayout` | `Change layout` | `Elrendezés módosítása` |
| `artifacts.slides.duplicateSlide` | `Duplicate slide` | `Dia duplikálása` |
| `artifacts.slides.moveUp` | `Move up` | `Mozgatás fel` |
| `artifacts.slides.moveDown` | `Move down` | `Mozgatás le` |
| `artifacts.slides.deleteSlide` | `Delete slide` | `Dia törlése` |
| `artifacts.slides.deleteSlideConfirm` | `Delete this slide? Its notes go with it.` | `Törlöd ezt a diát? A jegyzetei is törlődnek.` |
| `artifacts.slides.present` | `Present` | `Előadás` |
| `artifacts.slides.presentExit` | `Exit presentation` | `Előadás bezárása` |
| `artifacts.slides.presentNotesToggle` | `Show notes` | `Jegyzetek megjelenítése` |
| `artifacts.slides.presentHint` | `Space or → for the next slide, Esc to exit` | `Szóköz vagy → a következő diára, Esc a kilépéshez` |
| `artifacts.slides.slideNofM` | `Slide {n} of {m}` | `{n}. dia, összesen {m}` |
| `artifacts.slides.askAboutSlide` | `Ask Alfy about this slide` | `Kérdezd Alfyt erről a diáról` |
| `artifacts.slides.askPlaceholder` | `What should change on this slide?` | `Mi változzon ezen a dián?` |
| `artifacts.slides.askSend` | `Ask` | `Küldés` |
| `artifacts.slides.askWorking` | `Alfy is rewriting this slide…` | `Alfy átírja ezt a diát…` |
| `artifacts.slides.askNoChange` | `Alfy did not find anything to change.` | `Alfy nem talált változtatnivalót.` |
| `artifacts.slides.speakerNotes` | `Speaker notes` | `Előadói jegyzetek` |
| `artifacts.slides.speakerNotesEmpty` | `No notes on this slide.` | `Ezen a dián nincsenek jegyzetek.` |
| `artifacts.slides.notesPlaceholder` | `Write what you want to say…` | `Írd le, amit el szeretnél mondani…` |
| `artifacts.slides.titlePlaceholder` | `Slide title` | `Dia címe` |
| `artifacts.slides.subtitlePlaceholder` | `Subtitle` | `Alcím` |
| `artifacts.slides.eyebrowPlaceholder` | `Section label` | `Szakasz címke` |
| `artifacts.slides.bulletPlaceholder` | `List item` | `Listaelem` |
| `artifacts.slides.addBullet` | `Add item` | `Elem hozzáadása` |
| `artifacts.slides.quotePlaceholder` | `Write the quote…` | `Írd be az idézetet…` |
| `artifacts.slides.attributionPlaceholder` | `Who said it` | `Kitől származik` |
| `artifacts.slides.imagePlaceholder` | `Add an image` | `Kép hozzáadása` |
| `artifacts.slides.imagePick` | `Choose from your files` | `Választás a fájljaidból` |
| `artifacts.slides.imageAltLabel` | `Image description` | `Kép leírása` |
| `artifacts.slides.captionPlaceholder` | `Caption` | `Képaláírás` |
| `artifacts.slides.layout.title` | `Title` | `Cím` |
| `artifacts.slides.layout.section` | `Section` | `Szakasz` |
| `artifacts.slides.layout.bullets` | `Bullets` | `Felsorolás` |
| `artifacts.slides.layout.two-column` | `Two columns` | `Két hasáb` |
| `artifacts.slides.layout.image` | `Image` | `Kép` |
| `artifacts.slides.layout.quote` | `Quote` | `Idézet` |
| `artifacts.slides.layout.closing` | `Closing` | `Zárás` |
| `artifacts.slides.theme.paper` | `Paper` | `Papír` |
| `artifacts.slides.theme.ink` | `Ink` | `Tinta` |
| `artifacts.slides.deckTitle` | `Deck title` | `Diasor címe` |
| `artifacts.slides.emptyDeck` | `Empty deck. Add a slide to start.` | `Üres diasor. Adj hozzá egy diát a kezdéshez.` |
| `artifacts.slides.loadFailed` | `This deck could not be opened.` | `Ezt a diasort nem sikerült megnyitni.` |
| `artifacts.slides.reload` | `Reload` | `Újratöltés` |
| `artifacts.slides.droppedContent` | `{count} item(s) were left out: {reasons}` | `{count} elem kimaradt: {reasons}` |
| `artifacts.slides.drop.unknown_layout` | `unknown layout` | `ismeretlen elrendezés` |
| `artifacts.slides.drop.missing_required_field` | `missing a required field` | `hiányzik egy kötelező mező` |
| `artifacts.slides.drop.field_not_on_layout` | `not shown by this layout` | `ezen az elrendezésen nem látszik` |
| `artifacts.slides.drop.image_not_found` | `the image is not available` | `a kép nem érhető el` |
| `artifacts.slides.drop.limit_exceeded` | `over the limit` | `túl a korláton` |
| `artifacts.slides.export` | `Export` | `Exportálás` |
| `artifacts.slides.exportPptx` | `Export as PowerPoint (.pptx)` | `Exportálás PowerPointként (.pptx)` |
| `artifacts.slides.exportQueued` | `Building the deck…` | `A diasor készül…` |
| `artifacts.slides.exportReady` | `The deck is ready. It is in the chat.` | `A diasor elkészült. A beszélgetésben találod.` |
| `artifacts.slides.exportRetry` | `Try again` | `Újrapróbálás` |
| `artifacts.slides.exportNoSlides` | `A deck needs at least one slide.` | `A diasorhoz legalább egy dia kell.` |
| `artifacts.slides.exportNoConversation` | `This deck is not part of a chat, so it cannot be exported.` | `Ez a diasor nem része beszélgetésnek, ezért nem exportálható.` |
| `artifacts.slides.exportImageMissing` | `An image in this deck is not available, so nothing was exported.` | `A diasor egyik képe nem érhető el, ezért nem készült export.` |
| `artifacts.slides.exportTooLarge` | `This deck is too large to export.` | `Ez a diasor túl nagy az exportáláshoz.` |
| `artifacts.slides.refusal.stale_base_hash` | `You changed this after Alfy read it, so its change was not applied` | `Te módosítottad, miután Alfy olvasta, ezért a változtatása nem került rá` |
| `artifacts.slides.refusal.unknown_slide` | `that slide is gone` | `az a dia már nincs meg` |
| `artifacts.slides.refusal.unknown_field` | `that field is not on this layout` | `ez a mező nincs ezen az elrendezésen` |
| `artifacts.slides.refusal.layout_dropped_field` | `the new layout cannot show this content` | `az új elrendezés nem tudja megjeleníteni ezt a tartalmat` |
| `artifacts.slides.refusal.invalid_layout` | `that layout does not exist` | `ez az elrendezés nem létezik` |
| `artifacts.slides.refusal.invalid_text` | `the text was empty or too long` | `a szöveg üres vagy túl hosszú volt` |
| `artifacts.slides.refusal.limit_exceeded` | `the deck is at its limit` | `a diasor elérte a korlátját` |
| `artifacts.slides.refusalSummary` | `{count} change(s) were skipped: {reasons}` | `{count} módosítás kimaradt: {reasons}` |
| `artifacts.slides.staleVersion` | `The deck changed while you were away. The newest version is loaded.` | `A diasor megváltozott, amíg nem nézted. A legújabb változat töltődött be.` |
| `artifacts.slides.tooManySlides` | `A deck can hold at most {max} slides.` | `Egy diasor legfeljebb {max} diát tartalmazhat.` |

The refusal reasons are one table, rendered by one shared notice component — `src/lib/components/artifacts/
RefusalNotice.svelte`, **created by Slice 1** (its T8) at the shared root, not inside a type's directory — so a
new reason is one i18n row and no new UI, and no type grows a second notice.

## Failure modes

Every one of these is a user-visible line plus a server code; none of them is a stack trace.

| What happened | Server | User sees (EN / HU) |
|---|---|---|
| The model's deck JSON does not parse, or fails `slidesDraftSchema` | Slice 5's tool returns its own tool-error; the body is never written | the tool result's message on the message surface; the deck is not created |
| The model sends an unknown layout id on create | normaliser drops the slide and reports; the rest of the deck is created | `artifacts.slides.droppedContent` with `artifacts.slides.drop.unknown_layout` (EN / HU above) |
| The model's patch targets a field that moved on | ops route 200 with `refused[].reason = "stale_base_hash"` | `artifacts.slides.refusal.stale_base_hash` in the notice, beside the slide it concerns |
| The whole batch was written against an older version | ops route **409** `{ ok: false, reason: "version_conflict", version }`, nothing applied | `artifacts.slides.staleVersion`; the panel reloads the newest version and keeps the user's caret where it was |
| The deck body in `content_text` is not JSON, or not an object | the panel's load path returns `{ body: null, dropped: [...] }`; the route answers 200 with the raw body and the report | `artifacts.slides.loadFailed` + `artifacts.slides.reload`; the panel is not blank and not crashed |
| The network drops mid-edit | the ops POST rejects; the panel keeps the user's text on screen, marks the field unsaved, and retries on the next blur or on `Reload` | `fileProduction`-style inline "not saved" state: `artifacts.slides.refusal`-independent — the field shows a `--status-danger` dot and its text is not lost |
| The artifact is deleted while it is open | the next ops/ask/export call gets **404** `not_found` | the panel closes with a toast: `artifacts.card` is gone from the list; the chat page's own refresh drops the card |
| Another user's deck | **404** `not_found` (never 403) | the panel does not open at all |
| An incognito deck opened from a normal chat | **404** `not_found` — the ownership scope excludes it (`getArtifactOwnershipScope`, `knowledge/store/core.ts:141`) | as above |
| No permission to export a deck with no conversation | **409** `artifact_has_no_conversation` | `artifacts.slides.exportNoConversation` |
| An inlined image is gone | **409** `export_image_missing`, no job | `artifacts.slides.exportImageMissing` |
| The sandbox is unavailable | job persisted, then `program_execution_threw` / `sandbox_timeout` / `program_execution_failed` (retryable) | the reused `FileProductionCard` line, host paths redacted to `<path>` |
| The deck has no slides | **422** `export_no_slides`, no job | `artifacts.slides.exportNoSlides` |
| The ask instruction is empty or over 1000 chars | **422** `instruction_too_long` / the button stays disabled | `artifacts.slides.askPlaceholder` with the button disabled |
| The ask returns no usable diff | **200** `{ applied: 0, refused: [], summary: null }` | `artifacts.slides.askNoChange` (deliberately not an error: "nothing to change" is an answer) |

## Limits and configuration

| Limit | Value | Where it is read | Overridable |
|---|---|---|---|
| `MAX_SLIDES` | 120 | `slides-schema.ts` | no — code-owned, like the layout set (a 120-slide deck is already 40 minutes of talking) |
| `MAX_BULLETS_PER_SLIDE` / `MAX_BULLETS_PER_COLUMN` | 12 / 8 | `slides-schema.ts` | no |
| Field character caps | 60–4000 (the table above) | `slides-schema.ts` | no |
| `MAX_SLIDE_OPS_PER_DIFF` / `MAX_NEW_SLIDES_PER_DIFF` | 60 / 12 | `deck-ops.ts` — the Slides vocabulary's own caps, mirroring Slice 3's `MAX_OPS_PER_DIFF` 40 / `MAX_NEW_NODES_PER_DIFF` 24 (`slice-3.md §Limits and configuration`) | no |
| Ask instruction | 1000 chars | `slides/ask.ts` | no |
| Ask attempts | 2 (Slice 3's control pattern allows more; a slide edit is cheap to retry and the second attempt gets the validator's reason) | `slides/ask.ts` | no |
| `maxRequestedOutputs` | 5 | `getFileProductionLimits(getConfig())` → `limits.ts:71` ← `config-store.ts:321` | yes, `FILE_PRODUCTION_MAX_OUTPUTS` |
| `maxSourceJsonBytes` | 2 MiB | `limits.ts:72` ← `config-store.ts:322` | yes, `FILE_PRODUCTION_MAX_SOURCE_JSON_BYTES` |
| `sandboxTimeoutMs` | 5 min | `limits.ts:82` ← `config-store.ts:332` | yes, `FILE_PRODUCTION_SANDBOX_TIMEOUT_MS` |
| `maxOutputFileBytes` / `maxTotalOutputBytes` | 100 MiB / 250 MiB | `limits.ts:84-85` ← `config-store.ts:334-335` | yes |
| Sandbox's own `SANDBOX_MAX_OUTPUT_FILES` | 20 | `sandbox/config.ts:15` | no (hard-coded; one export writes one file) |
| Sandbox hard-coded deadline (Python / JS) | 90 s / 135 s | `sandbox/config.ts:11-12`, used only when a caller passes no timeout — file production passes `sandboxTimeoutMs` | no; the export is not bounded by these |
| Theme palette (4 colours × 2 themes) | literal | `src/lib/shared/artifacts/slides-theme.ts` | no, and deliberately: a deck's theme is not the app's theme (see Global Constraints) |

**The one interaction worth stating out loud:** images are inlined as base64 into the persisted
`requestJson`, which `intake.ts:720-723` measures against `maxSourceJsonBytes` (2 MiB) — so a deck's combined
inlined image bytes must stay under roughly 1.4 MiB. That is why step 6 of the export route pre-checks with the
same limits module and why the cap is a 422 with the existing `source_too_large` copy rather than a mysterious
sandbox failure. A deck with a 3 MiB photo export refuses with a readable line; the fix for the user is a
smaller image. Raising the cap is an admin change to `FILE_PRODUCTION_MAX_SOURCE_JSON_BYTES`, not a code change.

## UI states

`SlidesEditor.svelte` (lazy entry, mounted by the panel when `kind === "slides"`), `SlideRail.svelte`,
`SlideStage.svelte`, `layouts/*.svelte`, `EditableText.svelte`, `SpeakerNotes.svelte`, `PresentMode.svelte`,
`AskAboutSlide.svelte`.

**Desktop, 1440 × 900.** The panel is the app's existing artifact panel; the deck grid is the mockup's
(`.deck`, `:126`): a **118 px** thumbnail rail, then the stage. The stage centres a slide capped at
**560 px** wide with `aspect-ratio: 16/9`, `border-radius: 6px`, `box-shadow` from the token scale, and the
`1.25fr 1fr` content split. The rail is a column: each thumbnail is a 16:9 mini-slide (`.th .s`, `:129`) with
the slide number, the current one outlined 2 px in `--accent` (`.th.on`, `:132`), and `+ Add slide` under the
list. The stage holds the slide, then the notes block below it (`.notes`, `:141`), then the
`Ask Alfy about this slide` pill anchored to the slide's bottom-right corner (`.askslide`, `:143`).

| State | Where | What the user sees |
|---|---|---|
| **Loading** | `SlidesEditor.svelte`, while its chunk loads | the rail shows 3 grey 16:9 placeholders and the stage an empty slide frame in `--surface-elevated`; no spinner; a 1.4 s opacity pulse suppressed under `prefers-reduced-motion` |
| **Empty deck** | `SlideStage.svelte` | `artifacts.slides.emptyDeck` centred in the slide frame, plus the `Add slide` button in the rail; `Present` and `Export` are disabled (`aria-disabled`, not hidden) |
| **Error (body unreadable)** | `SlidesEditor.svelte`'s error state | a centred card: `--surface-elevated`, a `CircleAlert` icon in `--status-danger`, `artifacts.slides.loadFailed`, and a `Reload` button. The rail is rendered empty rather than half-built |
| **Error (dropped content)** | one dismissible notice above the stage | `artifacts.slides.droppedContent` with the count and the reason list; `--status-warning`; the deck renders anyway |
| **Long content** | `SlideRail.svelte` scrolls internally (never the page); `SpeakerNotes.svelte` scrolls internally after ~6 lines; a long bullet wraps to 3 lines in the slide and then clips with the field's own caret still reachable; a long deck's rail keeps the current thumbnail in view on selection change | the panel never grows the page |

**Phone, 390 × 844.** Below **720 px** the deck grid becomes a **different layout**: the rail is a horizontal
filmstrip (fixed 96 px tall, thumbnails 24 px wide plus a `+` tile, `overflow-x: auto`, the current one
outlined) docked above the slide, and the slide is scaled to fit the available width for **reading**. Tapping a
text field opens a **bottom sheet** — `role="dialog"`, `aria-modal="true"`, a focus trap, the field's text at
`--text-base`, a `Done` button, `Escape` closes and returns focus to the field — because 13 px slide text
scaled to 390 px is ~9 px and untypeable. The Document prototype's 29 %-of-390 px toolbar is the mistake this
avoids: there is **no** toolbar on the phone; the rail, the slide and one sheet is the whole surface. Present
mode at 390 px defaults the notes pane **on** (see **Open questions** 2).

**Focus and keyboard order**, top to bottom, at both widths:

1. the panel header's own controls (Slice 0's: close, versions, actions) — then this slice's `Present` and
   `Export` buttons,
2. the rail: one tab stop with a **roving tabindex** over the thumbnails; `ArrowUp`/`ArrowDown` (or
   `ArrowLeft`/`ArrowRight` in filmstrip mode) move between slides and **select** as they move; `Backspace`
   opens the delete confirmation; the `+` tile is the last stop,
3. the stage: the current slide's fields in reading order (`eyebrow` → `title` → `subtitle` → `bullets…` /
   `columns` → `quote` → `image` → `caption`), each a single tab stop; `Enter` (or a click) starts editing,
   `Escape` cancels, `blur` commits,
4. `SpeakerNotes`, then
5. `Ask Alfy about this slide` (a button; `Enter` opens the input, `Escape` closes it).

Present mode traps focus while open and **restores it to the slide it was on** when it exits. Every focusable
element gets `:focus-visible` from `--focus-ring`; nothing relies on the browser default. The rail's selected
thumbnail carries `aria-current="true"`; the stage's slide carries `role="group"` with
`aria-label` = `artifacts.slides.slideNofM`.

## Prototype pointers

Read working code, don't invent. Honest status of each:

- **Slides itself: no prototype exists.** Verified against all five prototype branches (`git branch --list
  "*proto*"` → `proto/artifact-canvas`, `proto-canvas-agent`, `proto/artifact-apps-quality`,
  `proto/artifact-document-editor`, `proto/artifact-document-editor-r2`, and `git ls-tree` on each shows no
  slides/deck route). The eval suite (T7) is this slice's substitute — cheaper than a prototype and it measures
  the actual risk (spec §9 question 1, answered).
- **The inline-edit + refusal + version-drawer pattern: `proto/artifact-document-editor-r2`.**
  `src/routes/prototype/document/_lib/patch-engine.ts` is the baseHash patch engine (the direct ancestor of
  `validateSlidesDiff`), `_lib/editor-runtime.ts` is the commit-on-blur/cancel-on-Escape runtime,
  `PrototypeStateDrawer.svelte` renders the version list and the refusals, `_lib/alfy-change.ts` shows what a
  model-shaped patch batch looks like. The phone lessons are the committed screenshots
  `src/routes/prototype/document/_notes/before/08-mobile-390-light.png` and
  `_notes/before/10-desktop-dark.png` — read them before building the 390 px branch.
- **The ops-route + lazy-load + structural-assertion pattern: `proto/artifact-canvas`.**
  `src/routes/prototype/canvas/_lib/diff-doc.ts` (a diff applied to a document) and `_probe.mjs` (the local
  frame measurement Slice 3's perf gate cites, ruling 9). Slice 3 owns those files; this slice only borrows the
  shape.
- **The eval-harness shape: `proto/artifact-apps-quality`.** `scripts/prototype-artifact-apps/score.ts` is what
  Slice 5's `score/slides.ts` is adapted from; `scripts/prototype-artifact-apps/evaluate.ts` and
  `fixtures/raw-01.txt` show the prompt/source/attempt layout. This slice appends `suites/slides.ts` and
  `fixtures/slides/*.json` to Slice 5's harness, not a second harness.

## File ownership

Slice 0's three rules apply: every path here is created or extended by exactly one owner, and every **shared**
file names who lands first.

| File | Change | Shared? |
|---|---|---|
| `src/lib/shared/artifacts/slides.ts` | create — the body types | no |
| `src/lib/shared/artifacts/slides-layouts.ts` | create — `SLIDE_LAYOUT_IDS` and `SlideLayoutId`, no zod (client-safe) | no |
| `src/lib/shared/artifacts/slides-schema.ts` | create — `slideDraftSchema`, `slidesDraftSchema`, the caps | no |
| `src/lib/shared/artifacts/deck-ops.ts` + test | create — the Slides **vocabulary** (ruling 14): `SlideOp`, `SlidesDiff`, `SlideRefusalReason`, the caps, `validateSlidesDiff`, `hashSlideField`, `hashSlideContent`, and `slidesDiffJsonSchema` | no |
| `src/lib/shared/artifacts/slides-theme.ts` | create — the two theme palettes (the one place slide hex lives) | no |
| `src/lib/server/services/artifacts/serialize/slides.ts` + test | create — validate / normalise / caps / `normalizeSlidesBody` / `slidesBodyHash` | no |
| `src/lib/shared/artifacts/ops.ts` + test | **do not touch** — Slice 3's generic envelope, the one ops mechanism (ruling 14); this slice modifies nothing in it | **yes — Slice 3 owns it outright; this slice is a read-only consumer** |
| `src/lib/server/services/artifacts/slides/ask.ts` + test | create — the scoped control-model call and its JSON Schema | no |
| `src/lib/server/services/artifacts/slides/pptx-program.ts` + test | create — the deterministic generator program | no |
| `src/lib/server/services/artifacts/ops.ts` + test | **extend** — add the `slides` row to `OPS_BRANCHES` (kind → vocabulary); one line plus its test case | **yes — Slice 3 lands first** (it creates the file, `slice-3.md §File ownership`) |
| `src/routes/api/artifacts/[id]/ops/+server.ts` + test | **extend** — its test suite gains the slides cases | **yes — Slice 3 lands first** (`slice-3.md §File ownership`) |
| `src/routes/api/artifacts/[id]/slides/[slideId]/ask/+server.ts` + test | create — the scoped ask adapter | no |
| `src/routes/api/artifacts/[id]/exports/pptx/+server.ts` + test | create — the export adapter | no |
| `src/lib/components/artifacts/slides/SlidesEditor.svelte` + test | create — the lazy panel editor | no |
| `src/lib/components/artifacts/slides/SlideRail.svelte` | create — the rail, drag-reorder, roving tabindex | no |
| `src/lib/components/artifacts/slides/SlideStage.svelte` | create — renders one slide through the registry, owns the editing state | no |
| `src/lib/components/artifacts/slides/layouts/*.svelte` | create — seven files, one per registry row | no |
| `src/lib/components/artifacts/slides/EditableText.svelte` + test | create — caret-on-click / bottom-sheet editor | **yes — Slice 1 may want it for the Document**; the file lives here, one implementation, Slice 1 imports it if it needs it |
| `src/lib/components/artifacts/slides/SpeakerNotes.svelte` | create | no |
| `src/lib/components/artifacts/slides/PresentMode.svelte` + test | create | no |
| `src/lib/components/artifacts/slides/AskAboutSlide.svelte` | create | no |
| `src/lib/components/artifacts/RefusalNotice.svelte` | **do not create** — import Slice 1's one shared notice; a slides copy would be a second notice | **yes — Slice 1 creates it (its T8); this slice and Slice 3 are consumers** |
| `src/lib/components/artifacts/slides/_lib/layout-registry.ts` + test | create | no |
| `src/lib/components/artifacts/slides/_lib/deck.ts` + test | create — `emptyDeck`, `addSlide`, `removeSlide`, `reorderSlides`, `firstSlideIndex`, `mintSlideId`, `mintBulletId` | no |
| `src/lib/components/chat/file-production-helpers.ts` + test | **extend** — `fileProductionErrorKey(code)` moves here from `FileProductionCard.svelte`; the card imports it | **yes — Slice 5 may also want it; whoever needs it first lands it, both import** |
| `src/lib/components/chat/FileProductionCard.svelte` | **extend** — delete the local map, import the helper (no visual or test-id change) | **yes — same commit as the helper** |
| `src/lib/client/api/artifacts.ts` | **extend** — `saveArtifactOps`, `askAboutSlide`, `exportSlidesPptx` | **yes — Slice 0 creates it; append only** |
| `src/lib/i18n/artifacts.ts` + test | **extend** — the `artifacts.slides.*` rows and the parity cases | **yes — Slice 0 creates it and registers the module; append only** |
| `tests/e2e/artifact-slides.spec.ts` | create | no |
| `tests/cross-cutting/incognito-artifact-containment.test.ts` | **extend** — the slides behaviours (PART A) and the guard (PART B) | **yes — every slice extends it; append** |
| `scripts/eval-artifact-contracts/suites/slides.ts` + `fixtures/slides/*.json` | create — suite 4 and its fixtures | **yes — Slice 5 owns the harness; this slice adds one suite and its fixtures** |

**Serialisation order** (the hot files, who lands first): **Slice 0** (`i18n/artifacts.ts`,
`client/api/artifacts.ts`, the panel, the record boundary) → **Slice 1** (the Document's panel and the one
shared `src/lib/components/artifacts/RefusalNotice.svelte`) → **Slice 3** (`src/lib/shared/artifacts/ops.ts`,
`board-ops.ts`, `src/lib/server/services/artifacts/ops.ts`, the ops route) → **this
slice** (`deck-ops.ts`, the `OPS_BRANCHES` slides row, the panel's type entry, the i18n rows) → **Slice 5**
(the tool, the harness's other suites). This slice does not start T3/T4 before Slice 3's
envelope exists, and does not start T7 before Slice 5's runner exists.

## Tasks

### Task T1: The deck model and its serialisation

**Files:** `src/lib/shared/artifacts/slides.ts`, `slides-layouts.ts`, `slides-schema.ts`, `slides-theme.ts`,
`src/lib/components/artifacts/slides/_lib/deck.ts` + test,
`src/lib/server/services/artifacts/serialize/slides.ts` + test
**Test:** unit

- [ ] **Step 1: Write the failing tests**

```ts
// _lib/deck.test.ts
it("round-trips a deck through JSON and normalizeSlidesBody unchanged", ...);
it("mints a slide id and bullet ids that match their prefixes", ...);
it("adds a slide after a given id and at the end", ...);
it("reorders slides by an explicit id order and ignores ids it does not know", ...);
it("builds an empty deck with an empty slides array and the given language", ...);
it("picks the title layout for a new deck's first slide", ...);

// serialize/slides.test.ts
it("drops a slide whose layout id is unknown and reports it", ...);
it("drops a slide missing a required field for its layout and reports it", ...);
it("drops a field the layout forbids but keeps the slide", ...);
it("re-mints a bullet id that does not match the id shape", ...);
it("caps the slide count and reports how many it dropped", ...);
it("caps bullets per slide, bullets per column and field length", ...);
it("fills a missing deck language from the deck text, then the conversation, then en", ...);
it("tolerates a body with a missing aspect or theme by defaulting to 16:9 / paper", ...);
it("refuses a body that is not an object at all, without throwing", ...);
it("drops an image whose id does not resolve and reports it", ...);
it("produces the same body hash for a reordered deck's unchanged slide", ...);
```

- [ ] **Step 2: Run them to verify they fail**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run src/lib/components/artifacts/slides/_lib/deck.test.ts \
  src/lib/server/services/artifacts/serialize/slides.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Write the shared types, the id list, the two zod schemas and the theme palettes first (they are the contract
everything else compiles against), then `deck.ts` as pure functions, then the server serialiser with the same
validate-never-throw posture as the Canvas body (`normalizeCanvasBody`), including the ordered rules above and
the `dropped` report.

- [ ] **Step 4: Run them to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/shared/artifacts src/lib/components/artifacts/slides/_lib \
  src/lib/server/services/artifacts/serialize
git commit -m "Give Slides a deck model that survives a reload

A stored deck is user-editable JSON and can be a version behind, so the loader
validates instead of trusting: an unknown layout id is dropped and reported
rather than rendered as raw markup, because layouts are the app's vocabulary and
not the body's. The seven-layout set and the theme palette are code, so the
model's whole job is content.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task T2: The seven layouts, the rail and the stage

**Files:** `_lib/layout-registry.ts` + test, `SlideRail.svelte`, `SlideStage.svelte`, `layouts/*.svelte`,
`EditableText.svelte`, `SlidesEditor.svelte`
**Test:** component + e2e

- [ ] **Step 1: Write the failing tests**

```ts
// layout-registry.test.ts
it("has a registry entry for every SlideLayoutId and no others", ...);
it("marks exactly the title layout as a first-slide candidate", ...);
it("marks each layout's forbidden fields, and requires what the normaliser requires", ...);
it("has an i18n label key for every layout", ...);
it("renders only the fields its layout declares", ...);
it("renders an empty image frame for an image layout with no image", ...);
it("never renders model-supplied HTML in any layout", ...);
it("shows the caret on click and commits on blur and on Escape", ...);
it("opens the bottom sheet under 720px and the inline caret above it", ...);
it("changes a slide's layout and keeps the fields the new layout shows", ...);

// e2e (artifact-slides.spec.ts)
it("opens a slides artifact in the panel and paints its first slide", ...);
it("adds a slide from the rail and it lands after the selected one", ...);
it("edits a title in place and the deck JSON carries the new text", ...);
it("reorders slides by dragging in the rail and it persists", ...);
it("shows all seven layouts in the change-layout menu, in both languages", ...);
it("keeps the rail a filmstrip and the editor a sheet at 390px", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

Write the registry (seven rows, the table above is the data), then the layouts as pure presentational
components taking `{ slide, editing, theme }`. `SlideStage` owns which field is being edited; `EditableText`
owns the caret, the Escape behaviour, the blur-commit and the bottom-sheet branch. Below 720 px the rail is a
horizontal filmstrip and a text edit opens a bottom sheet — a separate layout branch, not a CSS squeeze.

- [ ] **Step 4: Run them to verify they pass**, plus `npx vitest run src/lib/components/chat` to prove nothing
  shared broke. Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/components/artifacts/slides src/app.css
git commit -m "Put seven fixed layouts and a slide rail in the artifact panel

The model chooses a layout id and fills fields; it never writes markup, so a
stored deck cannot smuggle CSS or HTML into the panel. On a phone the rail
becomes a filmstrip and text edits open a bottom sheet, because a rail plus a
toolbar plus a notes pane on a 390-pixel viewport is the mistake the Document
prototype already made.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task T3: The patch contract and the refusal

**Files:** `src/lib/shared/artifacts/deck-ops.ts` + test,
`src/lib/server/services/artifacts/ops.ts` + test (register the slides row)
**Test:** unit + integration

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/shared/artifacts/deck-ops.test.ts
it("hashes a field so the same text yields the same hash", ...);
it("hashes the same text in two slides to the same value, and different text differently", ...);
it("refuses a patch whose baseHash is not the field's current hash", ...);
it("applies every other patch in a batch when one is refused", ...);
it("returns one refusal per refused op, in batch order, with the op's index", ...);
it("refuses a bullet patch on a slide whose layout has no bullets", ...);
it("refuses set_layout when the new layout cannot show content the slide has", ...);
it("accepts set_layout when the slide's content fits the new layout", ...);
it("refuses set_layout whose baseHash is the slide content hash of a different content", ...);
it("refuses an empty title and one over the character cap", ...);
it("refuses a whole batch over the op cap without applying part of it", ...);
it("accepts an add_slide followed by a patch targeting the new slide's id", ...);

// ops route integration
it("refuses a patch against another user's artifact with a 404", ...);
it("persists an accepted batch as one version with the batch's summary", ...);
it("refuses a batch built on a stale baseVersionId with a 409 and applies nothing", ...);
it("answers an unknown kind with a 400, not a crash", ...);
it("never writes a batch into an incognito artifact from another conversation", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

Write `deck-ops.ts` — the hashing and the validator first (pure, no route, no server imports), with its test
beside it — then register it as the `slides` row of Slice 3's `OPS_BRANCHES` and add the route's test cases.
Do not touch `src/lib/shared/artifacts/ops.ts` (ruling 14). If Slice 3's envelope is not in the tree yet, stop
here and land Slice 3 first — do not create a second ops route.

- [ ] **Step 4: Run them to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/server/services/artifacts src/lib/shared/artifacts/deck-ops.ts
git commit -m "Refuse a slide patch that was written against text the user has since changed

The whole point of editing in place is that neither writer can silently
overwrite the other. A slide field carries the hash the model last read; if the
user typed into it since, the patch is refused with a reason and the rest of the
batch still lands.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task T4: "Ask Alfy about this slide"

**Files:** `AskAboutSlide.svelte`, `SlideStage.svelte`,
`src/lib/server/services/artifacts/slides/ask.ts` + test,
`src/routes/api/artifacts/[id]/slides/[slideId]/ask/+server.ts` + test, `src/lib/client/api/artifacts.ts`
**Test:** unit + component + integration + e2e

The action is a **scoped** request: the body carries the slide id, not the deck, and the server builds the
prompt from that one slide plus the deck's title, language and theme. It is not a chat message: nothing is added
to the conversation.

- [ ] **Step 1: Write the failing tests**

```ts
// slides/ask.test.ts
it("sends only the current slide to the control model, never the whole deck", ...);
it("includes the deck language so the edit stays in the deck's language", ...);
it("validates the model's answer with the same validateSlidesDiff the ops route uses", ...);
it("retries once with the validator's reason when the answer is unparseable", ...);
it("answers no_diff, not an error, when the model proposes nothing", ...);
it("refuses a stale baseVersionId with a 409 before calling the model", ...);

// component + e2e
it("sends only the current slide, not the whole deck", ...);
it("renders the refusal notice beside the slide it concerns", ...);
it("shows the pending state while the patch is in flight and clears it on failure", ...);
it("does not create a chat message as a side effect", ...);
it("asks about a slide, sees the title change, and sees the version badge advance", ...);
it("refuses when the user edited that same field first, and says why", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

`sendJsonControlMessage` (`normal-chat-control-model.ts:336`) with a hand-written
`slidesDiffJsonSchema` (exported from `deck-ops.ts`; `{type:"object", additionalProperties:false, properties,
required}`, the pattern
`context-compression.ts:259-300` uses) and the same `{baseVersionId, diff}` shape the ops route takes. Inject
the sender the way `context-compression.ts` does, so the unit test needs no provider. The route applies the
diff through `validateSlidesDiff` + one `updateArtifactBody`, then responds with the version and the refusals.

- [ ] **Step 4: Run them to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/server/services/artifacts/slides src/routes/api/artifacts \
  src/lib/client/api/artifacts.ts src/lib/components/artifacts/slides
git commit -m "Ask about one slide, get patches to that slide

The request carries the slide, not the deck, so the model's edit is scoped by
construction rather than by a prompt asking it to stay in scope. The answer goes
through the same refusable patch contract any other edit does, which is what
keeps the user's own typing safe.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task T5: Speaker notes, present mode and the panel surface

**Files:** `SpeakerNotes.svelte`, `PresentMode.svelte` + test, `SlidesEditor.svelte`,
`src/lib/client/api/artifacts.ts`
**Test:** component + e2e

Notes are a patch target like every other text field (`{ slideId, fieldId: "notes" }`), so they go through the
ops route and **do** mint a version — this replaces the earlier draft's separate notes route, which would have
needed a `updateArtifactBody` variant Slice 0 does not have and would have split the deck across two stores.
The save is debounced (600 ms after the last keystroke) and fires on blur, so a paragraph of typing is one
version, and its summary names the field (`"edited the speaker notes on slide 3"`).

- [ ] **Step 1: Write the failing tests**

```ts
it("saves notes through the ops route and shows a saved confirmation", ...);
it("debounces a burst of typing into one version", ...);
it("refuses notes over the character cap instead of truncating silently", ...);
it("advances with ArrowRight and Space, and goes back with ArrowLeft", ...);
it("exits on Escape and returns focus to the slide it was on", ...);
it("shows the presenter's notes in present mode and hides them by default on desktop", ...);
it("shows the notes pane by default at 390px", ...);
it("announces the slide position to assistive tech", ...);
it("does not autoplay, animate between slides, or capture the pointer", ...);

// e2e
it("presents a deck, walks to the end, and exits back to the panel", ...);
it("keeps the deck's language when presenting", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

Present mode is a full-screen surface inside the app shell: no new window, no pointer lock, keyboard only plus
swipe on touch, `aria-live` position announcement, focus trapped while open and restored on exit. Notes save
through the ops route with the debounce above.

- [ ] **Step 4: Run them to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/components/artifacts/slides src/lib/client/api/artifacts.ts
git commit -m "Speak a deck out loud, with notes only the speaker sees

Present mode is a surface inside the app, not a new window: it inherits the
session, the theme and the language, and it cannot become a second app the user
has to find again. Notes are a patch target like every other field, so the deck
stays in one place and the version list stays honest about what changed.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task T6: The PPTX export

**Files:** `src/lib/server/services/artifacts/slides/pptx-program.ts` + test,
`/api/artifacts/[id]/exports/pptx/+server.ts` + test,
`src/lib/components/chat/file-production-helpers.ts` + test (extend),
`FileProductionCard.svelte` (extend), `src/lib/client/api/artifacts.ts`
**Test:** unit + integration + e2e

- [ ] **Step 1: Write the failing tests**

```ts
// pptx-program.test.ts
it("inlines the deck JSON as a literal and imports nothing outside pptx and the standard library", ...);
it("opens no network API and reads no clock in the generated program", ...);
it("interpolates no deck text into the code, only through the JSON literal", ...);
it("produces the same program for the same body", ...);
it("writes exactly one file into /output/<slug>.pptx", ...);
it("maps every registry layout to a generator section", ...);
it("renders the notes into the notes pane, not the slide body", ...);
it("carries the theme palette's four colours and no others", ...);

// export route integration
it("refuses an export for a deck with no slides with a 422", ...);
it("refuses an export for another user's artifact with a 404", ...);
it("refuses an export for a deck with no conversation with a 409", ...);
it("refuses when a referenced image cannot be read, and creates no job", ...);
it("refuses a program over maxSourceJsonBytes with the intake's own source_too_large code", ...);
it("submits with sourceMode program, requestedOutputs [{type: pptx}] and a python program", ...);
it("returns the same job for two exports of the same version (reused: true)", ...);
it("creates a new job after the deck is edited to a new version", ...);
it("surfaces a sandbox failure as the job's code, not a stack", ...);
it("never leaks a host path into the response", ...);

// the shared error map
it("maps every FILE_PRODUCTION_LIMIT_ERROR_CODE and the worker codes to an i18n key", ...);

// e2e
it("exports a deck and the job card is offered in the chat", ...);
it("shows the job's failure reason and offers Try again when the export fails", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

Write the program builder and the route in the order the contract above gives (steps 1-9). The program is built
from the deck body and the theme only; it must not read the clock, the locale, or the network. Move
`ERROR_MESSAGE_KEYS` to `file-production-helpers.ts` as `fileProductionErrorKey` and re-import it in the card in
the same commit, then render the export row with the card itself so there is one failure UI.

**Verified facts the implementation must respect:** the sandbox collects only `/output`; the Python bootstrap
creates `/output` before the program runs; the Python runtime has `python-pptx`; the effective deadline is the
admin's `fileProductionSandboxTimeoutMs` (5 min default), not the hard-coded 90 s; the produced filename is what
the program writes in `/output`; the intake's body contract requires `conversationId`, `requestTitle` and
`idempotencyKey`; the `(user, conversation, idempotency_key)` unique index is what makes a re-click idempotent.
The one **unverified** item is the `python-pptx` API surface itself (see the note in Contracts): confirm it in
the sandbox before writing the seven layout functions, and if a call differs, that is a change inside this one
function.

- [ ] **Step 4: Run them to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/server/services/artifacts/slides src/routes/api/artifacts \
  src/lib/client/api/artifacts.ts src/lib/components/chat
git commit -m "Build the PPTX from the deck, not from a model

The generator is app code with the deck JSON inlined, so the export of a given
deck is the same file every time and a bad export is a bug we can read rather
than a generation we have to re-run. It goes through the file-production engine
produce_file uses, and its failures render in the card that already exists, which
is what keeps produced files in one ledger and one error vocabulary.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task T7: The eval suite 4 gate

**Files:** `scripts/eval-artifact-contracts/suites/slides.ts`, `fixtures/slides/*.json` (Slice 5 owns the
harness and `score/slides.ts`; this slice adds one suite and its fixtures), `tests/e2e/artifact-slides.spec.ts`
**Test:** eval

- [ ] **Step 1: Write the failing suite**

```ts
// scripts/eval-artifact-contracts/suites/slides.ts
// Fixtures (prompt + source material), in `fixtures/slides/`:
//   vienna-5.json      "Készíts 5 diás diasort a bécsi útról" (HU) / "Make a 5-slide deck about the Vienna trip"
//   itinerary.json     "Turn this itinerary into a deck" with the itinerary as source material
//   danube-facts.json  a deck about a topic whose numbers exist only in the source
//   existing-deck.json "Add a slide about the budget" against a deck with a known id list (an edit, not a create)
it("returns JSON that parses against slidesDraftSchema", ...);
it("uses only registered layout ids", ...);
it("fills the fields its chosen layout declares and no forbidden field", ...);
it("writes the deck in the request's language", ...);
it("agrees with detectLanguage on that language", ...);
it("invents no number that is absent from the source material", ...);
it("invents no proper noun that is absent from the source material", ...);
it("stays within the slide and bullet caps", ...);
it("edits the existing deck without renumbering its slides", ...);
```

Scoring is automatic, not judged by eye: schema validity is a zod parse; layout ids are a registry lookup;
language is the repo's own detector (`detectLanguage`, `language.ts:195`); "no invented facts" is a
deterministic extraction of every number and capitalised proper noun in the deck plus a check that each appears
in the supplied source material or is a direct arithmetic relation of values in it. Suite 5 (the verification
pass) supplies the wrong-key / mislabelled-aggregate / wrong-unit classes; suite 4 fails if the verification
pass cannot classify one of them.

- [ ] **Step 2: Run it to verify it fails**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx tsx scripts/eval-artifact-contracts/run.ts --suite slides --replay
```
Expected: FAIL, or a written result below the gate.

- [ ] **Step 3: Record and act on the result**

If the suite passes at the agreed bar, the slice continues. If it does not, **the design changes, not the
evidence** (ADR-0066, spec §8 risk 1): the named fallback is that Alfy *proposes* a deck and the user approves
it slide by slide before it is written. That change is an owner decision — record the measured result in the
slice's PR body and stop.

- [ ] **Step 4: Run it to verify it passes**, or record the decision that changes the design.

- [ ] **Step 5: Commit**

```
git add scripts/eval-artifact-contracts
git commit -m "Gate Slides on the model contract, because Slides was never prototyped

Apps were; decks were not. This runs the real model against real prompts and
scores the answer without a human in the loop: schema, layout ids, language, and
whether a number in the deck came from anywhere. A weak result changes the design
rather than being argued away.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task T8: i18n, incognito, ownership, archive

**Files:** `src/lib/i18n/artifacts.ts` + test (extend),
`tests/cross-cutting/incognito-artifact-containment.test.ts` (extend),
`src/lib/server/services/account-data-archive/*` + test
**Test:** unit + cross-cutting

- [ ] **Step 1: Write the failing tests**

```ts
it("has both en and hu for every artifacts.slides key", ...);
it("has a refusal line for every SlideRefusalReason and every SlidesDropReason", ...);
it("never shows the word Artifact in either locale", ...);
it("never lists a deck made in an incognito chat in the library", ...);
it("never picks a deck from an incognito chat as evidence elsewhere", ...);
it("refuses to read another user's deck body, ops, ask or export", ...);
it("carries deck bodies, versions and comments into the account archive", ...);
it("erases deck bodies, versions and comments on account deletion", ...);
it("does not carry deck text into any telemetry event", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

Append the `artifacts.slides.*` rows in both dictionaries (do not re-register the module: Slice 0 owns
`I18N_MODULES` and `AUDITED_PREFIXES`), extend the containment suite's PART A behaviours for slides, extend
PART B's guard if a new file queries `artifacts` by user, and cover the archive and erasure of the deck's rows.
The ask route is a new model-calling file — make sure it reads the artifact through the ownership scope and
carries no user id from the client. If an incognito test fails, the single ownership scope is wrong: fix the
scope, not the test.

- [ ] **Step 4: Run them to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/i18n tests/cross-cutting src/lib/server/services/account-data-archive
git commit -m "Say Diasor, and hold the incognito promise for decks

The Hungarian name is the ratified one, and a deck is a second place the user's
words live, so the promise that an incognito chat is not remembered has to hold
for it too.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

## Non-goals

- **No free positioning, no per-slide CSS, no custom layouts.** Seven layouts, app-owned, and the model picks
  one. This is the decision that keeps the type safe and the export faithful.
- **No transitions, animations, builds or timings.** A slide appears; that is all.
- **No presenter view across two screens**, no audience link, no live polling, no second device. Present mode
  runs on the device the deck is open on.
- **No PDF export in this slice** (ruling 3). A PDF of a deck is a second renderer or a second generator over
  the same deck, and it is deliberately not on this slice's critical path. The mockup's line "export to PPTX or
  PDF through produce_file" (`mockups:376`) is corrected to "PPTX"; the file is outside this slice's edit scope
  and is reported.
- **No image generation and no remote images.** An image is an existing knowledge artifact or chat file.
- **No charts or tables inside a slide.** A deck that needs one links to the Canvas or Document that has it; the
  layout set stays small. (This is also why the sandbox's `pptxgenjs` chart patch is irrelevant to the Python
  path.)
- **No `.pptx` import.** Uploaded decks stay uploaded files and are not turned into artifacts.
- **No slide comments in this slice.** The comment layer is Slice 1's and Slice 3's; the same
  `artifact_comments` envelope can carry a `slide` anchor later, and this slice does not invent one.
- **No durable artifact → export link in v1.** See Open questions 1.
- **No new runtime dependency.**

## Risks

| Risk | Why it bites | Mitigation |
|---|---|---|
| Slides is unprototyped | The model may not hold a structured deck contract, and the whole slice would be built on an unverified assumption | Slice 5's eval suite 4 runs before merge and a weak result changes the design (T7) |
| A refused patch is applied anyway | The user's own typing gets overwritten, which is the exact thing §2.5 protects | `baseHash` per field, server-side refusal, an e2e that edits first and asks Alfy second |
| Model text ends up rendered as markup | An injection surface and a broken layout promise | Layouts render typed fields only; the layout id is validated on load and on write |
| The export program reads a clock or the locale | The same deck exports differently twice and the gate cannot compare | The program is built from the body alone; a test greps the generated source for `Date`, `time`, `random` and `locale` |
| `python-pptx`'s API differs from the note in Contracts | The generator does not run; a whole task's work is thrown away | The API surface is marked unverified and is confirmed in the sandbox **before** the seven layout functions are written (T6 Step 3) |
| Inlined images blow `maxSourceJsonBytes` | A deck that exports in dev fails on a real photo, with a confusing sandbox story | The route pre-checks with the same limits module and answers `source_too_large` and a readable line; raising the cap is an admin key |
| The phone layout is a squeezed desktop | The rail plus toolbar plus notes is unusable at 390 px | A separate filmstrip + bottom-sheet branch below 720 px, with its own e2e viewport |
| Notes saves mint a version per keystroke | The version list fills with invisible changes | Debounced 600 ms and committed on blur, with a summary that names the field |
| Text fields drift between layouts | Moving a slide loses content silently | `layout_dropped_field` is a refusal, not a discard |
| Two ops routes get built | Slice 3 and Slice 4 both landing their own envelope fragments the type-dispatched route | Slice 3's envelope is a hard dependency of T3/T4 (`slice-3.md §Open questions for the owner`, ruling 14); if it is not in the tree, this slice stops rather than creating one |

## Verification checklist

- [ ] Every task's tests were seen failing first, then green.
- [ ] `npm run check` — 0 errors, 0 warnings.
- [ ] `npx biome check src scripts tests` — clean.
- [ ] `npm test` — green, including the i18n key parity test, the deck unit suites and the shared error-map
  test.
- [ ] `npm run build` — 0 warnings. Confirm the slides editor is a separate chunk and is **not** in the idle
  chat or landing bundle (the panel's lazy `ARTIFACT_BODIES` entry is the only import path).
- [ ] `npx fallow --no-cache --format json --quiet --score` — no new findings, no new ignores.
- [ ] `npx playwright test tests/e2e/artifact-slides.spec.ts tests/e2e/artifacts-panel.spec.ts tests/e2e/chat.spec.ts tests/e2e/incognito-indicator.spec.ts` — green.
- [ ] `npx tsx scripts/eval-artifact-contracts/run.ts --suite slides --replay` — green
  with no API key, and the model run at or above the agreed bar, with the numbers in the PR body.
- [ ] **Real-app visual check** against `claude-at-home-2-artifact-types-mockups.html` §3 at **1440×900 and
  390×844, light and dark**: the deck grid is `118px + stage`, the eyebrow is present, the heading is editable
  with a visible caret on click, the bullets render, the illustration slot renders a real file, `Ask Alfy about
  this slide` sits at the slide's bottom-right and `SPEAKER NOTES` sits below the slide; the rail is a filmstrip
  on the phone and a column on the desktop; nothing overflows the right edge.
- [ ] **Staging, real model:** "Készíts 5 diás diasort a bécsi útról" → a deck in Hungarian appears, opens in
  the panel, is answerable with all seven layouts, presents full-screen, and edits in place.
- [ ] **Staging:** edit the title of slide 2 myself, then ask Alfy to change the same title → refused, with the
  reason visible and the rest of the batch applied.
- [ ] **Staging:** export → the job appears in the chat as a card, the `.pptx` downloads, and it opens in
  PowerPoint/Keynote/LibreOffice with the text, the images and the speaker notes in place.
- [ ] **Staging:** export twice from the same version → one job card, not two (`reused: true`).
- [ ] **Staging:** the same deck inside an **incognito** chat is not listed in the Knowledge library and is not
  cited by a later normal conversation.
- [ ] Read the staging service journal for new warnings.

## Open questions for the owner

1. **Should a deck remember its exports?** Today the panel hands the export to the chat and forgets it: the
   `.pptx` is found where every produced file is found, on its job card. The mockup's panel header has a
   download icon, and "which file is this deck's" cannot be answered from the existing facade —
   `listConversationFileProductionJobs` (`file-production/read-model.ts:491`) drops `idempotencyKey` from the
   mapped job (`file-production/types.ts:130-154`), so the client cannot match a job to a deck. The clean fix
   is an `artifact_links` row (`schema.ts:422`, with its `linkType` column) written when a job is accepted and
   reconciled on success, plus a job-status read the panel can poll. **Recommendation: defer to a follow-up
   slice** (it is a new read path and a worker-adjacent write), and keep v1's honest "it is in the chat".
2. **"Speaker notes you can read from your phone while presenting"** (mockup legend 4, `:375`) can be read two
   ways: the notes are on the presenting device's own screen, or the deck is presented on one device while the
   notes are read on another — which would need a session or a link, and sharing is a hard no.
   **Recommendation: the first reading.** Present mode carries a notes toggle; at 390 px it defaults on. If the
   second reading was intended, it is a new feature with a security surface, not a slice detail.
3. **PDF is deferred, not forgotten** (ruling 3). Confirm that a user who wants a PDF of a deck can live
   without it in 2.0, or name it for a follow-up. **Recommendation: defer, and say so in the release notes** —
   the deck's `.pptx` already prints and PowerPoint exports PDF, so the user is not stuck.
4. **May the model choose a library image for a deck?** The `image` layout accepts a knowledge artifact or a
   chat file (`slides.ts`), and the model can only fill an id the turn's context gave it. Whether artifacts are
   retrieved for the slides prompt is Slice 5's retrieval question; this slice accepts whatever id it is given
   and validates ownership. **Recommendation: leave it to Slice 5** and ship `image` layout slides filled by
   the user first — the mockup's illustration is one `add_picture` call either way.
