# Phase 5 + Phase 6 — Extended uploads and the generation side

Status: implementation spec, written 2026-09-20 against `mineru4/p3` (`7ce2024c`).
Audience: parallel development sub-agents in separate worktrees, then an adversarial reviewer.

**Read first, in this order:** `docs/plans/mineru4/phase1-registry-spec.md` §2.2–2.5, §4, §8–§10;
`docs/plans/mineru4/phase2-4-mineru-client-spec.md` §1.4, §2.6–2.7, §4.2, §4.10, "Orchestrator rulings";
`docs/plans/mineru4/phase3-ledger-spec.md` "Slice S1 outcome". Where this spec and the merged code
disagree, **the code wins** — say so in your slice report.

**Sequencing, normative.** Phases 2 and 4 (`mineru4/p24`) merge BEFORE this work reaches the
integration branch. Slices marked `[P24-free]` may be written and reviewed in parallel with Phase 2/4;
slices marked `[needs-P24]` must branch from the merged `mineru4/p24`. Integration branch for this
work: `mineru4/p56`. Nothing is pushed. Homebrew `node@22`. Stage by explicit path; never `git add -A`.

---

## 0. Decisions, stated once

| # | Decision |
| --- | --- |
| D1 | `rtf`, `odt`, `ods`, `odp`, `epub` become `intake: { route: "mineru", tierHint: "flash" }`. `ofd` gets a NEW entry that stays `reject`/`formatNotEnabled` — zero spike evidence. |
| D2 | `tsv` becomes **`direct-text`**, not MinerU. The CSV fixture proves MinerU makes delimited text *bigger*, and `run_python`/exceljs need the raw delimiters. |
| D3 | `html`/`htm` move from `direct-text` to `mineru` + `flash`. Measured on the spike fixture: −34.3 % chars as-is, −43.2 % after stripping MinerU's anchor tags, with scripts/style/nav/ad/footer all removed and the most faithful heading levels of any input format. |
| D4 | `docx`, `xlsx`, `pptx`, `odt`, and legacy `doc`, `xls`, `ppt` gain `tierHint: "flash"`. PDF and images stay unhinted (they need `basic`). |
| D5 | The `knowledge` and `chat` accept sets become **identical**: every entry whose `intake.route !== "reject"`. 74 extensions each. `KNOWLEDGE_ACCEPT_OMISSIONS` empties (`.markdown` is offered). |
| D6 | A **MinerU-4 availability gate** refuses the D1 formats at intent (and hides them from both accept strings) when the configured backend probes as pre-4.x. Default is **open** — a backend that has never answered does not shrink the UI. |
| D7 | New requestable production type: **`tsv` only**. `png`, `jpg`, `epub`, `ods`, `odp`, `rtf`, `tex` are dropped with reasons (§6.1). `svg` is already requestable and live-verified; nothing to add. |
| D8 | A new non-Docker `inline_text` production mode replaces `buildTextFileProgram` for every output whose `production.validation === "text"`. This is how "plain markdown stops spawning a container" is delivered — *not* by routing markdown through `documentSource`, which would silently reformat the user's own markdown. |
| D9 | `document_source` artifact text becomes `renderStandardReportMarkdown` output. `buildGeneratedDocumentProjection` is deleted (one caller). |
| D10 | Program-mode Office/PDF readback carries `hints: { preferredTier: "flash" }`. `preferredTier` is a **soft** hint: unavailable ⇒ fall through, never `tier_unavailable`. |
| D11 | `zip` keeps its by-name exemption from the "every requestable type has a non-reject intake route" invariant. The `archive` route is described here and **not built**. |
| D12 | Storage-path unification (chat-files-relative vs cwd-relative) is **deferred**. §7. |
| D13 | ALL model-facing prose changes of the whole migration ship in ONE slice (**P6-D**), last, after Phases 2, 4, 5 and P6-A/B/C. Phase 1's byte-identity tests are re-frozen deliberately in that same commit. |

---

## 1. Recorded evidence this spec rests on

Everything below is transcribed from `mineru4/p0-fixtures` or read out of `mineru4/p3`. Cite these,
not intuition.

### 1.1 MinerU 4.0.4 per-format reality (`fixtures/mineru-v1/`)

| input | file-level tier inside a `basic` job | `parse_mode` | page kind | `parse.duration_ms` | fidelity note |
| --- | --- | --- | --- | ---: | --- |
| html | **flash** | txt | logical | 26 | scripts/style/nav/ad-slot/footer stripped; `h1→doc_title` L1, `h2→`L2, `h3→`L3 — faithful. Emits one `<a id="html-…"></a>` per heading (4 anchors = 156 chars of noise). |
| epub | **flash** | txt | spine | 10 | faithful headings, same anchor noise |
| csv | **flash** | txt | logical | 49 | single GFM `table` block; no text/heading blocks |
| xlsx | **flash** | txt | sheet | 22 | sheet names → `##`; **formulas dropped** (`SUM(B2:B4)` → empty cell); blank rows preserved as `\|  \|  \|` |
| docx | **flash** | txt | declared | 419 | **heading level +1** and titles wrapped in `**…**` |
| pptx | **flash** | txt | slide | 48 | heavy loss: 133 chars of text survive from a 2-slide deck |
| pdf | basic | txt | physical | 1 126 warm / **18 600 cold** | flash PDF = 811 ms; all headings level 2 |
| png/jpg | basic | **ocr** | absent | 1 387 / 8 961 cold | visibly lossy OCR |

Not tested anywhere in the spike, at any tier: **rtf, odt, ods, odp, ofd, tsv**. Do not cite the spike
as evidence for them. `GET /v1/tiers` is the capability source; `flash` is present on every recorded
server. MinerU can never emit `docx`/`html`/`latex` output (`output_files_null_keys`).

### 1.2 The HTML token measurement (D3)

| | bytes = chars | ≈ tokens (chars/4) |
| --- | ---: | ---: |
| `fixtures/mineru-v1/html/sample.html` (raw, what goes in the prompt today) | 1 753 | 438 |
| `fixtures/mineru-v1/html/markdown.md` (MinerU flash) | 1 152 | 288 |
| same, minus the 4 `<a id="html-…"></a>` anchors | 996 | 249 |

−34.3 % as shipped, −43.2 % with anchor stripping. **This is a floor, not a typical case**: the
fixture is a hand-written 21-line file whose boilerplate is six short lines. A real page is mostly
`div`/JSON-LD/analytics, where the ratio is dominated by how much boilerplate exists.

**Counter-measurement, which must be quoted in the slice report so nobody claims a CSV win:**
`csv/sample.csv` is 89 chars in, `csv/markdown.md` is 148 chars out — **+66.3 %**. Pipes, padding and
the `| --- |` separator row cost more than the commas they replace, at every file size. This is why
D2 keeps `tsv` on `direct-text`.

### 1.3 Sandbox reality

- `SANDBOX_PYTHON_PACKAGES` = `["openpyxl","xlsxwriter","python-docx","python-pptx"]`
  (`src/lib/server/sandbox/python-version.ts:36-45`). **No matplotlib, no pillow, no reportlab, no
  odfpy, no ebooklib, no weasyprint.** Pillow arrives only transitively under `python-pptx`.
- JS program mode bind-mounts the **whole app `node_modules`** read-only at `/workspace/node_modules`
  (`src/lib/server/sandbox/config.ts:34,58`). Available: `exceljs`, `pptxgenjs`, `docx`, `jszip`,
  `pdf-lib`, `marked`, `chart.js`. **No canvas backend**, so `chart.js` cannot rasterise.
- Container: `NetworkMode: "none"`, `ReadonlyRootfs: true`, `/output` tmpfs `size=100m`.

Measured cost of adding matplotlib + pillow for cp311 manylinux2014_x86_64
(`pip download --only-binary=:all: --platform manylinux2014_x86_64 --python-version 3.11
--implementation cp --abi cp311`):

| | wheels | unpacked |
| --- | ---: | ---: |
| numpy 2.2.6 | 16 821 570 | 58 634 929 |
| matplotlib 3.11.2 | 9 854 405 | 24 985 774 |
| fonttools 4.65.0 | 5 457 456 | 23 339 369 |
| pillow 12.2.0 | 8 088 188 | 22 025 994 |
| kiwisolver / contourpy / packaging / pyparsing / dateutil / six / cycler | 2 268 452 | 8 044 826 |
| **total** | **42 490 759 (40.5 MiB)** | **≈ 137 MB** |

Distribution count goes 4 → 11. Each deploy re-installs them into
`sandbox-python-env/lib/python3.11/site-packages` through the three-strategy ladder in
`scripts/deploy-lib.sh:485-526`. And `scripts/deploy.test.ts:328-339` requires **every** installed
package name to appear in `normal-chat-tools/index.ts`, i.e. adding matplotlib forces an edit to the
EN **and** HU `run_python` descriptions — a cached-prompt-prefix eviction, for a chart the
`renderers/chart-svg.ts` renderer already draws. **Do not add them.**

### 1.4 Generation-side facts

- `output-types.ts` is a 19-line re-export of `$lib/shared/file-types/production`. **No duplicate
  output-type map survives anywhere** (`obsolete-surfaces.test.ts:170-210` asserts it). Phase 6 has
  nothing to delete here; it should instead re-measure and tighten the two transitional budget rows
  in `no-ad-hoc-maps.test.ts` (`execution-adapter.ts` 4/0, `produce-file.ts` 7/1).
- `produce-file.ts:633-653` default-type ladder: a bare `{ markdown: "..." }` resolves to type `md`;
  `md` is not in `DOCUMENT_SOURCE_IDS`, so `shouldUseDocumentSourceForOutputs(["md"])` is `false` and
  the call takes the **program** branch — `buildTextFileProgram` (`:733-749`) emits a Python script
  that a Docker container runs to `write_text` a string. `prompts.ts:186` literally teaches the model
  this exact call.
- **Latent bug, in scope for P6-B:** `shouldUseDocumentSourceForOutputs` requires *every* type to be a
  document-source type. `requestedOutputs: [{type:"pdf"},{type:"md"}]` therefore returns `false`, the
  call falls to program mode, and `resolveTextFilename` uses `requestedOutputs[0]?.type` = `pdf`. The
  container writes raw markdown into `live.pdf`; `pdf` has `validation: "none"`, so
  `validateProgramOutputContract` passes it and the user downloads a "PDF" that is a text file.
- `execution-adapter.ts:294-302` already renders `markdown` through `renderStandardReportMarkdown`,
  but only for an explicit `sourceMode: "document_source"`.
- `source-persistence.ts:134` writes the `generated_output` artifact's text with
  `buildGeneratedDocumentProjection` (`source-schema.ts:1396`) — a **third** renderer of the same
  source, beside `standard-report-markdown.ts` and the html/pdf/docx renderers. One caller only.
- `chat-files.ts:690-696` already `continue`s for a source-first document, so a `documentSource`
  PDF/DOCX/HTML **never enqueues a readback job today**. Phase 3 S5 landed that. Phase 6 must confirm
  it with a test, not re-implement it.
- `chat-files.ts:623-654` `enqueueGeneratedFileReadback` passes **no `hints`**.
- `GeneratedDocumentChartType` (`source-schema.ts:164-171`) has 7 members; both `produce_file`
  descriptions advertise 5. `stackedBar` additionally requires `seriesKey` (`:723-725`, `:1084`).
- `read_generated_file` has **no `page` parameter** on `mineru4/p3`; Phase 4 §4.8 adds it and ships it
  undocumented until D13's release. Parameter `.describe()` strings are EN-only and are part of the
  serialized tool definition, i.e. part of the cached prefix.
- `file-serving-response-policy.ts:32-93`: preview responses for `text/html; charset=utf-8` and for
  `image/svg+xml` **or any `.svg` filename** (including `safetyFilenames`) get
  `RESTRICTED_PREVIEW_CSP` (`default-src 'none'; img-src data:`), `nosniff`, `no-referrer`. The looser
  `standard-report` profile is granted only by `generated-file-serving.ts:152-165` for HTML from a
  succeeded `document_source` job. Downloads never get a CSP.
- `user-skills.ts` has TWO copies of the spreadsheet prose. `:594`/`:608` is the **shipped** skill and
  already says "XLSX/CSV/TSV". `:915` is `previousBuiltInSystemSkillDefaults` — a **migration
  baseline** describing what users' stored copies look like — and it is the one naming `.xls`/`.tsv`,
  mirrored byte-for-byte in `scripts/skill-eval-fixtures.ts:138-140`. **Neither the baseline nor the
  fixture may change**; editing them would re-trigger skill migration for every user.

### 1.5 Measured prose lengths (the D13 budget baseline)

| string | chars | ≈ tokens |
| --- | ---: | ---: |
| `prompts.ts:156` produce_file table row | 146 | 37 |
| `produce_file` EN (`normal-chat-tools/index.ts:285`) | 1 627 | 407 |
| `produce_file` HU (`:377`) | 1 764 | 441 (HU tokenises worse; treat as a floor) |
| `read_generated_file` EN (`:290`) | 874 | 219 |
| `read_generated_file` HU (`:382`) | 992 | 248 |

---

## 2. Registry contracts and the exact new table

**Owner: slice P5-A, exclusively, for BOTH phases.** Nobody else edits `src/lib/shared/file-types/**`
except P6-D, which owns `model-facing.ts`, `format-prose.test.ts` and `model-facing.test.ts` only.

### 2.1 New types

```ts
// src/lib/shared/file-types/types.ts — additions only, nothing renamed or removed.

/**
 * Entries whose intake route only works against a MinerU 4.x backend.
 * Phase 5 sets it on rtf/odt/ods/odp/epub. A gated entry that the runtime
 * gate disables behaves exactly as `reject` / `formatNotEnabled`.
 */
export interface FileTypeIntake {
	readonly route: IntakeRoute;
	readonly tierHint?: IntakeTierHint;
	readonly rejectReason?: RejectReasonKey;
	/** NEW. True iff a pre-4.x MinerU cannot parse this type at all. */
	readonly requiresMineru4?: true;
}
```

```ts
// src/lib/shared/file-types/index.ts — additions.

/** Ids carrying `intake.requiresMineru4`. Sorted, memoised. */
export function getMineru4GatedFileTypeIds(): readonly string[];

/**
 * `getAcceptAttribute` minus a set of disabled entry ids. Pure and NOT
 * memoised (the disabled set changes with backend health), which is why it is
 * a separate function rather than an option on the memoised accessor.
 */
export function buildAcceptAttribute(
	surface: UploadSurface,
	disabledEntryIds?: ReadonlySet<string>,
): string;
```

### 2.2 Entries that CHANGE

Transcribe exactly. Fields not listed are unchanged.

| id | `intake` before | `intake` after | `surfaces` before → after | `preview.kind` | `signatures` |
| --- | --- | --- | --- | --- | --- |
| `html` | `{ route: "direct-text" }` | `{ route: "mineru", tierHint: "flash" }` | `["knowledge","chat"]` (unchanged) | `html` (unchanged) | none (text) |
| `rtf` | `{ route: "reject", rejectReason: "formatNotEnabled" }` | `{ route: "mineru", tierHint: "flash", requiresMineru4: true }` | `[]` → `["knowledge","chat"]` | `text` (unchanged) | **NEW** `[{ offset: 0, bytes: [0x7b,0x5c,0x72,0x74,0x66] }]` (`{\rtf`) |
| `odt` | `{ route: "mineru" }` | `{ route: "mineru", tierHint: "flash", requiresMineru4: true }` | `["chat"]` → `["knowledge","chat"]` | `odt` (unchanged) | ZIP (unchanged) |
| `ods` | `{ route: "reject", rejectReason: "formatNotEnabled" }` | `{ route: "mineru", tierHint: "flash", requiresMineru4: true }` | `[]` → `["knowledge","chat"]` | `unsupported` | ZIP (unchanged) |
| `odp` | same as `ods` | same as `ods` | `[]` → `["knowledge","chat"]` | `unsupported` | ZIP (unchanged) |
| `tsv` | `{ route: "reject", rejectReason: "formatNotEnabled" }` | `{ route: "direct-text" }` | `[]` → `["knowledge","chat"]` | `unsupported` → **`text`** | none |
| `docx` | `{ route: "mineru" }` | `{ route: "mineru", tierHint: "flash" }` | unchanged | unchanged | unchanged |
| `xlsx` | `{ route: "mineru" }` | `{ route: "mineru", tierHint: "flash" }` | unchanged | unchanged | unchanged |
| `pptx` | `{ route: "mineru" }` | `{ route: "mineru", tierHint: "flash" }` | unchanged | unchanged | unchanged |
| `doc` | `{ route: "mineru" }` | `{ route: "mineru", tierHint: "flash" }` | unchanged | unchanged | OLE2 (unchanged) |
| `xls` | `{ route: "mineru" }` | `{ route: "mineru", tierHint: "flash" }` | unchanged | unchanged | OLE2 (unchanged) |
| `ppt` | `{ route: "mineru" }` | `{ route: "mineru", tierHint: "flash" }` | unchanged | unchanged | OLE2 (unchanged) |

`pdf`, `jpg`, `png`, `gif`, `webp`, `bmp`, `tif`, `heic`, `heif`, `avif`, `svg`: **no tier hint**. PDF
and images are the only inputs the fixtures show resolving to `basic`; hinting them `flash` would trade
OCR quality for 300 ms.

`tsv` production fields change too (Phase 6 lands in the same P5-A edit, see §2.4).
`rtf` stays `production: { requestable: false, types: {}, validation: "none" }`, `textLike: false`
(conflict 3 — `.rtf` was never in `TEXT_LIKE_EXTENSIONS`; the invariant
`production.validation === "text" ⇔ textLike` forbids changing one without the other).

### 2.3 Entries that are NEW

```ts
	{
		id: "epub",
		extensions: ["epub"],
		mimeTypes: ["application/epub+zip"],
		category: "document",
		// No EPUB renderer exists in preview-runtime/office; `OfficePreviewKind`
		// is Extract<PreviewKind, "docx"|"xlsx"|"pptx"|"odt"> and adding a kind
		// without a renderer is a compile error there by design.
		preview: { kind: "unsupported" },
		intake: { route: "mineru", tierHint: "flash", requiresMineru4: true },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: ["knowledge", "chat"],
		signatures: ZIP_SIGNATURES,
	},
	{
		// Recognised so an .ofd upload gets the "save it as PDF" message rather
		// than "that file type isn't supported". NOT enabled: the 2026-09-20
		// spike recorded nine inputs and OFD was not one of them, and no
		// fixture, latency figure or output sample exists for it anywhere in
		// the tree. Flipping it later is the same one-line edit as `rtf` was.
		// It is also the sole remaining user of `rejectReason: "formatNotEnabled"`,
		// which keeps that reason and its EN/HU copy alive.
		id: "ofd",
		extensions: ["ofd"],
		// No IANA registration; `application/ofd` is what the GB/T 33190 tooling
		// emits. Alias `application/octet-stream` is NOT added — it is a `zip`
		// alias and generic MIMEs never reverse-resolve (`index.ts:110`).
		mimeTypes: ["application/ofd"],
		category: "document",
		preview: { kind: "unsupported" },
		intake: { route: "reject", rejectReason: "formatNotEnabled" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: [],
		signatures: ZIP_SIGNATURES,
	},
```

### 2.4 Production fields that change (Phase 6, same P5-A edit)

```ts
	// `tsv`, final shape after both phases:
	{
		id: "tsv",
		extensions: ["tsv"],
		mimeTypes: ["text/tab-separated-values"],
		category: "spreadsheet",
		preview: { kind: "text" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: { tsv: ".tsv", "text/tab-separated-values": ".tsv" },
			validation: "text",
			// No exampleRank: FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES stays
			// "xlsx, docx, pptx, pdf, csv, zip", so no prompt string moves.
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
```

And in `production.ts`, `PRODUCED_EXTENSION_MIME_TYPES` gains exactly one row, placed next to `.csv`:

```ts
	".tsv": ["text/tab-separated-values", "text/plain"],
```

### 2.5 Accept strings (D5)

`SURFACE_ACCEPT_ORDER.knowledge` keeps its frozen 26-extension head (so the historical string is still
a readable prefix) and **appends, in this order**, every other non-reject extension:

```
markdown,
odt, rtf, ods, odp, epub, tsv,
xml, css, scss, sass, less, js, mjs, cjs, jsx, ts, tsx, py, sh, bash, zsh, yaml, yml,
toml, sql, graphql, gql, ini, env, conf, log, rb, rs, go, java, kt, kts, swift, cs,
cpp, cxx, cc, hpp, c, h, php, r
```

Totals after both phases, asserted as tripwires in `registry.test.ts`:

| quantity | before | after |
| --- | ---: | ---: |
| `FILE_TYPE_ENTRIES.length` | 71 | **73** |
| total extensions | 89 | **91** |
| non-reject extensions (= knowledge accept = chat accept) | 69 | **74** |
| reject extensions | 20 | **17** |
| requestable entries | 40 | **41** |

`KNOWLEDGE_ACCEPT_OMISSIONS` becomes `new Set([])` (keep the export; `index.ts` and `registry.test.ts`
are its only readers, and an empty frozen set leaves a home for the next deliberate omission).

**Why knowledge == chat.** Phase 1 OQ2/OQ3 recommended exactly this, "in the same PR as the MinerU 4.x
rollout so the change is announced once". The server gate is surface-independent by design (OQ10:
`admitUpload` takes no surface, because a per-surface gate would let a caller widen it by lying), so a
narrower knowledge accept only hides types the server already accepts. Today a `.py` dropped on the
Knowledge page is silently discarded as `knowledge.dropNoValidFiles` while the identical file works in
chat. There is no remaining justification for a difference; the two lists differ only in ORDER
(knowledge = frozen-then-appended, chat = table order), which `registry.test.ts` asserts as
set-equality.

### 2.6 Registry test updates (P5-A owns all of these)

`src/lib/shared/file-types/registry.test.ts`

| test | change |
| --- | --- |
| "has the expected size" | 71 → **73**, 89 → **91** |
| "keeps `SURFACE_ACCEPT_ORDER.knowledge` in step" | `missing` now expected `[]`; `KNOWLEDGE_ACCEPT_OMISSIONS` is empty |
| "routes unknown types to mineru and known reject entries to reject" | add `expect(getIntakeRoute("page.html", null)).toBe("mineru")`, `expect(getIntakeRoute("data.tsv", null)).toBe("direct-text")`, `expect(getIntakeRoute("doc.ofd", null)).toBe("reject")` |
| "never lets a text/\* MIME talk a reject entry past the gate" | `"memo.rtf"` no longer rejects — replace with `"scan.ofd"` |
| "only advertises extraction formats the upload endpoint admits" | unchanged (html is still non-reject) |
| "lets only `zip` be producible but not ingestible" | unchanged (D11) |
| NEW: "gates only the formats a 3.x backend cannot parse" | `getMineru4GatedFileTypeIds()` equals `["epub","odp","ods","odt","rtf"]`; every one has `route === "mineru"`; no `direct-text` or `reject` entry carries the flag |
| NEW: "gives every mineru Office entry a flash tier hint" | for `docx xlsx pptx odt ods odp doc xls ppt rtf epub html` → `tierHint === "flash"`; for `pdf jpg png gif webp bmp tif heic heif avif` → `tierHint === undefined` |
| NEW: "offers the same set of extensions on both surfaces" | `new Set(getAcceptedExtensions("knowledge"))` deep-equals `new Set(getAcceptedExtensions("chat"))`, and both equal the non-reject extension set |
| NEW: "`buildAcceptAttribute` drops exactly the disabled entries" | with `new Set(getMineru4GatedFileTypeIds())`, the result loses `.rtf,.odt,.ods,.odp,.epub` and nothing else, on both surfaces |

`src/lib/shared/file-types/legacy-equivalence.test.ts`

- `KNOWN_DELTAS` grows to **seven** groups; "has exactly six groups" becomes seven and the key order
  gains `directTextContraction` after `directTextExpansion`:
  ```ts
  	/**
  	 * Phase 5 D3. These were read as raw bytes into the prompt and now go to
  	 * MinerU at `flash`, which strips boilerplate and scripts. The ONLY
  	 * subtractive delta in this object; every other group is additive.
  	 */
  	directTextContraction: ["html", "htm"] as const,
  ```
- "reproduces `isDirectTextExtractionFile` apart from the sanctioned expansion": the loop currently
  asserts `expect(before).toBe(false)` on every divergence. Split it: divergences where `before` is
  `true` must be exactly `directTextContraction`; the rest are `directTextExpansion` (still 34).
- The `.rtf` assertions at the end of that test (`gained` must not contain `rtf`,
  `getIntakeRoute("x.rtf", null) === "reject"`) become `"ofd"` / `"reject"` and
  `getIntakeRoute("x.rtf", null) === "mineru"`.
- "reproduces the knowledge accept string byte for byte": `FROZEN_ACCEPT_STRING` is now a **prefix**
  assertion plus an exact assertion against a new `FROZEN_ACCEPT_STRING_V2`. Keep the original
  constant and assert `getAcceptAttribute("knowledge").startsWith(FROZEN_ACCEPT_STRING + ",")`, so a
  reviewer can still see the historical string was not reordered.
- "reproduces `TEXT_EXTENSIONS`, modulo html/htm": add `tsv` to the expected-gained set (it previews
  as text now and was not in `FROZEN_TEXT_EXTENSIONS`). Record it as part of
  `attachmentGlyphExpansion`-style prose in the group comment, not as a new group.

`src/lib/shared/file-types/no-ad-hoc-maps.test.ts` — re-measure and shrink the two transitional rows
(`execution-adapter.ts`, `produce-file.ts`) after P6-B lands; P5-A does not touch them.

`src/lib/shared/file-types/format-prose.test.ts` and `model-facing.test.ts` — **P6-D only**. P5-A must
not edit them, which means P5-A's branch will fail `format-prose.test.ts`'s
`entryById("tsv")?.intake.route === "reject"` assertion. That is expected and is listed in §8 as the
one sanctioned cross-slice red test; P6-D fixes it. P5-A's slice report must state it explicitly.

---

## 3. Phase 5 — per-format decision table

### 3.1 Uploads

| ext | route | tier hint | gated on MinerU 4 | preview | category | signature | surfaces | evidence / note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `html`, `htm` | mineru | flash | no | `html` | code | — | k+c | §1.2; −34…43 % tokens, boilerplate stripped, faithful heading levels |
| `rtf` | mineru | flash | **yes** | `text` | text | `{\rtf` | k+c | no spike fixture; MinerU upstream lists RTF. Gated. |
| `odt` | mineru | flash | **yes** | `odt` | document | ZIP | k+c | already `mineru` on `dev`; gains knowledge surface + hint |
| `ods` | mineru | flash | **yes** | `unsupported` | spreadsheet | ZIP | k+c | no ODS preview renderer exists |
| `odp` | mineru | flash | **yes** | `unsupported` | presentation | ZIP | k+c | ditto |
| `epub` | mineru | flash | **yes** | `unsupported` | document | ZIP | k+c | §1.1 — 10 ms, spine paging, faithful headings, the cheapest input measured |
| `ofd` | **reject** (`formatNotEnabled`) | — | — | `unsupported` | document | ZIP | — | zero evidence; entry exists for the better message and keeps `formatNotEnabled` in use |
| `tsv` | **direct-text** | — | no | `text` | spreadsheet | — | k+c | §1.2 counter-measurement; `run_python`/exceljs need raw delimiters |
| `doc`/`xls`/`ppt` | mineru | flash | no | `unsupported` | doc/sheet/slide | OLE2 | k+c | tier made explicit; §2.7 rule 2 — omitting it is a 503 on a flash-only server |
| audio ×6, video ×5 | reject (`media`) | — | — | `unsupported` | media | various | — | unchanged |
| `zip`,`rar`,`7z`,`tar`,`gz` | reject (`archive`) | — | — | `unsupported` | archive | various | — | unchanged; D11 |

### 3.2 Consequences of the `html` route change — all of them

1. **`.htm` follows automatically** — one entry, `extensions: ["html","htm"]`.
2. **HTML with an odd extension** (`page.download`, `text/html`): `resolveEntry` misses on the
   extension, hits `getEntryByMimeType("text/html")` → the `html` entry → `mineru`. Today it was
   `direct-text` through `isDirectTextFallbackMimeType`. The entry wins because `getIntakeRoute`
   consults `resolveEntry` first (`index.ts:489-491`). Consistent, and asserted by a new case.
3. **A `.html` file with a `text/plain` MIME** still routes `mineru` — the extension wins.
4. **The 8 MiB direct-text cap stops applying to HTML.** `upload/intent/+server.ts:156-180` refuses a
   direct-text file over `DOCUMENT_EXTRACTION_MAX_DIRECT_TEXT_BYTES` with 413
   `upload_direct_text_too_large`. An 8.1 MB HTML file is refused today and **accepted** after Phase 5,
   bounded instead by `MAX_FILE_UPLOAD_SIZE` (100 MB) and MinerU's own `max_file_size_bytes`
   (209 715 200). This is a deliberate widening; the slice report must name it.
5. **`.tsv` gains the cap**: a >8 MiB `.tsv` now gets 413 `upload_direct_text_too_large` where today it
   gets 415 `formatNotEnabled`. Both are refusals; the message improves.
6. **HTML becomes unreadable while MinerU is down.** Today raw HTML always worked. Mitigation is the
   existing one for every other MinerU type — the ledger retries, the composer chip says "still
   processing", the send gate holds (Phase 3 S3/S4). **No direct-text fallback is added**: two code
   paths for one type is exactly the drift this migration exists to end. Listed as OQ2.

### 3.3 Direct-text decoding (new shared module)

`src/lib/server/services/extraction/text-decode.ts` — **new, owned by P5-B.** It is the single decoder
for BOTH `extractors/direct-text.ts` and `chat-files.decodeTextLikeGeneratedFile`, so an uploaded `.md`
and a generated `.md` chunk identically.

```ts
export type TextDecodeFailure =
	| { reason: "binary_content"; detail: string }
	| { reason: "unsupported_encoding"; detail: string };

export type TextDecodeResult =
	| { ok: true; text: string; encoding: "utf-8" | "utf-16le" | "utf-16be" }
	| { ok: false; failure: TextDecodeFailure };

/**
 * Decodes bytes that are supposed to be text.
 *
 * Order is load-bearing: BOM first (a UTF-16 file's bytes are NOT valid UTF-8
 * and would otherwise be read as NUL-interleaved mojibake), then the binary
 * check on the DECODED string, then CRLF normalisation and trim — the last two
 * exactly as `task-state/chunk-sync.ts` does them, so chunk text and therefore
 * embeddings are unchanged for every file that decodes today.
 */
export function decodeTextBuffer(buffer: Buffer): TextDecodeResult;
```

Rules, normative:

| input | behaviour |
| --- | --- |
| `EF BB BF` prefix | strip the BOM, decode `utf-8` |
| `FF FE` prefix (and NOT `FF FE 00 00`) | decode `utf16le`, strip the BOM |
| `FE FF` prefix | byte-swap the remainder, decode `utf16le`, report `utf-16be` |
| `FF FE 00 00` or `00 00 FE FF` prefix | `unsupported_encoding` — Node has no UTF-32 decoder and hand-rolling one for a format nobody uploads is not worth the surface |
| no BOM | decode `utf-8`. **No heuristic UTF-16 sniffing** — a file that is UTF-16 without a BOM is indistinguishable from a binary, and guessing would mangle legitimate Latin-1-ish text |
| decoded string contains ` ` | `binary_content` |
| decoded string is >1 % `�` (U+FFFD replacement chars), measured over the first 64 KiB | `binary_content` — a mostly-Latin-1 file with a few bad bytes still reads, a JPEG renamed `.txt` does not |
| result empty after `.trim()` | caller throws `empty_result`, unchanged |

Call-site changes:

- `extractors/direct-text.ts`: replace `buffer.toString("utf8").replace(/\r\n/g,"\n").trim()` with
  `decodeTextBuffer(buffer)`. On `ok: false` throw
  `new DocumentExtractionError({ code: "unsupported_type", message, retryable: false,
  details: { reason: failure.reason } })`. **No new `ExtractionErrorCode`** — `unsupported_type` is
  already non-retryable and already has EN/HU i18n from Phase 3; `details.reason` discriminates for
  the log. Adding a code would force new `chat.extraction.error.*` and
  `knowledge.extraction.error.*` keys in a slice that owns neither i18n file.
- `chat-files.ts:610-612` `decodeTextLikeGeneratedFile`: return `null` on `ok: false` (today's
  "no readable text" wrapper), which is the existing non-fatal behaviour.

### 3.4 Reject messaging

All five keys already exist in both locales (`src/lib/i18n/knowledge.ts` EN `:136-153`, HU `:541-554`)
and are asserted present by `src/lib/i18n.test.ts:49-51`. **No new i18n keys are needed.** What changes:

| reason | entries using it before | after |
| --- | --- | --- |
| `media` | 11 | 11 (unchanged) |
| `archive` | 5 | 5 (unchanged) |
| `formatNotEnabled` | `rtf`, `ods`, `odp`, `tsv` | **`ofd` only** — plus every gated entry at runtime when D6's gate is closed |
| `unknownType` | (no entry; the `admitUpload` fallback) | unchanged |

The `formatNotEnabled` copy — EN "{ext} files aren't supported yet. Save it as PDF or DOCX and upload
that." / HU "A(z) {ext} fájlokat még nem támogatjuk. Mentsd el PDF- vagy DOCX-formátumban, és azt töltsd
fel." — is exactly right for both `.ofd` and a gated `.epub` on an old backend. Do not reword it.

**The `archive` route: reserved, described, NOT built.** Design of record, so the reviewer can check
nothing in this phase half-implements it: an `archive`-routed entry would be admitted at intent, stored,
and handed to an `extractors/archive.ts` that enumerates entries, re-runs `admitUpload` per entry,
enqueues a child extraction job per admitted entry at `EXTRACTION_PRIORITY_UPLOAD + 5`, and synthesises
a parent artifact whose text is a manifest. That needs a parent/child column on
`document_extraction_jobs`, a per-entry size budget, a zip-bomb guard and a new error code. None of it
is in scope. `registry.test.ts`'s "uses no RESERVED intake route" stays green (`archive` remains a
`rejectReason`, never a `route`).

### 3.5 The MinerU-4 availability gate (D6)

**Why a gate at all.** On MinerU 3.x, `POST /file_parse` is the only endpoint and `rtf`/`odt`/`ods`/
`odp`/`epub` fail there. Phase 5 widens the accept string; without a gate, an operator running 3.x
would see five new formats offered and every one of them fail. HTML is deliberately NOT gated — a 3.x
backend parses HTML, just worse.

**What it keys on: the server version, not the tier list.** `GET /v1/health` returns
`{"version":"4.0.4", ...}` and does not exist at all on 3.x, so a reachable `/v1/health` with
`major >= 4` is the exact predicate. The tier list is the wrong key: every recorded `/v1/tiers`
response contains `flash`, so "disable flash-only formats when the server lacks flash" would be a guard
against a case that has never been observed. (`decideTier` rule 5 already handles a flash-only server
by sending `flash` explicitly.)

```ts
// src/lib/server/services/knowledge/format-availability.ts   [needs-P24]

export interface UploadFormatGate {
	/** Registry entry ids currently refused. Empty when the backend is fine or unknown. */
	readonly disabledEntryIds: ReadonlySet<string>;
	/** null when nothing is disabled. */
	readonly reason: "backend_version" | null;
	readonly backendVersion: string | null;
	readonly checkedAt: string;
}

/**
 * Cached behind `getMineruCapabilities`'s own TTL; never throws.
 *
 * Fails OPEN. A probe that has never succeeded, or one that failed, returns an
 * empty `disabledEntryIds`: a momentary outage must not silently shrink the
 * file picker, and a genuinely unparseable upload then fails on the ledger with
 * the Retry button the user already knows. Only a probe that positively ANSWERS
 * with a major version below 4 closes the gate.
 */
export async function getUploadFormatGate(): Promise<UploadFormatGate>;
```

Server enforcement, in `src/routes/api/knowledge/upload/intent/+server.ts`, **immediately after** the
existing `admitUpload` 415 block (`:122-154`) and before the direct-text cap:

```ts
	const gate = await getUploadFormatGate();
	if (admission.entry && gate.disabledEntryIds.has(admission.entry.id)) {
		// Identical envelope to an `admitUpload` refusal: same 415, same code,
		// same errorKey. A gated format is indistinguishable from a
		// not-yet-enabled one, which is exactly what it is.
		return json({ /* ...as the admitUpload branch, reason: "formatNotEnabled" */ },
			{ status: 415 });
	}
```

The same check goes into `refuseUnsupportedUploadType`
(`src/routes/api/knowledge/upload/shared.ts:180-205`), because intent is a handshake and not a gate.

Client: `gate.disabledEntryIds` rides the SSR shell (`src/lib/server/services/app-shell.ts`, next to
`maxFileUploadSize`) into a new `src/lib/stores/upload-format-gate.ts`, and
`DocumentsList.svelte` / `MessageInput.svelte` call
`buildAcceptAttribute(surface, $disabledFileTypeIds)` instead of `getAcceptAttribute(surface)`.

**What the user sees:** the format is simply not offered in the picker, and `partitionUploadableFiles`
filters it out of a drop. Forcing it through the OS "All files" escape hatch yields the existing
`{ext} files aren't supported yet…` message. No new string, no banner, no admin toggle. The admin sees
the real reason on the MinerU status card (Phase 2 §2.11) — `version` is already a row there.

### 3.6 Paste-to-attach

**There is no paste handler anywhere in `src/` today** — a repo-wide grep for
`onpaste|on:paste|ClipboardEvent|clipboardData` returns nothing. The "existing text-paste behaviour
tied to document outlines" is `insertQuoteAtCursor` / `pendingQuotes`
(`MessageInput.svelte:1214-1236`, expanded at send by `expandQuotesIntoMessage` `:1250-1255`,
applied in `buildSendPayload` `:1436-1442`) — an in-app outline pick that **replaced** a paste in the
2026-09-15 chips redesign. It never touches the clipboard. What must be protected is therefore the
browser's own native text paste into the `<textarea>`, and nothing else.

```ts
// src/lib/utils/clipboard-attachments.ts — new, pure, unit-testable, owned by P5-C.

export interface ClipboardAttachmentDecision {
	/** Files to hand to `uploadFiles`. Empty ⇒ do nothing. */
	readonly files: readonly File[];
	/** True only when `files` is non-empty. */
	readonly preventDefault: boolean;
	/** Registry refusals, already keyed for `$t`. */
	readonly refused: ReadonlyArray<{ name: string; errorKey: string }>;
}

/**
 * Decides whether a paste is an attachment or a text paste.
 *
 * The rule is deliberately conservative: a clipboard that carries ANY
 * `text/plain` flavour is a text paste, full stop. Copying a cell range from
 * Excel, a paragraph from Word or a figure from a web page all put an image on
 * the clipboard ALONGSIDE the text, and hijacking those would make the
 * composer unusable. A screenshot (Cmd-Shift-4, Print Screen) and a file copied
 * in Finder/Explorer carry files and no `text/plain`, which is exactly the case
 * worth handling.
 */
export function decideClipboardAttachment(
	data: DataTransfer | null,
): ClipboardAttachmentDecision;
```

Rules:

| clipboard | decision |
| --- | --- |
| `data` null, or `data.files.length === 0` | `{ files: [], preventDefault: false }` — native paste |
| `data.types` includes `"text/plain"` | `{ files: [], preventDefault: false }` — native paste, whatever files are also present |
| files present, no `text/plain` | attach every file, `preventDefault: true` |

Per file, before attaching: rename when the browser gives no usable name (Chrome/Safari hand a
screenshot over as `image.png`, Firefox sometimes as `""`) to
`pasted-<YYYYMMDD-HHmmss>.<ext>` where `<ext>` is
`getEntryByMimeType(file.type)?.extensions[0] ?? "bin"`; then run `admitUpload(name, file.type)` and
push refusals into `refused` with `UPLOAD_REJECT_I18N_KEYS[reason]`. The size limit is **not** checked
here — `uploadFiles` already owns it (`MessageInput.svelte:2586-2604`) and duplicating it would be the
fifth copy of a number this migration spent a phase removing.

Wiring, `MessageInput.svelte` (P5-C owns the file):

```svelte
	onpaste={(event: ClipboardEvent) => {
		const decision = decideClipboardAttachment(event.clipboardData);
		if (decision.refused.length > 0) {
			attachmentError = $t(decision.refused[0].errorKey, { name: decision.refused[0].name });
		}
		if (!decision.preventDefault) return;
		event.preventDefault();
		void uploadFiles(toFileList(decision.files));
	}}
```

`uploadFiles` takes a `FileList | null`; a `DataTransfer` built with `new DataTransfer()` and
`.items.add(file)` is the only way to synthesise one in a browser. Prefer widening `uploadFiles` to
`FileList | readonly File[] | null` in the same slice — it already does
`Array.from(files)` on the first line — and skip the `DataTransfer` dance entirely.

**Mobile.** No separate composer exists; `MessageInput.svelte` is responsive in place
(`isPhone`/`isMobile()`/`AttachmentPickerSheet`). iOS Safari and Android Chrome both fire `paste` with
`clipboardData.files` for an image copied from Photos or a screenshot. The same handler covers both.
No touch-specific code. `AttachmentPickerSheet`'s `accept="image/*"` rows (`:84`, `:92`) are intent
filters for Photos/Camera, not type gates (Phase 1 OQ8) — leave them.

### 3.7 Docs rewrite (P5-B owns)

`docs/uploads.md` (77 lines) is rewritten end to end. It is wrong in three ways today:

1. `:5` claims extraction goes to `${MINERU_API_URL}/file_parse` via
   `src/lib/server/services/document-extraction.ts`. That endpoint is MinerU 3.x and that module is
   **deleted** in Phase 2 §2.12. The real surface is the async `/v1/uploads` → `/v1/parse/jobs` →
   `/v1/files/{id}/content` sequence behind the ledger.
2. `:24-31` hand-maintains a 26-extension list that duplicates `SURFACE_ACCEPT_ORDER.knowledge`.
   Replace it with a pointer plus a one-line `node -e` snippet that prints the live list, so it cannot
   drift again.
3. `:40-77` "Host image normalization tools".

**The host-prerequisites ruling: DELETE, with evidence.**

- `git grep -nE "\bspawn|execFile|child_process|execSync" -- src/` returns **nothing**. Every
  `exec(` hit in `src/` is `RegExp.prototype.exec` or `sqlite.exec`; the one in
  `sandbox/config.ts:257` is `container.exec` (the Docker API, not a host process). The only
  `execSync` calls in the repo are `scripts/seed-admin.ts:13,28` and `scripts/seed-user.ts:17,47`,
  both running `npm run db:prepare`.
- `git grep -niE "soffice|libreoffice|imagemagick|ghostscript|pdftoppm|pdftotext|librsvg"` over `src/`
  and `scripts/`: **zero hits**. The only matches in the whole tree are the doc lines being deleted
  and `user-skills.test.ts:607`, which asserts a *prompt string* mentions "Excel/LibreOffice".
- Therefore `libreoffice`, `ImageMagick`, `ghostscript`, `poppler-utils` and `librsvg2` are
  requirements of **MinerU's own container host**, not of the Node app. `MINERU_API_URL` explicitly
  allows MinerU to live on another machine, so the instructions as written point at the wrong box.

Replacement text, one paragraph: MinerU's container ships its own converters; if you build a custom
MinerU image or run it outside Docker, see MinerU's documentation for its host requirements. The
AlmaLinux/RHEL HEIF delegate recipe moves verbatim into the MinerU operations section with a heading
that says whose host it is. `deploy/README.md:505-508` loses its two bullets and gains the same
one-line pointer. `:509` ("MinerU handles OCR natively in all backends") stays — it is true.

`docs/configuration.md`: no format list to fix; add `MINERU_CAPABILITIES_TTL_MS` (from Phase 2) to the
gate's description and cross-link `DOCUMENT_EXTRACTION_MAX_DIRECT_TEXT_BYTES` to the §3.2.4 note that
it no longer applies to HTML. `README.md:17,34-35,131` are pointers only — no change.

---

## 4. Phase 6 — the generation side

### 4.1 Output decision table (D7)

| candidate | can the sandbox make it today? | verdict |
| --- | --- | --- |
| `png` | **No.** No pillow, no matplotlib in `SANDBOX_PYTHON_PACKAGES`; JS has `chart.js` but no canvas backend. Adding them costs 40.5 MiB of wheels / ~137 MB unpacked / 4→11 distributions (§1.3) **and** forces a cached-prefix eviction via `deploy.test.ts:328-339`. `renderers/chart-svg.ts` already draws the charts we need. | **DROP** |
| `jpg` | Same, plus lossy raster is the wrong default for a generated chart. | **DROP** |
| `svg` | **Already requestable** (`table.ts:885-891`), already live-verified (`program-svg` case), already CSP-locked on preview (§1.4). A program writes the XML string directly; no library needed. | **NO CHANGE** — do not re-add |
| `epub` | Only by hand-building a ZIP (mimetype + `META-INF/container.xml` + OPF + spine + XHTML) with `jszip`. No library, no validator, no preview renderer, no readback until D1 lands. A model getting the OPF manifest subtly wrong produces a file no reader opens, and `validation: "none"` would not catch it. | **DROP** |
| `ods` | Same hand-built-ZIP argument. XLSX via `exceljs` is strictly better and opens in LibreOffice. The existing `odt` output exists only because it predates this review; its live case (`verify-live-file-production-types.ts:402-403`) writes a 2-entry package with no `META-INF/manifest.xml`. | **DROP** |
| `odp` | Same, and PPTX via `pptxgenjs` is strictly better. | **DROP** |
| `rtf` | Trivially producible (a program writes `{\rtf1…}`). But DOCX is already requestable and strictly better; RTF would ship with `validation: "none"`, a preview that shows raw control words, and a readback that costs a MinerU job. No demand in any prose or fixture. | **DROP** (condition to revisit: a user asking for a Word-openable file on a machine without Word) |
| `tex` | A program can write `.tex`, but nothing can compile it, `.tex` already uploads fine through the `text/*` MIME fallback, and offering it invites the model to promise a PDF it cannot build. | **DROP** |
| **`tsv`** | **Yes** — plain text, zero libraries, and after D8 it does not even need a container. Closes the `KNOWN_PROSE_EXCEPTIONS.nonRequestableSkillFormats` gap for the format the shipped spreadsheet skill already advertises. Round-trips through `run_python` and `exceljs`. | **ADD** |

Full row for `tsv`:

| field | value |
| --- | --- |
| requestable | `true`, tokens `{ tsv: ".tsv", "text/tab-separated-values": ".tsv" }` |
| how produced | `inline_text` (D8) for the simple form; program mode writes `/output/x.tsv` |
| validation class | `text` → `validateTextLikeOutputBytes` (NUL + fatal UTF-8) |
| produced MIME allow-list | `[".tsv"]: ["text/tab-separated-values", "text/plain"]` |
| canonical MIME for sandbox labelling | `text/tab-separated-values` (derived) |
| preview kind | `text` |
| serving CSP | none — not HTML, not SVG |
| readback route | `direct-text`, decoded in `chat-files.decodeTextLikeGeneratedFile`, never reaches the ledger |
| `exampleRank` | **none** — keeps `FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES` at `"xlsx, docx, pptx, pdf, csv, zip"`, so no prompt string moves |
| live verify row | `program-tsv` **and** `inline-tsv` (§5) |

### 4.2 D8 — the `inline_text` production mode

**The problem.** `{ requestTitle, filename: "x.md", markdown: "# ..." }` — the call `prompts.ts:186`
teaches the model — resolves to type `md`, fails `shouldUseDocumentSourceForOutputs`, and is executed
by a Python script inside a Docker container whose only job is `write_text`. Startup, tmpfs mount and
teardown for a string copy.

**Why not "route markdown to the Markdown renderer".** That path is `buildDocumentSourceFromText` →
blocks → `renderStandardReportMarkdown` → markdown. It is **not identity**: fences, tables, nested
lists, front matter and inline HTML all change. The user asked for a file containing their markdown,
and silently reformatting it is a regression. It would also require flipping `md` to
`production.documentSource: true`, which `registry.test.ts:365-378` pins as the case that makes the two
fields necessary. The Markdown *renderer* keeps its job: rendering a `documentSource` job that lists
`markdown` among its outputs.

```ts
// src/lib/server/services/file-production/types.ts — new request shape.

/**
 * Bytes we already hold, written straight to storage. No container, no
 * renderer, no sandbox timeout.
 *
 * Restricted to outputs whose registry entry has `production.validation ===
 * "text"` and no `documentSource`, which is precisely the set
 * `buildTextFileProgram` was being used for. A PDF/DOCX/HTML request still goes
 * to the report renderers; an XLSX/PPTX/ZIP request still goes to the sandbox.
 */
export interface FileProductionInlineTextRequest {
	readonly sourceMode: "inline_text";
	/** Sanitised; its extension is `getExpectedExtensionForOutputType(outputType)`. */
	readonly filename: string;
	readonly outputType: string;
	/** Verbatim apart from CRLF normalisation. */
	readonly content: string;
}
```

```ts
// src/lib/server/services/normal-chat-tools/produce-file.ts

/**
 * True iff EVERY requested output resolves to an entry that is text-validated
 * and is not a document source. Empty list is false (the caller's earlier
 * ladder has already defaulted it).
 */
export function isInlineTextRequest(types: readonly string[]): boolean;
```

Qualifying inputs, exhaustively — the branch is inside `if (content)` at `produce-file.ts:307`, which
is only reachable when **all** of these hold, and the slice must assert each one:

1. `input.program` is absent **and** `input.sourceMode !== "program"` (the explicit-program branch
   returns at `:213-257`, before this);
2. `input.documentSource` is absent **and** `input.sourceMode !== "document_source"` (returns at
   `:259-306`);
3. `content` (`markdown` ?? `text` ?? `content`) is present and passes `hasSubstantiveContent`;
4. `shouldUseDocumentSourceForOutputs(requestedOutputs)` is `false` (pdf/docx/html keep the report
   path, including the bare-`documentSource`-default case, which is `true` for an empty list);
5. `isInlineTextRequest(requestedOutputs.map(o => o.type))` is `true`.

A program-mode markdown request — `sourceMode: "program"` with `program.sourceCode` — is unaffected
because it returns two branches earlier. **Test this explicitly**, both directions.

Execution, `execution-adapter.ts`: a third arm in `parseFileProductionJobRequest` beside
`document_source` and `program`, and a `runInlineText` that validates through the existing
`validateGeneratedOutputFile` (so `tsv`/`md`/`txt` still get the NUL + UTF-8 check) and hands the buffer
to the storage adapter. `limits.ts` applies unchanged (`maxOutputFileBytes`); `sandboxTimeoutMs` does
not apply and must not be consulted.

**Bonus fix (in scope, one line).** `resolveTextFilename` uses `requestedOutputs[0]?.type`. Mixed
requests like `[pdf, md]` currently produce a text file named `.pdf` that passes validation (§1.4).
With `inline_text`, rule 4 sends `[pdf, md]` to… still program mode, because
`shouldUseDocumentSourceForOutputs` is false and `isInlineTextRequest` is false. Add an explicit
refusal instead: when `requestedOutputs` mixes a documentSource type with a non-documentSource type,
return `ok: false` with
`"Request one group of formats at a time: PDF/DOCX/HTML together, or data formats together."`
`format-prose.test.ts` does not cover this string (it is an error, not a tool description), so it can
ship in P6-B without waiting for D13.

### 4.3 Readback (D9, D10)

Three cases, three answers. The decision is made in exactly two places.

| generated file | decided where | route |
| --- | --- | --- |
| `document_source` outputs (PDF/DOCX/HTML/MD rendered from our own source JSON) | `chat-files.ts:690-696` — **already skips**, because `listGeneratedOutputArtifactIdsByChatFile` maps every `generatedDocumentRenderedChatFileIds` entry onto the source artifact | never reaches the ledger; text comes from the source |
| `inline_text` and other text-like outputs (`md`, `txt`, `csv`, `tsv`, `json`, code) | `chat-files.ts:716-720` — `getIntakeRoute` says `direct-text` | decoded in-process by `decodeTextBuffer` (§3.3) |
| program-mode Office/PDF (`xlsx`, `pptx`, `docx`, `pdf`, `odt`) | `chat-files.ts:623-654` `enqueueGeneratedFileReadback` | MinerU, with `hints: { preferredTier: "flash" }` |

**D9 — where the source-first text comes from.** Today `source-persistence.ts:134` writes
`buildGeneratedDocumentProjection(source)`. Replace it with the Markdown renderer, so the text the model
reads back is byte-identical to the `.md` the user can download, and so the tree has one
source→markdown renderer instead of two:

```ts
// src/lib/server/services/file-production/source-persistence.ts

export interface PersistGeneratedDocumentSourceInput {
	// …unchanged fields…
	/**
	 * The already-rendered Markdown, when the job requested `markdown` among
	 * its outputs and the worker therefore rendered it anyway. Omitted ⇒ this
	 * function renders it once itself. Either way the renderer runs exactly
	 * once per job: it is a pure, synchronous function of the validated source
	 * object, with no image loader and no favicon resolution.
	 */
	readonly renderedMarkdown?: string;
}
```

`buildGeneratedDocumentProjection` is **deleted** from `source-schema.ts` (one caller). Its helpers
(`generatedDocumentCitationPlainText`, `formatSourceProjection`, `generatedDocumentBasisClaimLabel`) are
used elsewhere and stay.

**Fallback.** If `validateGeneratedDocumentSource` fails or `renderStandardReportMarkdown` throws, log
once and fall through to `enqueueGeneratedFileReadback` for the rendered binaries — i.e. exactly
today's behaviour for a non-source file. Never write an empty artifact.

**D10 — the flash hint.** `enqueueGeneratedFileReadback` gains
`hints: { preferredTier: "flash" }`. Justification: a generated DOCX/XLSX/PPTX already resolves to
`flash` server-side (§1.1), and a generated PDF is born-digital — it came out of
`renderStandardReportPdf` or a `pdf-lib`/`reportlab`-free program — so OCR is pure waste. Flash PDF is
811 ms against 1 126 ms warm and **18 600 ms cold** at `basic`, and readback runs at priority 10 behind
every user upload, so the cold-start penalty is exactly the one worth avoiding.

**`preferredTier` is a new, SOFT hint and requires a small change to Phase 2's `decideTier`.**
`hints.tier` (the re-extract override, §2.7 rule 1) throws `tier_unavailable` when the tier is absent
from `availableTiers` — correct for a button the user pressed, catastrophic for a background readback,
which would fail permanently instead of parsing at whatever tier exists. Add rule 1½:

| # | condition | `tier` sent |
| --- | --- | --- |
| 1 | `hints.tier` set and available | that tier |
| 1′ | `hints.tier` set and unavailable | throw `tier_unavailable` |
| **1½** | **`hints.preferredTier` set and available** | **that tier** |
| **1″** | **`hints.preferredTier` set and unavailable** | **fall through to rule 2** |
| 2… | unchanged | |

This is a **cross-phase dependency**: P6-A cannot merge before `mineru4/p24`, and the P6-A slice report
must name the `decideTier` change so the Phase 2 reviewer sees it. If `mineru4/p24` shipped
`decideTier` without rule 1½, P6-A adds it in `services/mineru/client.ts` (or wherever `decideTier`
landed) and owns that hunk.

### 4.4 D11 — the `zip` exemption

Keep it. `zip` stays `production.requestable: true` + `intake: { route: "reject", rejectReason:
"archive" }`, exempted by name in `registry.test.ts:327-334` and `format-prose.test.ts:245-254`. Only
the comments change: "Phase >= 2 moves it to the RESERVED archive route" becomes a pointer to §3.4 of
this spec. Flipping it to `route: "archive"` now would make `admitUpload` return `allowed: true` for a
`.zip` with no extractor behind it — a worse outcome than the honest refusal it gives today.

### 4.5 D13 — the single prose release

**One slice (P6-D), last, one commit.** Every string below sits in the local model's cached prompt
prefix (Flash-Next caches on 1 600-token blocks); shipping them separately would evict every user's
prefix once per slice.

| string | file:line | change | Δ chars |
| --- | --- | --- | ---: |
| `produce_file` EN | `normal-chat-tools/index.ts:285` | `chartType:bar\|line\|pie\|donut\|scatter` → `chartType:bar\|stackedBar\|line\|area\|pie\|scatter\|donut`; append `stackedBar also needs seriesKey.` | +16 (+32 with the seriesKey clause) |
| `produce_file` HU | `:377` | same list, same clause | +16 / +34 |
| `read_generated_file` EN | `:290` | one sentence for Phase 4's `page`: "For a paged document, pass `page` to jump to one page instead of a character window." | ≈ +95 |
| `read_generated_file` HU | `:382` | HU rendering of the same | ≈ +110 |
| `page` parameter `.describe()` | `read-generated-file.ts` schema (Phase 4 adds the field) | EN only, ~110 chars, **and it is part of the serialized tool definition, i.e. inside the prefix** | ≈ +110 |
| `prompts.ts:156` table row | `prompts.ts` | **no change** — "and other generated artifacts" already covers `tsv` | 0 |
| `prompts.ts:188-189` guidance | `prompts.ts` | **no change** | 0 |
| `FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES` | derived from `exampleRank` | **no change** — `tsv` gets no rank | 0 |
| `produce_file` format list `(PDF, DOCX, XLSX, PPTX, CSV, Markdown, ...)` | both locales | **no change** — the `...` already covers `tsv`, and widening it is pure prefix cost | 0 |
| shipped spreadsheet skill `user-skills.ts:594/:608` | | **no change** — already says "XLSX/CSV/TSV", now true | 0 |
| `previousBuiltInSystemSkillDefaults` `user-skills.ts:915` | | **MUST NOT CHANGE** — migration baseline for every user's stored copy | 0 |
| `scripts/skill-eval-fixtures.ts:138-140` | | **MUST NOT CHANGE** — byte-mirror of the baseline | 0 |
| `getSupportedExtractionSummary` | `file-types/model-facing.ts` | **no change** — it is a runtime readiness error, not prompt prefix, and "works best for" is still true. Recorded as OQ5. | 0 |

Total ≈ **+330 to +400 chars ≈ +85 to +130 tokens** of new prose, against a measured 5 257-char /
≈1 315-token tool-description baseline (§1.5). The real cost is not the delta — it is the one-time
eviction of every cached prefix, which is precisely why it is paid once.

**Derived or hand-written?** Hand-written, every one, verified against the registry by
`format-prose.test.ts`. Phase 1's reasoning holds and gets stronger with each added format: a derived
string changes whenever the table changes, so every future registry edit would silently evict the
prefix. The one thing that becomes derived is the *assertion*: `format-prose.test.ts` already extracts
`advertisedChartTypes` from the prose and `supportedChartTypes` from `source-schema.ts` and compares
them — after this change the comparison is exact equality.

**Test updates in the same commit (deliberate re-freezing):**

- `format-prose.test.ts`: re-freeze `FROZEN_EN_PRODUCE_FILE`, `FROZEN_HU_PRODUCE_FILE`,
  `FROZEN_EN_READ_GENERATED_FILE`, `FROZEN_HU_READ_GENERATED_FILE`.
- Delete `KNOWN_PROSE_EXCEPTIONS.chartTypesMissingFromToolProse` and the test
  `"still hides area and stackedBar from the model"` (`:322-333`); the remaining test
  `"offers only chart types documentSource accepts"` becomes bidirectional.
- `KNOWN_PROSE_EXCEPTIONS.nonRequestableSkillFormats` shrinks `new Set(["tsv","xls"])` →
  `new Set(["xls"])`; `"names exactly two formats produce_file cannot produce"` becomes "exactly one";
  the `entryById("tsv")?.intake.route === "reject"` assertions become `"direct-text"` and
  `production.requestable === true`.
- `FORMAT_TOKEN` / `TOKEN_TO_ENTRY_ID` already know `TSV`/`tsv`; no change.
- `model-facing.test.ts`: unchanged (nothing in `model-facing.ts` moves).

**Before/after verification, in this order:**

1. `PATH=/opt/homebrew/opt/node@22/bin:$PATH npx vitest run src/lib/shared/file-types scripts/deploy.test.ts`
   — green on the P6-D branch, red on any earlier slice (expected, §8).
2. Record the serialized tool-definition byte length before and after, for the report:
   `node -e` over `normal-chat-tools/index.ts`'s `TOOL_I18N`, per locale.
3. `npx tsx scripts/verify-live-file-production-types.ts` with the §5 rows — every row `ok: true`.
4. `npx tsx scripts/verify-live-extraction-types.ts` (Phase 2/4) with the §5 upload matrix.
5. On the box, read the vLLM prefix-cache counters before and after the deploy and record the
   one-time miss spike in the slice report. A second spike on a later deploy means a string moved
   again and something is generating prose that should be hand-written.

---

## 5. Live verification additions (dev box)

### 5.1 Upload matrix — `scripts/verify-live-extraction-types.ts` (Phase 2/4's script, extended by P5-B)

Add six cases to the nine the Phase 2/4 spec defines. Fixtures live in
`fixtures/mineru-v1/<id>/sample.<ext>`; `epub` already exists, the other five must be authored (small,
NATO-word salted, same style as the existing ones) and committed by P5-B.

| id | file | expect |
| --- | --- | --- |
| `epub` | existing fixture | `effectiveTier: "flash"`, `pageCountKind: "spine"`, `pageCount: 1`, `mustContain` the NATO words, `outlineMin: 1` |
| `rtf` | new | `effectiveTier: "flash"`, `pageCountKind: "logical"` or `"declared"` (record which — **unverified**), text round-trips |
| `odt` | new | `effectiveTier: "flash"`, `pageCountKind: "declared"`, headings present |
| `ods` | new | `effectiveTier: "flash"`, `pageCountKind: "sheet"`, one `##` per sheet, **formula cells empty** (mirror the xlsx finding) |
| `odp` | new | `effectiveTier: "flash"`, `pageCountKind: "slide"` |
| `html` | existing fixture | **new assertions**: `mustNotContain` `["SPONSORED PLACEHOLDER","JULIET Document Footer","site-nav","window.__tracking"]`; record `textLength` and compare against the 1 753-char input so the token saving is measured on the live box, not only in the fixture |
| `tsv` | new | route is `direct-text`, so it must reach `succeeded` **without** a `parsing` phase — assert `statusesSeen` contains no `parsing` |
| `ofd` | new | upload refused **415** at intent with `details.reason === "formatNotEnabled"` (a negative case; the script needs a `expectRefusal` variant) |

Plus one gate case: with `MINERU_API_URL` pointed at a stub answering `/v1/health` with
`{"version":"3.9.0"}`, `GET /api/knowledge/upload/intent` for `x.epub` must answer 415
`formatNotEnabled`, and the SSR shell's accept string must not contain `.epub`.

### 5.2 Production matrix — `scripts/verify-live-file-production-types.ts` (P6-C owns)

The `cases` array (14 rows today) gains four, and the harness gains an `inline` source mode:

```ts
type FileTypeCase = {
	label: string;
	sourceMode: "document_source" | "program" | "inline";   // "inline" is new
	requestedType: string;
	body: (conversationId: string) => Record<string, unknown>;
};
```

| new label | sourceMode | requestedType | body | asserts |
| --- | --- | --- | --- | --- |
| `inline-markdown` | inline | `markdown` | `{ requestTitle, filename: "live-type.md", markdown: "# Live inline markdown\n\n- one\n- two\n" }` | file is `.md`, `text/markdown`, and its **bytes equal the submitted string** (CRLF-normalised) — this is the D8 no-reformatting assertion |
| `inline-tsv` | inline | `tsv` | `{ requestTitle, filename: "live-type.tsv", content: "a\tb\n1\t2\n" }` | `.tsv`, `text/tab-separated-values`, byte-equal |
| `program-tsv` | program | `tsv` | python writing `/output/live-type.tsv` | `.tsv`, non-zero, passes text validation |
| `document-markdown` | document_source | `markdown` | the shared `documentSource` fixture | `.md`, `text/markdown` — **this path has never been covered by the sweep**, and it is the one D9 now also feeds the readback |

`verifyDownload` needs one addition: an optional `expectedBytes` so the two `inline-*` rows can assert
byte equality rather than only "non-zero". Record per row, in `summary.json`, whether the job used a
sandbox container (`job.sourceMode`) so the D8 saving is visible: `inline-markdown` and `inline-tsv`
must report `inline_text`, never `program`.

A readback assertion belongs here too, because nothing else covers it end to end: after
`document-pdf` succeeds, `read_generated_file` on the produced filename must return text that contains
the fixture's heading, and the `document_extraction_jobs` table must hold **no** row for that chat file
(D9 — the source-first skip). Reach it through
`GET /api/knowledge/extraction?artifactIds=…` returning an empty list, not by touching the DB.

---

## 6. Work slices

Seven slices. **P5-A runs alone first** and merges to `mineru4/p56`; the rest branch from it.
Branches: `mineru4/p56-p5a` … `mineru4/p56-p6d`. First command of every slice:
`git checkout -b <branch> mineru4/p56` (or `mineru4/p24` for P5-A, which starts the chain). A fresh
worktree has no gitignored `data/`: `mkdir -p data` before `npx vite build`.

### Hot-file ownership — exactly one owner across BOTH phases

| file | owner |
| --- | --- |
| `src/lib/shared/file-types/table.ts`, `types.ts`, `index.ts`, `production.ts` | **P5-A** |
| `src/lib/shared/file-types/registry.test.ts`, `legacy-equivalence.test.ts` | **P5-A** |
| `src/lib/shared/file-types/no-ad-hoc-maps.test.ts` | **P6-B** (budget re-measure) |
| `src/lib/shared/file-types/model-facing.ts`, `format-prose.test.ts`, `model-facing.test.ts` | **P6-D** |
| `src/lib/components/chat/MessageInput.svelte` | **P5-C** |
| `src/routes/(app)/knowledge/_components/DocumentsList.svelte` | **P5-C** |
| `src/lib/i18n/knowledge.ts`, `src/lib/i18n/chat.ts`, `src/lib/i18n.test-helpers.ts` | **P5-C** |
| `src/lib/server/services/normal-chat-tools/index.ts` | **P6-D** |
| `src/lib/server/prompts.ts` | **P6-D** |
| `src/lib/server/services/skills/user-skills.ts`, `scripts/skill-eval-fixtures.ts` | **P6-D** (no-op guard: it must verify nothing needs changing) |
| `src/lib/server/sandbox/python-version.ts`, `scripts/sandbox-python-version.sh` | **nobody** — no package changes (D7). If the reviewer overrules D7, the owner is P6-C. |
| `src/routes/api/knowledge/upload/**` | **P5-B** |
| `src/lib/server/services/extraction/extractors/direct-text.ts` | **P5-B** |
| `src/lib/server/services/chat-files.ts` | **P6-A** |
| `src/lib/server/services/file-production/execution-adapter.ts`, `intake.ts`, `types.ts` | **P6-B** |
| `src/lib/server/services/normal-chat-tools/produce-file.ts` | **P6-B** |
| `src/lib/server/services/file-production/source-persistence.ts`, `source-schema.ts` | **P6-A** |
| `scripts/verify-live-file-production-types.ts` | **P6-C** |
| `scripts/verify-live-extraction-types.ts`, `fixtures/mineru-v1/**` | **P5-B** |
| `docs/uploads.md`, `docs/configuration.md`, `deploy/README.md` | **P5-B** |
| `src/lib/server/services/app-shell.ts` | **P5-B** |

---

### P5-A — Registry: every table edit of both phases  `[P24-free]` · **blocking**

**Goal.** One commit that contains every `src/lib/shared/file-types/**` change of Phases 5 and 6, so
`table.ts` is touched exactly once.

**OWNS:** `src/lib/shared/file-types/{types,table,index,production}.ts`, `registry.test.ts`,
`legacy-equivalence.test.ts`.

**READ-ONLY:** everything else. In particular `model-facing.ts` and `format-prose.test.ts` (P6-D).

**Depends on:** nothing. May be written before Phases 2/4 merge — it is pure data plus pure accessors,
and `requiresMineru4` has no runtime consumer until P5-B.

**Does:** §2.2 changes, §2.3 new entries, §2.4 production fields, §2.5 accept order,
`getMineru4GatedFileTypeIds`, `buildAcceptAttribute`, §2.6 test updates.

**Tests:** `src/lib/shared/file-types/registry.test.ts`,
`src/lib/shared/file-types/legacy-equivalence.test.ts`.

**DoD:** `npx vitest run src/lib/shared/file-types/registry.test.ts
src/lib/shared/file-types/legacy-equivalence.test.ts src/lib/shared/file-types/no-ad-hoc-maps.test.ts`
green. `format-prose.test.ts` is **red on the `tsv` assertions only** — enumerate exactly which
assertions fail in the slice report; any other red is a bug. `npx tsc --noEmit` clean.

---

### P5-B — Upload path: the gate, decoding, fixtures, docs  `[needs-P24]`

**Goal.** The server honours the new table, refuses gated formats when the backend is pre-4.x, and
decodes text properly.

**OWNS:** `src/lib/server/services/knowledge/format-availability.ts` (new),
`src/lib/server/services/extraction/text-decode.ts` (new) + `text-decode.test.ts`,
`src/lib/server/services/extraction/extractors/direct-text.ts`,
`src/routes/api/knowledge/upload/intent/+server.ts`, `src/routes/api/knowledge/upload/shared.ts`,
`src/lib/server/services/app-shell.ts`, `scripts/verify-live-extraction-types.ts`,
`fixtures/mineru-v1/{rtf,odt,ods,odp,tsv,ofd}/**`, `docs/uploads.md`, `docs/configuration.md`,
`deploy/README.md`.

**READ-ONLY:** `src/lib/shared/file-types/**`, `services/mineru/**`, `services/extraction/**` (rest).

**Depends on:** P5-A **and** `mineru4/p24` (`getMineruCapabilities`).

**Tests:** `src/lib/server/services/extraction/text-decode.test.ts` (BOM ×5, NUL, U+FFFD ratio,
CRLF, empty); `src/lib/server/services/extraction/extractors/direct-text.test.ts` (UTF-16 upload
succeeds, renamed-JPEG fails `unsupported_type`); `src/routes/api/knowledge/upload/intent/upload-intent.test.ts`
(415 for `.ofd`; 200 for `.epub` with the gate open; 415 `formatNotEnabled` for `.epub` with a stubbed
3.x health; 413 order preserved — the oversized-no-filename case still answers 413);
`src/lib/server/services/knowledge/format-availability.test.ts` (fails open on probe error, closes
only on a positive pre-4 answer, one in-flight probe per burst).

**DoD:** every new fixture parses on the dev box through §5.1; `docs/uploads.md` contains no
`/file_parse`, no `document-extraction.ts` reference and no host-converter instructions; the
grep evidence for the deletion is pasted into the slice report.

---

### P5-C — Composer paste, accept surfaces, i18n  `[P24-free]`

**Goal.** Paste-to-attach; both surfaces read the gated accept string.

**OWNS:** `src/lib/utils/clipboard-attachments.ts` (new) + test,
`src/lib/components/chat/MessageInput.svelte`,
`src/routes/(app)/knowledge/_components/DocumentsList.svelte`,
`src/lib/components/chat/AttachmentPickerSheet.svelte`,
`src/lib/stores/upload-format-gate.ts` (new), `src/lib/i18n/chat.ts`, `src/lib/i18n/knowledge.ts`,
`src/lib/i18n.test-helpers.ts`.

**READ-ONLY:** `src/lib/shared/file-types/**`, `app-shell.ts` (P5-B seeds the payload; P5-C only reads
`data.disabledFileTypeIds`, whose shape is frozen here: `readonly string[]`, absent ⇒ `[]`).

**Depends on:** P5-A. Independent of Phase 2/4 — the store shape is frozen by this spec, so it can be
written against an empty gate.

**Tests:** `src/lib/utils/clipboard-attachments.test.ts` (screenshot attaches; Word paste with
`text/plain` + an image does **not**; Finder file copy attaches; unnamed image gets
`pasted-…`; an `.mp4` on the clipboard yields `refused` with `knowledge.uploadRejectedMedia`);
`src/lib/components/chat/MessageInput.test.ts` (native text paste still inserts text and does not call
`uploadFiles`; a files-only paste calls it once with the right names; quote chips are untouched by a
paste); `src/lib/i18n.test.ts` (no new keys — assert the count is unchanged, which is the point).

**DoD:** no new i18n key exists; `getAcceptAttribute` is no longer called directly by either surface;
paste works on a phone viewport (`isPhone` path) in the component test.

---

### P6-A — Readback: one markdown renderer, the flash hint  `[needs-P24]`

**Goal.** Source-first documents stop having a second text renderer; program binaries parse at `flash`.

**OWNS:** `src/lib/server/services/chat-files.ts` (+ `chat-files.test.ts`),
`src/lib/server/services/file-production/source-persistence.ts`,
`src/lib/server/services/file-production/source-schema.ts` (deletion of
`buildGeneratedDocumentProjection` only), and the `decideTier` rule-1½ hunk wherever Phase 2 landed it.

**READ-ONLY:** `extraction/**`, `file-production/**` (rest), `renderers/**`.

**Depends on:** P5-A (for `tsv` being `direct-text` on the readback side) and `mineru4/p24`.

**Tests:** `chat-files.test.ts` (a `document_source` PDF enqueues **no** extraction job; a program XLSX
enqueues one with `hints.preferredTier === "flash"`; a generated `.tsv` is decoded inline and enqueues
nothing; a generated `.md` with a UTF-8 BOM round-trips);
`file-production/source-persistence.test.ts` (artifact text equals
`renderStandardReportMarkdown(source)` bytes; a renderer throw falls back to enqueueing readback);
the `decideTier` test file (preferredTier available ⇒ used; unavailable ⇒ falls through, does **not**
throw; `hints.tier` unavailable still throws).

**DoD:** `git grep buildGeneratedDocumentProjection` returns nothing.

---

### P6-B — `inline_text` production mode  `[P24-free]`

**Goal.** A text output stops spawning a Docker container, verbatim.

**OWNS:** `src/lib/server/services/file-production/{types,intake,execution-adapter}.ts`,
`src/lib/server/services/normal-chat-tools/produce-file.ts`,
`src/lib/shared/file-types/no-ad-hoc-maps.test.ts` (budget re-measure only).

**READ-ONLY:** `storage-adapter.ts`, `output-validation.ts`, `limits.ts`, `renderers/**`.

**Depends on:** P5-A.

**Tests:** `produce-file.test.ts` (the five qualifying conditions, each negated once; an explicit
`sourceMode: "program"` markdown request still takes program mode; a mixed `[pdf, md]` request is
refused, not silently mis-produced); `execution-adapter.test.ts` (inline_text writes byte-identical
content; a NUL in the content fails `invalid_text_output`; `sandboxTimeoutMs` is never consulted);
`file-production/intake.test.ts` (`inline_text` respects `maxOutputFileBytes`).

**DoD:** a `{ markdown: "..." }` call produces a file with **zero** `docker` calls — assert it by
spying on the sandbox module in the adapter test. `no-ad-hoc-maps.test.ts`'s `produce-file.ts` budget
is re-measured and lowered (or its row deleted).

---

### P6-C — Live production matrix  `[P24-free]` · runs after P6-A and P6-B

**OWNS:** `scripts/verify-live-file-production-types.ts`.

**Depends on:** P6-A, P6-B merged into `mineru4/p56`.

**Does:** §5.2 — the `inline` source mode, four new rows, `expectedBytes`, the `sourceMode` column in
`summary.json`, the source-first no-readback assertion.

**Tests:** none in vitest (the script has no `.test.ts` beside it, by its own convention). Evidence is
a committed `summary.json` from a real run against the dev box, with `ok: true` on all 18 rows.

**DoD:** `LIVE_AI_BASE_URL=… npx tsx scripts/verify-live-file-production-types.ts` exits 0; the
`inline-markdown` row reports `sourceMode: "inline_text"`.

---

### P6-D — The single prose release  `[needs-P24 + Phase 4]` · **last**

**Goal.** One commit, one prefix-cache eviction.

**OWNS:** `src/lib/server/services/normal-chat-tools/index.ts`,
`src/lib/server/services/normal-chat-tools/read-generated-file.ts` (the `page` `.describe()` only),
`src/lib/server/prompts.ts`, `src/lib/server/services/skills/user-skills.ts`,
`scripts/skill-eval-fixtures.ts`, `src/lib/shared/file-types/model-facing.ts`,
`src/lib/shared/file-types/format-prose.test.ts`, `src/lib/shared/file-types/model-facing.test.ts`.

**Depends on:** `mineru4/p24` (Phase 4 must have added the `page` parameter — the sentence documents a
feature that must exist), P5-A (the `tsv` assertions), P6-A/B/C (so the release is the last thing that
moves).

**Does:** §4.5, every row.

**Tests:** `format-prose.test.ts`, `model-facing.test.ts`, `scripts/deploy.test.ts` (the
package-name-in-prose assertion must still pass — it will, since no package changes),
`src/lib/server/services/skills/user-skills.test.ts`.

**DoD:** all of `npx vitest run src/lib/shared/file-types scripts/deploy.test.ts
src/lib/server/services/skills` green; the before/after serialized-tool-definition byte counts are in
the slice report; §4.5's five-step verification is complete, including the prefix-cache counter
reading.

---

### Which slices can run before Phases 2+4 merge

| slice | before P24? | why |
| --- | --- | --- |
| P5-A | **yes** | pure data + pure accessors; `requiresMineru4` has no consumer yet |
| P5-B | **no** | `getMineruCapabilities` / `/v1/health` do not exist before Phase 2 |
| P5-C | **yes** | the gate store shape is frozen here; an empty gate is a valid state |
| P6-A | **no** | `decideTier` and the `preferredTier` hint are Phase 2 surface |
| P6-B | **yes** | touches no extraction code at all |
| P6-C | **yes** to write, **no** to run green (its readback assertion needs P6-A) |
| P6-D | **no** | documents Phase 4's `page` parameter |

---

## 7. Storage paths and orphan cleanup (D12)

**Finding.** Two conventions, in one function:
`extraction/worker-runner.ts:136` resolves an artifact as `join(process.cwd(), row.storagePath)` (the
column already contains `data/knowledge/…`), while `:158-164` resolves a chat file as
`join(process.cwd(), "data", "chat-files", row.storagePath)` (the column contains
`{conversationId}/{fileId}.{ext}`). `chat-files.ts:363-365,383-432` is the source of the second.
`disk-reconciliation.ts` copes by normalising the two differently
(`normalizeKnowledgeDbPath:40-49` trims at the `/knowledge/` marker; chat paths are used verbatim),
and it **reports only** — there is no `unlink`, `rm` or `rmdir` in the file.

**Recommendation: DEFER.** Migration cost, if done:

1. a reversible SQL migration rewriting every `chat_generated_files.storage_path`;
2. matching edits in `chat-files.ts`, `file-production/storage-adapter.ts`, `conversation-forks.ts`,
   `account-lifecycle/**`, `generated-file-serving.ts`, `disk-reconciliation.ts`;
3. a backfill that must be idempotent because a half-migrated table makes every generated file
   un-downloadable;
4. re-verification of `conversation-forks.test.ts`'s `UNIQUE(chat_generated_file_id)` behaviour
   (Phase 3 OQ9 already flagged that area).

The payoff is cosmetic: reconciliation already handles both shapes and correctly reports nothing
spurious once Phase 4's `.parse`/`.incoming` exclusions land. Deleting orphans is a separate, larger
decision (an "orphan" is also what a half-finished upload looks like) and is explicitly **not** in this
phase. Ticket it alongside the archive route.

**Do not duplicate Phase 4's work.** The `IGNORED_KNOWLEDGE_DIR_SUFFIXES = [".parse", ".parse.tmp"]`
change to `disk-reconciliation.walkDir` is specified in `phase2-4-mineru-client-spec.md` §4.2 and is
owned by a Phase 4 slice. No slice here touches that file.

---

## 8. Non-goals, risks, open questions

### 8.1 Non-goals

- Building the `archive` route (§3.4). Reserved and described only.
- Adding any Python or JS package to the sandbox (§1.3).
- Raster output (`png`/`jpg`) in any form.
- Deleting orphan files; unifying storage paths (§7).
- Backfilling existing library documents (Phase 4 §4.11 already rules: no backfill).
- Touching `file-serving-response-policy.ts` — it is PERMANENT-allowlisted and no new output type
  reaches its HTML/SVG arms.
- Re-litigating `zip` (D11) or the `.env` extension parse (Phase 1 §10).
- A direct-text fallback for HTML when MinerU is down (§3.2.6, OQ2).

### 8.2 Risks

| risk | why it matters | mitigation |
| --- | --- | --- |
| **HTML regresses while MinerU is down** | it is the one format that could never fail before | the ledger's retry + "still processing" chip + send gate already exist; OQ2 asks for a ruling |
| **MinerU mis-parses RTF/ODS/ODP** | zero spike evidence; the gate only checks the version, not per-format capability | §5.1 adds a live case per format and P5-B must commit the `summary.json`; a format that fails there is dropped from D1 before merge, which is a one-line table edit |
| **The gate fails open and a 3.x operator sees five broken formats** | deliberate (§3.5) | the failure is a ledger job with a Retry button, the same as any other backend outage; the MinerU status card shows the version |
| **Knowledge accept widens to 74 extensions** | a visible product change, including 34 code extensions | it was Phase 1's own recommendation (OQ2/OQ3) and the server already accepts every one of them; `registry.test.ts` forces the array edit to be explicit |
| **`inline_text` skips a validation the sandbox path performed** | a produced file could bypass a check | it calls the same `validateGeneratedOutputFile`; the adapter test asserts a NUL is still rejected |
| **Markdown round-trip** | `documentSource` would reformat the user's markdown | D8 avoids the round trip entirely; `inline-markdown` asserts byte equality on the live box |
| **`preferredTier` conflated with `tier`** | a readback would fail permanently instead of degrading | distinct key, distinct rule, a test for each direction |
| **P6-D lands before Phase 4** | the prose would document a `page` parameter that does not exist | P6-D's DoD requires the parameter to be in the schema; `format-prose.test.ts`'s frozen string cannot pass otherwise |
| **Parallel red test** | P5-A knowingly leaves `format-prose.test.ts` red | listed above, bounded to the `tsv` assertions, fixed by P6-D. Any reviewer seeing a *different* failure should treat it as a bug |
| **Prefix-cache eviction paid twice** | a second slice touching a prompt string | only P6-D owns any prompt string; the ownership table is the enforcement, and §4.5 step 5 measures it |

### 8.3 Open questions — each with a recommended answer

| # | question | recommendation |
| --- | --- | --- |
| OQ1 | `tsv` as `direct-text` or MinerU? | **`direct-text`.** The CSV fixture shows MinerU inflates delimited text by 66.3 %, and `run_python`/exceljs need the raw delimiters. Same argument as CSV, which nobody proposes moving. |
| OQ2 | Keep a direct-text fallback for HTML when MinerU is unreachable? | **No.** Two paths for one type is the drift this migration exists to end, and the fallback would fire exactly when the output would be worst (raw HTML with scripts and nav into the prompt). Accept the outage behaviour every other format already has. |
| OQ3 | Enable `ofd`? | **No.** Zero evidence anywhere in the tree. The entry exists for the better refusal message and to keep `formatNotEnabled` in use. One-line flip when someone probes it. |
| OQ4 | Knowledge accept == chat accept, including 34 code extensions? | **Yes.** Phase 1 OQ2/OQ3 recommended exactly this for exactly this release. The server gate is already surface-independent, so the narrow list only hides what the server accepts anyway. |
| OQ5 | Widen `getSupportedExtractionSummary` to name the new formats? | **No.** It says "works best for", it is a runtime error string rather than prompt prefix, and lengthening it helps nobody. Revisit if support tickets say otherwise. |
| OQ6 | `inline_text` (D8) vs routing markdown through `documentSource`? | **`inline_text`.** The brief asks for "the Markdown renderer instead of a Docker container"; `documentSource` would satisfy the letter and break the content, because `buildDocumentSourceFromText` → render is not identity. The Markdown renderer keeps its job for real `documentSource` jobs. **This is the one place this spec departs from the brief — rule on it before P6-B starts.** |
| OQ7 | Should `rtf` be requestable as an output? | **No** (D7). DOCX is strictly better and already there. Flag for reversal only if a user asks for a Word-openable file for a machine without Word. |
| OQ8 | Gate on server version or on `/v1/tiers`? | **Version.** Every recorded `/v1/tiers` contains `flash`, so a tier-based guard defends a case that has never been observed; `decideTier` rule 5 already handles flash-only servers. |
| OQ9 | Gate fails open or closed? | **Open.** A never-answered probe must not shrink the picker; only a positive pre-4 answer closes it. |
| OQ10 | Unify storage paths now? | **Defer** (§7). Cosmetic payoff, a data migration, and it touches six modules plus the fork logic Phase 3 OQ9 already flagged. |
| OQ11 | Do `doc`/`xls`/`ppt` get `tierHint: "flash"` with no fixture? | **Yes**, on the §2.7-rule-2 argument (omitting the tier is a 503 on a flash-only server, and Office resolves to flash file-level anyway), **conditional on** §5.1's live matrix. If the live run shows a legacy format failing at flash, drop the hint for that format — a one-line edit. |
| OQ12 | Should the mixed-outputs refusal (§4.2 bonus fix) ship in P6-B or wait for D13? | **P6-B.** It is an error message, not a tool description; `format-prose.test.ts` does not freeze it, so it costs no prefix eviction. |

---

## Orchestrator rulings (2026-09-20) — these override anything above that conflicts

- **Order.** Phases 5 and 6 are built after Phases 2 and 4 are merged. Integration branch `mineru4/p56`, slices `mineru4/p56-p5a`, `-p5b`, `-p5c`, `-p6a`, `-p6b`, `-p6c`, `-p6d`. P5-A runs alone first; P6-D (the single prose release) runs last. File-ownership lists must be re-checked against the merged Phase 2 and 4 code before development starts.
- **Open questions.** Every recommended answer is adopted: OQ1 (`tsv` is direct-text), OQ3 (`ofd` recognised, not enabled), OQ4 (Knowledge and chat accept sets become identical), OQ5, OQ6 (`inline_text` production mode; plain markdown is never routed through `documentSource`), OQ7, OQ8 (gate on the server version from `/v1/health`), OQ9 (gate fails open), OQ10 (storage-path unification deferred), OQ11, OQ12.
- **OQ2, amended.** HTML moves to MinerU `flash`, and there is no second path while MinerU 4 is the backend: an unavailable server is handled by the ledger's retry. But HTML uploads work today, so they must never become refusals: `html` / `htm` carry `requiresMineru4`, and when the gate positively detects a pre-4 backend they fall back to the `direct-text` route instead of being refused. Only formats that never worked before (`rtf`, `odt`, `ods`, `odp`, `epub`) are hidden or refused on a pre-4 backend.
- **Outputs.** `tsv` is the only new requestable output. `png` / `jpg` stay out until there is a reason to pay for the sandbox packages and the prose change.
- **Worktrees, toolchain, commits.** First command of every slice: `git checkout -b <slice-branch> <integration-branch>`. Homebrew `node@22`. `mkdir -p data` before `vite build`. Stage by explicit path; never `git add -A`. Do not use `git stash` (shared between worktrees).
