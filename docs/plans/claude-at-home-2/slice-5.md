# Slice 5 — Alfy's side: three tools, the guidance that rides on them, and the eval harness

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking. Read `plan.md` first. **This slice can start once Slice 0 has landed** (the artifacts boundary),
> but it **finishes after Slice 1, 2, 3 and 4**, because three of its five eval suites are written against
> their contracts. Tasks T1–T3 (the tools) touch only Slice 0; T4–T6 (evidence, bundle, Info rows) need the
> read models those slices produce; T7–T8 (the harness) is the gate for all four.

**Goal:** Make Alfy *use* artifacts well: choose the right type, offer one only when it is wanted, create and
edit through three tools whose usage rules live on the tools themselves, show an artifact's sources and its
own existence in the chat's evidence surfaces, list an artifact in its project's bundle, and — the
deliverable that makes any of that trustworthy — score the model's artifact behaviour automatically in
`scripts/eval-artifact-contracts/` so each type's slice is gated on measured contract quality rather than on
a prototype's word.

**Architecture:** Three new tools register in `normal-chat-tools/index.ts` beside the existing eighteen, each
wrapped in the existing `executeToolWithEnvelope`, each adding one `TOOL_TIMEOUTS_MS` row, and each carrying
its own EN and HU description in `TOOL_I18N` — because per [ADR-0055](../../adr/0055-tool-usage-guidance-lives-in-the-tool-interface.md)
a tool's usage rules live on the tool's description and **there is no guidance-pack selector to add to**. The
type-choice rules therefore ride on those three descriptions plus one unconditional static block in
`prompts.ts`; `normal-chat-context.ts` gains only the *catalogue* of artifacts in this conversation, inside
`buildTurnGuidance`, which is appended after the user message and is not part of the cached system prompt.
The eval harness is a standalone `scripts/eval-artifact-contracts/` following
`scripts/prototype-artifact-apps/`'s proven shape, with one addition that makes it affordable as a gate:
recorded model responses are replayed and re-scored without a model call.

**Tech Stack:** the existing AI SDK tool layer (`normal-chat-tools/`), the existing evidence layer
(`message-evidence.ts`, `MessageEvidenceDetails.svelte`, `ResponseAuditDetails.svelte`), the existing project
bundle (`knowledge/project-knowledge.ts`, `ProjectFilesDialog.svelte`), `node --experimental-strip-types`
for the harness. No new runtime dependency.

**Spec:** `docs/plans/claude-at-home-2-artifacts-spec.md` §2 (decisions 1, 2, 5, 9, 10, 11), §4 (tools and the
required eval), §5 (card, panel), §6 (Slice 5), §7 (testing), §8 (risk 1, risk 6).
ADRs: [ADR-0055](../../adr/0055-tool-usage-guidance-lives-in-the-tool-interface.md) (guidance in the tool
interface), [ADR-0066](../../adr/0066-artifacts-are-a-family-of-five-types.md) (the family, and the eval
harness as a gate), [ADR-0065](../../adr/0065-living-documents-are-edited-in-place.md) (editing in place).
Mockups: `claude-at-home-2-artifacts-mockups.html` §1 (the `info` affordance in the card's action row),
`claude-at-home-2-artifact-surfaces-mockups.html` §5 (the project bundle).
Harness pattern: `scripts/prototype-artifact-apps/README.md` (env switches, sampling, the API key rule) and
`scripts/prototype-artifact-apps/score.ts` (the verdict rules).

## Global Constraints

Same as `plan.md` §Global Constraints. In addition, for this slice:

- **Svelte 5 runes only** in the touched components. `ResponseAuditDetails.svelte` and
  `MessageEvidenceDetails.svelte` are large migrated files: append, do not reorganise, and do not reintroduce
  `on:` directives or `<slot>` in anything you touch.
- **Lucide icons only**; **tokens only**; **EN + HU in the same commit** for every new string, including
  tool descriptions (tools carry both, in `TOOL_I18N`).
- **"Artifact" never appears in the UI.** The word is an engineering term (ADR-0066). Tool *descriptions* are
  model-facing rather than UI, and even there the type names are Document, App, Canvas, Slides, File.
- **No guidance pack, and no per-turn prompt splice.** ADR-0055 deleted the selector outright, and
  `buildOutboundSystemPrompt`'s output must stay **byte-identical for a fixed conversation** regardless of
  the latest message's wording, length or language — asserted by an existing regression test in
  `normal-chat-context.test.ts`. Anything message-conditioned you add there fails that test, which is the
  test doing its job.
- **The tool catalogue must not vary by turn.** `shouldExposeFileProductionTools()` returns a hard `true` and
  documents why: the tool set sits inside the cached prompt prefix, so a per-turn decision about *which* tools
  exist changes the prefix and costs the cache. New tools are registered unconditionally; the only allowed
  deletion is in `selectNormalChatToolsForRequest`, and only for a condition that is stable for a
  conversation's whole life (memory off, skills off, incognito).
- **No new `EvidenceSourceType` without saying so.** If this slice widens that union, it says so in the PR
  body and covers it in the containment suite; see Task T4 for the one place it is proposed.
- **The harness API key rule is absolute** (inherited from the App prototype): the key is read from
  `~/.config/opencode/opencode.json`, and is **never printed, never logged, never written into `out/`, and
  never committed**. `out/` is gitignored. A test asserts no file under `out/` contains the key's shape.
- **Everything the harness writes is under `scripts/eval-artifact-contracts/out/`** (gitignored) except the
  prompts, rubric and fixtures, which are committed and reviewed.
- **`npm run check` stays at 0 errors, 0 warnings; `npm run build` emits 0 warnings.**
- **Cost discipline.** `MAX_SAME_TURN_PRODUCE_FILE_SUBMISSIONS = 2` and
  `MAX_PRODUCE_FILE_SUBMISSIONS_PER_TURN = 6` stay as they are; the harness runs sequentially, one retry
  maximum, and stops after two consecutive 429/5xx, exactly as the App prototype does.

## Gates

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run check && npx biome check src scripts tests && npm test && npm run build
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json
npx playwright test tests/e2e/artifacts-panel.spec.ts tests/e2e/artifact-document.spec.ts \
  tests/e2e/chat.spec.ts tests/e2e/projects.spec.ts

# The contract gate. --replay re-scores committed responses with no model call (CI):
node --experimental-strip-types scripts/eval-artifact-contracts/run.ts --replay --suite all
# A real model run, sequential, when the contract itself changed:
node --experimental-strip-types scripts/eval-artifact-contracts/run.ts --suite all --model "$EVAL_MODEL"
```

## Review Focus

1. **Nothing about artifacts is spliced into the prompt per turn (Task T1).** The single hard constraint
   inherited from ADR-0055. If `buildOutboundSystemPrompt`'s output changes when the message changes, the
   guidance was put in the wrong place. The regression test in `normal-chat-context.test.ts` is the proof,
   and this slice's task list runs it explicitly.
2. **The tools refuse rather than guess (Tasks T2, T3).** Every op that names a missing id, a stale hash, or
   an unknown layout is refused with a reason the model can act on — never repaired silently. This is §2.5
   and the Canvas §2.13 rule together, and it is what the user's own editing depends on.
3. **The harness is a gate, and it can fail (Task T7).** A suite that cannot fail is decoration. Each suite
   ships at least one fixture that **must** fail and is asserted to fail (a stale-hash patch that is not
   refused, an app with a wrong quiz key, a deck with an invented number), so the harness is measured against
   known-bad input before it is trusted against the model.
4. **The API key never reaches a file (Task T8).** One leak into `out/` or a committed fixture makes the key
   part of the repo's history. The switch that reads it is one function, and the test that greps `out/` runs
   on every harness invocation, not only on the committed tests.
5. **The bundle shows a project's artifacts without pretending they are files (Task T5).** A row's label
   distinguishes `project file` from an artifact made in a chat, and the type label is the UI's own word
   (Document/App/Canvas/Slides), not `artifact`.

---

## Contracts

### The three tools

Registered in `src/lib/server/services/normal-chat-tools/index.ts`, in the same
`asExecutableTool(tool({ description: i18n.<name>.description, inputSchema, execute }))` shape every existing
tool uses, each execute wrapped in `executeToolWithEnvelope`. Per-tool schemas and payload shaping live in
beside-modules (`artifact-tools/create.ts`, `edit.ts`, `read.ts`), as `memory-context.ts` and
`produce-file.ts` already do.

```ts
// src/lib/server/services/normal-chat-tools/artifact-tools/create.ts
export const createArtifactInputSchema = z.object({
	artifactType: z.enum(["document", "app", "canvas", "slides"]),
	title: z.string().min(1).max(200),
	/** Documents: Markdown with `<!--b:id-->` markers. Slides: the deck JSON.
	 *  Canvas: the board JSON, or empty for a new board. Apps: the HTML document. */
	body: z.string().min(1),
});
export const createArtifactModelInputSchema = z.object({
	artifactType: z.enum(["document", "app", "canvas", "slides"]).describe("document, app, canvas or slides"),
	title: z.string().min(1).describe("What the user will see in the card and the panel."),
	body: z.string().min(1).describe("Documents: Markdown. Slides: the deck JSON. Canvas: the board JSON or empty. Apps: the HTML."),
});
```

```ts
// src/lib/server/services/normal-chat-tools/artifact-tools/edit.ts
export const editArtifactInputSchema = z.object({
	artifactId: z.string().min(1),
	/** Documents and Slides: block-addressed patches carrying the hash the model last read. */
	patches: z.array(z.unknown()).min(1).max(40).optional(),
	/** Canvas: the id-addressed BoardDiff ops. */
	ops: z.array(z.unknown()).min(1).max(40).optional(),
	/** Why the change is being made; shown as the version's one-line summary. */
	summary: z.string().min(1).max(200).optional(),
});
export const editArtifactModelInputSchema = z.object({
	artifactId: z.string().min(1).describe("The id from create_artifact, read_artifact or the artifact catalogue."),
	patches: z.array(z.unknown()).min(1).optional().describe(
		"Documents and Slides only: [{op, target|slideId, baseHash, text}]. Read the artifact first; baseHash must be the hash you last read.",
	),
	ops: z.array(z.unknown()).min(1).max(40).optional().describe(
		"Canvas only: [{op:'add_node'|'move'|'add_edge'|'update_node'|'remove_node'|'highlight'|'add_frame', ...}].",
	),
	summary: z.string().min(1).max(200).optional().describe("One short line shown next to Keep/Undo."),
});
```

Patches and ops are `z.unknown()` **deliberately**: the per-type validator is the authority
(`validateDocumentPatches`, `validateSlidePatch`, `validateBoardDiff`), and it is the same code path the ops
route uses. A second, schema-shaped validator on the model-facing surface would be a second source of truth
about what applies — the reason every artifact op is refused is a *server decision* (§4), and it has to be
one implementation.

```ts
// src/lib/server/services/normal-chat-tools/artifact-tools/read.ts
export const readArtifactInputSchema = z.object({
	artifactId: z.string().min(1),
	/** `blocks` returns the addressable ids and hashes; `full` returns the whole body. */
	detail: z.enum(["blocks", "full"]).optional(),
});
```

Payload shapes, mirroring `read_generated_file`'s honesty about not finding things:

```ts
export type ReadArtifactModelPayload =
	| {
			success: true;
			artifactId: string;
			artifactType: "document" | "app" | "canvas" | "slides" | "file";
			title: string;
			/** Blocks: {id, kind, hash, preview}. Canvas: {id, kind, label, x, y, parentId}. Slides: {id, layout, fields:[{id, hash, preview}]}. */
			blocks?: Array<Record<string, unknown>>;
			body?: string;
			sources?: ArtifactSourceRef[];
	  }
	| { success: false; error: string; candidates?: Array<{ artifactId: string; title: string }> };

export type EditArtifactModelPayload =
	| { success: true; artifactId: string; versionId: string; applied: number; refused: ArtifactRefusal[] }
	| { success: false; error: string; refused?: ArtifactRefusal[] };

export type ArtifactRefusal = {
	target?: string;
	reason:
		| "unknown_id"
		| "unknown_slide"
		| "unknown_field"
		| "stale_base_hash"
		| "layout_dropped_field"
		| "kind_mismatch"
		| "missing_parent"
		| "invalid_data"
		| "scope"
		| "limit_exceeded";
};
```

`success: false` with `candidates` is the ambiguity path, copying `read_generated_file`: if the model asks for
an artifact id that is not in this conversation, the tool says so and lists what *is* there, rather than
letting the model invent an id and have a later call fail obscurely.

### `TOOL_TIMEOUTS_MS` rows

```ts
create_artifact: 30_000,   // a whole body may be written in the call; no sandbox, no network
edit_artifact: 20_000,     // a validation pass and one version row
read_artifact: 10_000,     // the same as read_generated_file: a read, not a computation
```

`TOOL_TIMEOUTS_MS` is a plain `Record<string, number>`; adding names needs no type change.

### The artifact catalogue (turn guidance)

`buildTurnGuidance` gains one block, appended only when the conversation has artifacts:

```ts
// src/lib/server/services/normal-chat-context.ts — inside buildTurnGuidance, after the skill catalogue.
export type ArtifactCatalogueEntry = {
	artifactId: string;
	artifactType: "document" | "app" | "canvas" | "slides" | "file";
	title: string;
	updatedAt: number;
};

export function buildArtifactCatalogueSection(entries: ArtifactCatalogueEntry[]): string;
```

Format, and its size bound (the whole reason it is bounded):

```
## Artifacts in this chat
- doc-8f21 · Document · "Vienna plan" (updated 2 h ago)
- cv-1c44 · Canvas · "Saturday board" (updated 12 min ago)

Use read_artifact to see one before editing it. Never invent an id.
```

Caps: at most `ARTIFACT_CATALOGUE_MAX = 12` entries, newest first, titles clipped to 60 characters, and the
whole section omitted when there are none. A 40-artifact conversation is a real possibility and an unbounded
list is a prompt that grows with use. Entries beyond the cap are not hidden from the model: the section ends
with `(and N more in this chat)` so the model knows to ask rather than assume the list is complete.

**Why this is allowed where a guidance pack is not.** It is not a decision about *which guidance to show*,
it is a factual list of what exists, it is identical for every message in the same conversation state, and
it lives in `buildTurnGuidance` — which `appendTurnGuidance` appends **after the current user message** and
which is therefore not part of `buildOutboundSystemPrompt`'s byte-identical system prompt. The *rules* for
choosing a type do not come here; they come from the tool descriptions (below), which is ADR-0055's rule.

### The type-choice guidance, in the one place it may live

`TOOL_I18N.<lang>.create_artifact.description` (EN and HU, hand-written at parity, both in the same commit)
must carry, in this order, the rules the model needs:

1. **When to make an artifact at all.** When the user will come back to the thing, edit it, or keep it —
   a checklist, a plan, an itinerary, a draft, a letter, a deck, a board. **Not** for an answer that is
   complete in the reply; not when the user asked for a downloadable file (that is `produce_file`).
2. **How to choose the type**, in one line per type:
   - **Document** — rich text that will be read and edited over time: plans, checklists, itineraries,
     letters, drafts, trackers.
   - **App** — an interactive tool: a calculator, a splitter, a quiz, something with inputs and results.
   - **Canvas** — a board: things to arrange in space, with frames, notes, arrows and blocks.
   - **Slides** — a deck to present: a small ordered set of slides with a beginning and an end.
   - **File** — anything the user asked to *download*: `produce_file` makes it, and it appears as a File.
3. **One artifact per request.** Do not also paste the same content into the reply; say what was made and
   offer to open it.
4. **Never invent an id.** Read before editing.
5. **One worked example** of each call, short.
6. **What to do on failure:** read the refusal reason, fix that op, retry at most once.

`edit_artifact`'s description carries the block-addressed contract: read first, `baseHash` is the hash you
last read, a refusal means the user changed it (tell the user, do not retry the same patch), and a batch
applies partially. `read_artifact`'s carries the two detail levels and what each returns.

`prompts.ts`'s static base prompt gains one short unconditional paragraph under the existing
`### Files And Artifacts` heading — **not** appended when a flag is set, because the flag would change the
prefix. It says that Alfy can keep something as a Document, App, Canvas or Slides item beside the chat and
that it should offer one when the user will return to the work. Two sentences, no list: the list is on the
tool, where the model reads it at the moment it has the schema in front of it.

**The existing flag must be noted, not used.** `buildOutboundSystemPrompt` declares and threads
`fileProductionToolsAvailable` but never reads it, and `shouldExposeFileProductionTools()` returns a hard
`true` with a comment saying the catalogue must not vary by turn. Do **not** wire artifact guidance to a
flag like that one; it is the exact shape ADR-0055 removed. Whether that dead field is deleted is a
one-line cleanup this slice may do, or leave; it is not a behaviour.

### Artifact evidence and an artifact's sources

**An artifact's sources** are the web/document sources the model actually used, which the tool-call entries
already carry: a `create_artifact` or `edit_artifact` entry with `candidates` in its persisted
`ToolCallEntry` is the record, and the recorder already persists those into `messages.toolCalls` as
`ThinkingSegment[]`. So no new table:

```ts
// src/lib/server/services/artifacts/read-model.ts
export type ArtifactSourceRef = {
	id: string;
	title: string;
	url?: string | null;
	sourceType: EvidenceSourceType;
	/** Which tool call brought it in. */
	callId?: string | null;
};

/**
 * The sources behind an artifact, read from the conversation's persisted
 * tool-call entries for calls that named this artifact. Document rows open
 * through the shared workspace; web rows open their URL. No new storage.
 */
export async function getArtifactSources(params: {
	userId: string;
	conversationId: string;
	artifactId: string;
}): Promise<ArtifactSourceRef[]>;
```

They render in the panel through the **existing** `MessageEvidenceDetails.svelte` row component: items with
an `artifactId` are already buttons into the shared workspace, and items with a `url` are already links with
a favicon. Do not build a second source list — the panel passes the same `MessageEvidenceItem` shape.

**The chat showing what it made.** One proposal, flagged because it widens a shared union: add
`"artifact"` to `EvidenceSourceType` and one row to `GROUP_ORDER`/`GROUP_LABELS` (EN "Made in this chat", HU
"Ebben a beszélgetésben készült"), so a turn that created a Document shows it as evidence of the turn, as a
card that opens the panel. The alternative — squeezing made artifacts into the `document` group, whose label
is "Retrieved Documents" — misdescribes them, and the group label is user-visible. The union is additive
(rows are JSON), and every consumer of it is a `Record`/`switch` that gains one branch. **If the owner would
rather not widen it, the fallback is the Info row in Task T6 alone, and this paragraph is the extent of the
change.** Task T4 covers both the containment suite and the i18n.

### The Info popover rows

`ResponseAuditDetails.svelte`'s `buildPrimaryRows()` already builds rows such as the "Project files" row
(`kind: "sources"`, label `projects.infoProjectFiles`, only when `message.projectFilesRead > 0`). This slice
adds two rows in the same shape:

| Row | Shown when | Label key | Value | Action |
|---|---|---|---|---|
| Made in this chat | the message's evidence includes `artifact` items | `artifacts.infoMade` | `{count}` (e.g. `2 items`) | `onOpenArtifacts` → the panel on its list |
| Sources | the message's evidence has a `web` or `document` group | `artifacts.infoSources` | `{count}` | `onOpenSources` → the existing `sourcesExpandRequest` path |

The row label is the group's own label, so the two surfaces cannot disagree. `showEvidencePending` is
untouched: an artifact row appears when the evidence is ready, not before.

### The project bundle

`ProjectKnowledgeItem` already carries `type: ArtifactType` and the bundle already renders rows with
`FileTypeIcon`, `formatFileType`, `formatSize` and `formatRelativeTime`. Additions:

- **`ArtifactType` gains `"artifact"`** in `knowledge/types.ts`, with the concrete type in
  `metadata_json.artifactType` (the spec's recommendation: prefer metadata over a second source of truth).
  `ProjectKnowledgeItem` gains `artifactType?: "document" | "app" | "canvas" | "slides" | "file"` and
  `sourceConversationTitle?: string | null`.
- **`listProjectKnowledge` includes artifacts** linked to the project, ordered by the existing `sortItems`.
  Linking is a link (the module's existing invariant): linking an artifact to a project copies nothing, and
  unlinking deletes nothing.
- **The row label** distinguishes provenance the way the mockup does: `from "Saturday plan" · today` when
  the artifact came from a chat, `project file` for an uploaded or generated file, and the type pill uses
  the UI's word (Document / App / Canvas / Slides) from `artifacts.type.*` — never `artifact`.
- **The row action opens the artifact panel**, not the document viewer: an artifact is edited in place, so
  opening it must land on the editor. `toWorkspaceDocument` stays for files.
- **`HomeSurface`'s bundle line counts artifacts too**, and the mockup's `7 items` summary line is
  `chatCount`-independent: it is the bundle's item count, files and artifacts together.
- **`Add a file to this project`** stays as it is; there is no "add an artifact" flow, because an artifact
  reaches a project by being linked from its chat. That is a scope decision, stated rather than implied.

### The eval harness

```
scripts/eval-artifact-contracts/
  README.md            # the switches, the key rule, the gate table, how to add a fixture
  run.ts               # the runner: --suite, --only, --replay, --limit, --out
  config.ts            # env switches, all EVAL_ARTIFACTS_* prefixed
  client.ts            # the one place the API key is read; nothing else touches it
  fixtures/
    apps/*.json        # prompts + source material
    documents/*.json
    canvas/*.json
    slides/*.json
    verification/*.json
  suites/
    apps.ts            # suite 1 — the App contract, the P1 pipeline as a regression gate
    document-patches.ts# suite 2
    canvas-diffs.ts    # suite 3
    slides.ts          # suite 4  (Slice 4 owns the calls; this slice owns the scoring shape)
    verification.ts    # suite 5 — the fact-verification pass
  score/
    apps.ts            # adapted from prototype-artifact-apps/score.ts, verdict rules unchanged
    patches.ts
    diffs.ts
    slides.ts
    verification.ts
    report.ts          # results.json + the gallery
  out/                 # GITIGNORED: results.json, index.html, screenshots/, raw-*.txt
```

**Env switches** (`config.ts`, modelled on the App prototype's table):

| Switch | Default | Meaning |
|---|---|---|
| `EVAL_ARTIFACTS_SUITE` | `all` | `apps`, `documents`, `canvas`, `slides`, `verification`, or `all` |
| `EVAL_ARTIFACTS_ONLY` | — | comma-separated fixture ids |
| `EVAL_ARTIFACTS_LIMIT` | — | cap the fixture count |
| `EVAL_ARTIFACTS_REPLAY` | `0` | re-score committed responses, **no model call** |
| `EVAL_ARTIFACTS_SKIP_MODEL` | `0` | alias of replay, for the CI script's readability |
| `EVAL_ARTIFACTS_SKIP_EVAL` | `0` | call the model, write raw responses, do not score |
| `EVAL_ARTIFACTS_THINKING` | `off` | App generation is thinking-off by decision (§2.9); the harness asserts it rather than offering it |
| `EVAL_ARTIFACTS_OUT` | `out` | output directory |
| `EVAL_ARTIFACTS_BASE_URL` / `_MODEL` / `_API_KEY` | — | provider override; the key falls back to `~/.config/opencode/opencode.json` |

**Sampling**, identical to the App prototype so results are comparable: temperature 0.6, top_p 0.95, top_k 20,
max_tokens 24000, streamed. Strictly sequential, one retry maximum, stop after two consecutive 429/5xx.
Thinking is **off** for Apps and **on** for the others, and `EVAL_ARTIFACTS_THINKING` is asserted against the
suite's own policy so a run cannot silently score apps generated with thinking on.

**How each suite is scored — automatically, with no human in the loop.**

| Suite | What is called | What is measured | Pass bar |
|---|---|---|---|
| **1. Apps** (spec §4.1) | the App contract prompt, thinking off | the P1 pipeline unchanged: open in headless Chromium with network blocked and `window.alfy.storage` mocked, four loads, one smoke interaction, plus the four static contract checks (`no-script-src`, `no-link-href`, `no-remote-img`, `no-network-api`) | the P1 baseline: **10/10 works**. Any `fatal` verdict fails the suite; `works-with-glitches` is counted and reported against the baseline |
| **2. Document patches** (§4.2) | a real stored document + a real request → `edit_artifact`-shaped patches | fed through the **real** `validateDocumentPatches`: does it apply; does the second fixture (the user edited the block first) get refused with `stale_base_hash`; is every patch inside the requested scope (fixture-declared target block ids) | every apply-fixture applies completely; every refusal-fixture refuses **only** the intended block; zero patches outside scope |
| **3. Canvas diffs** (§4.3) | a real stored board + "arrange Saturday" → a BoardDiff | fed through the **real** `validateBoardDiff`, then a **rubric** over the resulting board: every requested item is on the board; ids are all resolvable; no node was moved out of the frame it belongs to; no two nodes overlap after the arrangement; the node's labels are non-empty; nothing was removed that the request did not name | all rubric items true, for every fixture; the board JSON is also screenshotted into the gallery for the owner's eye, but the verdict is the rubric |
| **4. Slides** (§4.4) | a request → deck JSON | schema validity against `SlidesBody`; layout ids in the registry; language matches the request (the repo's own detector); **no invented number or proper noun** — every number and capitalised proper noun in the deck must appear in the supplied source material or be an arithmetic relation of values in it; caps respected | zero invalid decks; zero unregistered layouts; zero language misses; zero invented facts |
| **5. Fact verification** (§4.5) | fixture pairs: a fabricated artifact body **and** its source material | does the verification pass flag it, and does it classify the class correctly — wrong key, mislabelled aggregate, wrong unit/gloss (the three measured P1 bug classes); plus clean fixtures it must **not** flag | every seeded bug detected and classified; zero false positives on the clean fixtures |

**How the fact-verification pass is judged.** This is the suite with the most room to be vague, so it is
judged by outcome, not by wording: the verifier returns a structured verdict (the Slice 2 contract), and the
score compares that structure against the fixture's declared answer — `detected: true/false`,
`class: "wrong_key" | "mislabelled_aggregate" | "wrong_unit" | null`, and the location. A verifier that
"notices something is off" without naming the class scores as a miss, because a miss is what it is. Each
fixture carries its expected structure, and each suite ships **negative** fixtures that must come back clean;
a verifier that flags everything fails on the negatives. That pairing is what makes suite 5 meaningful
rather than an alarm that is always ringing.

**How each slice is gated on its suite.**

| Slice | Gate |
|---|---|
| Slice 1 — Document | suite 2 (`--suite documents`) |
| Slice 2 — App | suite 1 (`--suite apps`) **and** suite 5 (`--suite verification`) |
| Slice 3 — Canvas | suite 3 (`--suite canvas`) |
| Slice 4 — Slides | suite 4 (`--suite slides`) |
| this slice | `--replay --suite all`: every suite re-scores committed responses with no model call, so the gate is cheap and deterministic in CI |
| a prompt or tool-description change | `--suite all` against a real model, because a replayed response cannot measure a prompt change |

**The replay switch is the whole reason this is a gate and not a ritual.** A committed response set under
`fixtures/<suite>/responses/` is re-scored on every CI run for free; a real model run happens when the
contract or the prompt changed, and its raw responses are reviewed and committed with the PR. That makes the
harness's cost proportional to how often the contract changes rather than to how often someone pushes.

---

## File ownership

| File | Change |
|---|---|
| `src/lib/server/services/normal-chat-tools/artifact-tools/{create,edit,read}.ts` + tests | create — schemas, normalisation, payload builders |
| `src/lib/server/services/normal-chat-tools/index.ts` + test | extend — register three tools, add the `TOOL_I18N` entries for both languages |
| `src/lib/server/services/normal-chat-tools/shared.ts` | extend — three `TOOL_TIMEOUTS_MS` rows |
| `src/lib/server/services/chat-turn/normal-chat-tool-gating.ts` + test | extend — the artifact tools in the fake catalogue; **no per-turn gating** |
| `src/lib/server/services/normal-chat-context.ts` + test | extend — `buildArtifactCatalogueSection`, called from `buildTurnGuidance` |
| `src/lib/server/prompts.ts` | extend — one unconditional paragraph under `### Files And Artifacts` |
| `src/lib/server/services/artifacts/read-model.ts` + test | extend — `getArtifactSources`, the catalogue input |
| `src/lib/server/services/message-evidence.ts` + test | extend — `EvidenceSourceType` gains `"artifact"`, one row in `GROUP_ORDER`/`GROUP_LABELS`, artifact items in `buildAssistantEvidenceSummary` |
| `src/lib/server/services/chat-turn/finalize-steps.ts` + test | extend — pass this turn's artifacts into the evidence builder |
| `src/lib/components/chat/ResponseAuditDetails.svelte` | extend — two rows, two callback props |
| `src/lib/components/chat/MessageEvidenceDetails.svelte` | extend — render `artifact` items through the existing row snippet |
| `src/lib/server/services/knowledge/types.ts` | extend — `ArtifactType` gains `"artifact"` |
| `src/lib/server/services/knowledge/project-knowledge.ts` + test | extend — artifacts in `listProjectKnowledge`, provenance fields |
| `src/routes/(app)/projects/[projectId]/_components/ProjectFilesDialog.svelte` | extend — artifact rows, type labels, open-the-panel |
| `src/lib/components/home/HomeSurface.svelte` | extend — the bundle's item count includes artifacts |
| `src/lib/i18n/artifacts.ts` + test | extend — `artifacts.info*`, `artifacts.evidence.*`, `artifacts.bundle.*` |
| `src/lib/i18n/common.ts` | extend — `evidence.group.artifact` label pair (**only if** T4's union widening is approved) |
| `scripts/eval-artifact-contracts/**` | create — the whole harness, including fixtures, rubrics, responses and README |
| `.gitignore` | extend — `scripts/eval-artifact-contracts/out/`, and **not** `fixtures/*/responses/` |
| `tests/cross-cutting/incognito-artifact-containment.test.ts` | extend — the catalogue, the sources read, the bundle listing |
| `package.json` | extend — `eval:artifacts` and `eval:artifacts:replay` scripts |

**Serialisation.** `src/lib/server/services/message-evidence.ts` and `MessageEvidenceDetails.svelte` are
shared with nothing else in Feature 2, but the `EvidenceSourceType` widening (T4) reaches Slice 3's
`liveweb` block and Slice 1's sources row. **Do T4 last of the four product tasks**, so the widening lands
against merged code rather than against four open branches.

## Tasks

### Task T1: The catalogue, the static paragraph, and the byte-identical proof

**Files:** `normal-chat-context.ts` + test, `prompts.ts`, `src/lib/server/services/artifacts/read-model.ts` + test
**Test:** unit

- [ ] **Step 1: Write the failing tests**

```ts
it("builds no catalogue section for a conversation with no artifacts", ...);
it("lists at most ARTIFACT_CATALOGUE_MAX entries, newest first", ...);
it("clips a long title to 60 characters", ...);
it("ends with '(and N more in this chat)' when entries were dropped", ...);
it("carries the artifact id and the type name in every line", ...);
it("never says the word artifact in the section it renders to the model", ...);  // ADR-0066, model-facing too
it("keeps the system prompt byte-identical when only the message changes", ...);
it("keeps the system prompt byte-identical when only the message language changes", ...);
it("changes the turn guidance when the conversation's artifacts change", ...);
```

- [ ] **Step 2: Run them to verify they fail**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run src/lib/server/services/normal-chat-context.test.ts
```
Expected: FAIL on the new cases; the existing byte-identical cases must stay green throughout.

- [ ] **Step 3: Implement**

Add `buildArtifactCatalogueSection` and call it from `buildTurnGuidance`. Add the two-sentence paragraph to
`prompts.ts`'s `### Files And Artifacts` block, unconditional. Do **not** touch `buildOutboundSystemPrompt`'s
structure, and do not introduce a flag.

- [ ] **Step 4: Run them to verify they pass**

```bash
npx vitest run src/lib/server/services/normal-chat-context.test.ts
```
Expected: PASS, including the pre-existing byte-identical cases.

- [ ] **Step 5: Commit**

```
git add src/lib/server/services/normal-chat-context.ts src/lib/server/services/normal-chat-context.test.ts \
  src/lib/server/prompts.ts src/lib/server/services/artifacts/read-model.ts
git commit -m "Tell Alfy what exists in this chat, and nothing that varies by message

The catalogue is a fact, not a decision about which guidance applies: it is the
same for every message in the same conversation state, and it rides with the turn
guidance after the user message rather than inside the cached system prompt. The
rules for choosing a type stay on the tools, which is where ADR-0055 put them
after deleting the guidance packs."
```

### Task T2: `create_artifact` and `read_artifact`

**Files:** `artifact-tools/{create,read}.ts` + tests, `index.ts` + test, `shared.ts`
**Test:** unit + integration

- [ ] **Step 1: Write the failing tests**

```ts
it("registers both tools in the catalogue with a description in en and hu", ...);
it("keeps the whole catalogue inside its prompt token budget", ...);   // index.test.ts already has this case
it("does not change the catalogue between two turns with different messages", ...);
it("advertises the trimmed schema and validates with the full one", ...);
it("creates a document artifact with a version row and an alfy author", ...);
it("returns the new artifact's id and the version id", ...);
it("refuses to create an artifact in another user's conversation", ...);
it("refuses to create an artifact with an empty body", ...);
it("reads back the block ids and hashes it just wrote", ...);
it("returns candidates and no body for an id this conversation does not have", ...);
it("reads a File-type id from this conversation and says it is a file", ...);
it("never returns a body belonging to another user", ...);
it("surfaces a domain failure as a model-safe string, not a stack", ...);
it("records one tool-call entry per call with its duration", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

Build the two modules, register them beside the existing tools, add the timeout rows. Follow
`read_generated_file`'s shape closely: validate against an execution schema separate from the advertised one,
return a model-safe payload rather than going through the envelope for a validation failure.

- [ ] **Step 4: Run them to verify they pass**, plus
  `npx vitest run src/lib/server/services/chat-turn/normal-chat-tool-gating.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/server/services/normal-chat-tools
git commit -m "Let Alfy make something that outlives the reply

create_artifact and read_artifact are one call each and both are cheap: creating
writes a body the model just produced, reading returns the ids and hashes it will
need to edit. Reading before editing is the contract, so the read tells the model
what the edit will be addressed against."
```

### Task T3: `edit_artifact`, the refusal path, and the type-choice guidance

**Files:** `artifact-tools/edit.ts` + test, `index.ts` + test
**Test:** unit + integration

- [ ] **Step 1: Write the failing tests**

```ts
it("applies a document patch batch and returns the version id", ...);
it("refuses a patch whose baseHash is not the block's current hash and applies the rest", ...);
it("returns one refusal per refused op with its target and reason", ...);
it("refuses a canvas op naming an id the board does not have", ...);
it("refuses a slides patch on a field the slide's layout does not have", ...);
it("refuses when neither patches nor ops is present", ...);
it("refuses when both are present and the artifact is a single type", ...);
it("never edits another user's artifact", ...);
it("records the summary as the version's one-line description", ...);
it("carries the guidance for every type in both languages", ...);
it("names produce_file as the path for a download in the description", ...);
it("names the four artifact types and never the word artifact", ...);
it("keeps the en and hu descriptions at parity in length and structure", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

Union-typed input, per-type dispatch into the same validators the ops routes use, `applied`/`refused` in the
payload. Then write the descriptions — this is the task's real content, since ADR-0055 makes them the
guidance. The EN and HU versions carry the same six points in the same order.

- [ ] **Step 4: Run them to verify they pass**

```bash
npx vitest run src/lib/server/services/normal-chat-tools
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/server/services/normal-chat-tools
git commit -m "Let Alfy edit what it made, and be told when it may not

A refusal is the feature, not the failure: if the user typed into that block
since Alfy last read it, the patch is refused with a reason the model can act on
and the rest of the batch still lands. The type-choice rules live in this tool's
own description because that is the only place ADR-0055 leaves for them."
```

### Task T4: Evidence — an artifact's sources, and what the turn made

**Files:** `artifacts/read-model.ts`, `message-evidence.ts` + test, `finalize-steps.ts` + test,
`MessageEvidenceDetails.svelte`, `src/lib/i18n/common.ts`
**Test:** unit + integration + cross-cutting

- [ ] **Step 1: Write the failing tests**

```ts
it("returns the sources of a create_artifact call, in order, deduped by url", ...);
it("returns nothing for an artifact whose tool calls carried no candidates", ...);
it("never returns a source from another user's conversation", ...);
it("renders document-typed artifact sources as buttons into the shared workspace", ...);
it("renders web-typed artifact sources as links with a favicon", ...);
it("groups this turn's artifacts under one label in both languages", ...);
it("does not put an artifact into the document group", ...);
it("labels the group 'Made in this chat' in en and hu", ...);
it("omits the group entirely for a turn that made nothing", ...);
it("keeps the evidence summary shape backward compatible for stored rows", ...);
it("does not carry an artifact body into the evidence summary", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL (the widening does not exist yet).

- [ ] **Step 3: Implement**

`getArtifactSources`, the `EvidenceSourceType` widening with its group row, artifact items from the turn's
tool calls, the rendering branch, and both languages. Re-run the containment suite: the sources read is a new
place artifact rows are queried by user, so PART B's guard may need the file named beside
`getArtifactOwnershipScope`, or the read must go through that scope.

- [ ] **Step 4: Run them to verify they pass**

```bash
npx vitest run src/lib/server/services/message-evidence.test.ts \
  tests/cross-cutting/incognito-artifact-containment.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/server/services src/lib/components/chat src/lib/i18n tests/cross-cutting
git commit -m "Show where an artifact's content came from, and that it was made at all

The sources were already in the tool-call record; this reads them out for the
artifact the call made, so no new table appears. A made artifact is evidence of
the turn it was made in, and it gets its own group because 'Retrieved Documents'
would misdescribe a thing that did not exist before the turn started."
```

### Task T5: The project bundle lists artifacts

**Files:** `knowledge/types.ts`, `knowledge/project-knowledge.ts` + test,
`ProjectFilesDialog.svelte`, `HomeSurface.svelte`, `src/lib/i18n/artifacts.ts` + test
**Test:** unit + integration + e2e

- [ ] **Step 1: Write the failing tests**

```ts
it("includes a project's artifacts in its bundle, ordered with its files", ...);
it("carries the concrete artifact type in the item's metadata, not a second column", ...);
it("labels a row with the chat it came from when it came from a chat", ...);
it("labels a plain file row as a project file", ...);
it("never shows the word artifact in a row", ...);
it("counts artifacts in the bundle's item line", ...);
it("opens an artifact row in the panel, not the document viewer", ...);
it("reports the type in both languages", ...);
it("does not list an artifact linked to another user's project", ...);
it("keeps linking a link: unlinking an artifact deletes nothing", ...);

// e2e (projects.spec.ts)
it("opens a project, sees an artifact row, and lands in the panel on it", ...);
it("counts files and artifacts together in the bundle line", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

Widen `ArtifactType`, extend `listProjectKnowledge` and its ordering, extend the dialog's row rendering and
its open action, extend `HomeSurface`'s count. The type pill reuses `artifacts.type.*`.

- [ ] **Step 4: Run them to verify they pass**, plus
  `npx playwright test tests/e2e/projects.spec.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/server/services/knowledge src/routes src/lib/components/home src/lib/i18n
git commit -m "Let a project's bundle show what its chats made

A bundle that listed only files would hide the work the chats did. The row says
where it came from, because "the deck I asked for in this chat" and "the file I
uploaded into this project" are different things to a reader, and the link stays
a link: unlinking never deletes the artifact."
```

### Task T6: The Info popover rows

**Files:** `ResponseAuditDetails.svelte`, `MessageBubble.svelte`, `src/lib/i18n/artifacts.ts`
**Test:** component + e2e

- [ ] **Step 1: Write the failing tests**

```ts
it("shows the made-in-this-chat row only when the evidence has artifact items", ...);
it("counts the artifacts in the row", ...);
it("calls onOpenArtifacts with no argument", ...);
it("shows the sources row when a web or document group exists", ...);
it("does not show either row while the evidence is still pending", ...);
it("labels both rows in en and hu", ...);

// e2e
it("opens the Info popover on a turn that made a document and reaches the panel from it", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

Two rows in `buildPrimaryRows()`, two callback props threaded from `MessageBubble.svelte`. Do not restructure
the component; append.

- [ ] **Step 4: Run them to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/components/chat src/lib/i18n
git commit -m "Reach what a turn made from the same popover that explains how it answered

The Info row and the evidence group share one label, so the two surfaces cannot
drift into describing the same turn differently."
```

### Task T7: The harness, its five suites, and its known-bad fixtures

**Files:** all of `scripts/eval-artifact-contracts/`, `.gitignore`, `package.json`
**Test:** unit (the scorers) + the harness itself

- [ ] **Step 1: Write the failing tests**

```ts
// score/*.test.ts — the scorers, against known-bad and known-good inputs, with no model
it("fails an app whose only text is a heading and which has no controls", ...);
it("fails an app that loads a remote script", ...);
it("passes an app with one working control and no console errors", ...);
it("fails a patch batch that applies a stale-hash patch instead of refusing it", ...);
it("fails a patch batch that touches a block outside the requested scope", ...);
it("fails a diff that leaves two nodes overlapping after an arrangement", ...);
it("fails a diff that moves a node out of the frame it belongs to", ...);
it("fails a deck whose number does not appear in the source material", ...);
it("fails a deck whose language does not match the request", ...);
it("fails a deck that uses an unregistered layout id", ...);
it("passes a deck whose numbers all derive from the source", ...);
it("scores a verifier that notices a wrong key but cannot classify it as a miss", ...);
it("fails a verifier that flags a clean fixture", ...);
it("never writes the api key shape into any file under out/", ...);
it("replays committed responses without constructing a model client", ...);
```

- [ ] **Step 2: Run them to verify they fail**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run scripts/eval-artifact-contracts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Write the scorers first (they are the part that must be trustworthy), then the runner, the client, the
fixtures, the gallery and the README. **Every suite ships a known-bad fixture that must fail**, and the
runner asserts it does before it scores any real response — a harness that cannot fail is not a gate. Commit
the response sets beside their fixtures so `--replay` works in CI.

- [ ] **Step 4: Run them to verify they pass**

```bash
node --experimental-strip-types scripts/eval-artifact-contracts/run.ts --replay --suite all
```
Expected: the known-bad fixtures fail as declared, the committed responses score at or above each suite's
bar, and `out/index.html` builds.

- [ ] **Step 5: Commit**

```
git add scripts/eval-artifact-contracts .gitignore package.json
git commit -m "Score the model's artifact behaviour without a human in the loop

Each suite ships a fixture that must fail, and the runner checks that before it
scores anything, because a rule that cannot fail is not a gate. Replay re-scores
committed responses with no model call, so the gate is cheap enough to run on
every push and the expensive run happens when the contract changed."
```

### Task T8: The real-model run, the README, and the wiring

**Files:** `scripts/eval-artifact-contracts/README.md`, `fixtures/*/responses/`, the CI script
**Test:** the harness against a real model, once

- [ ] **Step 1: Run the real-model harness for all five suites**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
node --experimental-strip-types scripts/eval-artifact-contracts/run.ts --suite all
```
Sequential, one retry maximum, stop after two consecutive 429/5xx.

- [ ] **Step 2: Read the result before committing it**

Record the per-suite verdict counts in the PR body, with the failing fixtures named. The API key does not
appear in any file, in any log, or in the PR body. If a suite is below its bar, **the design for that type
changes rather than the bar** (spec §8 risk 1, ADR-0066): the named fallback is that Alfy proposes and the
user approves. That is an owner decision; stop and ask.

- [ ] **Step 3: Commit the responses and the README**

The README documents: the switches, the key rule, the per-suite pass bars, the slice-to-suite gate table, how
to add a fixture, how to re-record a suite, and what to do when a suite fails.

- [ ] **Step 4: Verify the replay path is what CI runs**

```bash
node --experimental-strip-types scripts/eval-artifact-contracts/run.ts --replay --suite all
```
Expected: PASS with no model call and no key required.

- [ ] **Step 5: Commit**

```
git add scripts/eval-artifact-contracts
git commit -m "Record what the model actually did, so the gate is re-runnable

A replayed response cannot measure a prompt change, and a live run costs money on
every push. Both exist: the responses are committed and re-scored for free, and a
real run happens when the contract or the descriptions changed."
```

## Non-goals

- **No fourth tool.** `create_artifact`, `edit_artifact` and `read_artifact` are the whole surface. In
  particular, no `delete_artifact` (deletion is the user's, in the panel) and no `link_artifact_to_project`
  (linking is a user action in the bundle).
- **No artifact guidance pack, and no flag that switches guidance on.** ADR-0055 deleted that machinery.
- **No prompt caching changes.** The catalogue rides with the turn guidance; the cached prefix is untouched.
- **No new `EvidenceSourceType` beyond `"artifact"`**, and that one is flagged for approval in T4.
- **No artifact-to-artifact retrieval.** Whether the model may pick an image or a document from the library
  when making a Canvas or a deck is a retrieval feature this slice does not build; it validates ownership of
  whatever id it is given.
- **No "add an artifact to a project" flow.** Artifacts reach a project by being linked from their chat.
- **No verification pass of its own.** Suite 5 scores Slice 2's pass; this slice does not write a second one.
- **No model-quality dashboard.** The gallery and `results.json` are the report.
- **No changes to `MAX_PRODUCE_FILE_SUBMISSIONS_PER_TURN`** or any other existing cap.

## Risks

| Risk | Why it bites | Mitigation |
|---|---|---|
| Guidance lands somewhere message-conditioned | It fails `normal-chat-context.test.ts`'s byte-identical assertion, or worse, passes review and costs the prefix cache | The rules live on the tools; the catalogue is a fact in turn guidance; the byte-identical test runs in T1's step 4 explicitly |
| The catalogue grows without bound | A 40-artifact conversation pays for a 40-line prompt on every turn | Capped at 12 with a visible `(and N more)`, and a test asserts the cap |
| A tool's patch validator diverges from the route's | Two answers to "does this apply", and the user's own edit loses | Model-facing patches and ops are `z.unknown()`; the per-type validators are the only authority |
| The harness cannot fail | It becomes decoration, and a type ships on an unmeasured contract | Every suite ships a known-bad fixture the runner asserts fails first |
| The key leaks into `out/` or a fixture | It is in the repo's history | One function reads it; a test greps `out/` on every invocation; `out/` is gitignored |
| The `EvidenceSourceType` widening breaks a stored row | Evidence is JSON in `messages.metadata_json`, so an old row has no `artifact` items and stays readable | Additive union, one new group row, and a backward-compatibility test on a stored summary |
| The bundle shows artifacts as files | The user cannot tell what they are looking at, and the row opens the wrong surface | Provenance label plus the UI's own type word; the row opens the panel; an e2e asserts the destination |
| Replay scores a stale response set | CI passes on responses that no longer match the schema | Re-recording is required by the README whenever the contract or a description changes, and `--replay` fails on a schema mismatch rather than skipping |
| Suite 3's rubric becomes a taste argument | "A board a human would accept" is exactly the vague thing risk 1 warns about | The rubric is mechanical: requested items present, ids resolvable, no node outside its frame, no overlapping nodes, non-empty labels, nothing unnamed removed |

## Verification checklist

- [ ] Every task's tests were seen failing first, then green.
- [ ] `npm run check` — 0 errors, 0 warnings.
- [ ] `npx biome check src scripts tests` — clean.
- [ ] `npm test` — green, including the harness's scorer tests and the i18n key parity test.
- [ ] `npm run build` — 0 warnings.
- [ ] `npx fallow --no-cache --format json --quiet --score` — no new findings, no new ignores.
- [ ] `npx vitest run src/lib/server/services/normal-chat-context.test.ts` — green, including the two
      pre-existing byte-identical cases (the ADR-0055 proof).
- [ ] `npx playwright test tests/e2e/artifacts-panel.spec.ts tests/e2e/chat.spec.ts tests/e2e/projects.spec.ts tests/e2e/incognito-indicator.spec.ts` — green.
- [ ] `node --experimental-strip-types scripts/eval-artifact-contracts/run.ts --replay --suite all` — green, with no key required.
- [ ] A real-model `--suite all` run was made, its per-suite verdicts and failing fixture names are in the PR body, and its responses are committed.
- [ ] **Real-app visual check** at **1440×900 and 390×844, light and dark**: the Info popover shows the two new rows in the right order and opens the panel; a document-typed source opens the shared workspace; a web-typed source opens its URL; the project bundle's artifact row is labelled with the type word and opens the panel; nothing overflows.
- [ ] **Staging, real model:** ask for a trip plan → Alfy makes a Document, the reply says what it made, the card appears; ask for a deck → Slides; ask for something to arrange → Canvas; ask for "a PDF" → `produce_file`, not an artifact. Ask in Hungarian and confirm the type names and the artefact text are Hungarian.
- [ ] **Staging:** read an artifact, change a block by hand, then ask Alfy for a change to that block → refused with the reason visible, and the other changes applied.
- [ ] **Staging:** link an artifact to a project from its chat and see it in that project's bundle with its provenance.
- [ ] **Staging:** an artifact made in an **incognito** chat is not in the catalogue next to a normal chat, is not in the library, and is not cited later.
- [ ] Read the staging service journal for new warnings.

## Open questions for the owner

1. **Widening `EvidenceSourceType` with `"artifact"`.** The alternative is to file made artifacts under the
   existing `document` group, whose user-visible label is "Retrieved Documents" — which would say something
   false. The widening is additive and JSON-backed, but it is a shared union, so it is asked rather than
   taken. If the answer is no, the Info row in T6 stands alone and T4's group work is dropped.
2. **Human review in the harness.** Suite 3 has a rubric (`no overlaps`, `ids resolvable`, and so on) that is
   mechanical, but "arrange Saturday" is a request where a human would also say *whether it is an
   arrangement they wanted*. The gallery screenshot is there for that eye. Should the harness also record a
   per-fixture human verdict field for the owner to fill in, or is the rubric the whole gate?
3. **The dead `fileProductionToolsAvailable` field.** `buildOutboundSystemPrompt` declares and threads it but
   never reads it, and AGENTS.md describes file-production guidance as living in `normal-chat-context.ts`
   when it actually lives in `prompts.ts` plus `produce_file`'s description. This slice adds artifact
   guidance on the same reasoning, which deepens the drift between the docs and the code. Should the field be
   deleted and AGENTS.md corrected in this slice, or tracked separately?
4. **Suite 1's baseline.** The App suite's bar is the P1 result (10/10 works). If a later model or a
   dependency change moves it, is the bar the absolute count or a ratio against the previous committed run?
