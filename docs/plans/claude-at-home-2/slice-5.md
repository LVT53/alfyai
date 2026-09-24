# Slice 5 — Alfy's side: three tools, the guidance that rides on them, and the eval harness

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking. Read `plan.md` first. **This slice can start once Slice 0 has landed** (the artifacts boundary,
> the `artifacts/` service, and the harness skeleton), but it **finishes after Slice 1, 2, 3 and 4**, because
> three of its five eval suites are written against their contracts. Tasks T1–T3 (the tools and the
> catalogue) touch only Slice 0; T4 (evidence) needs Slice 1's artifact link and Slice 2's verifier shape;
> T5 (bundle) needs Slice 0's records and the type-word i18n rows; T6 is docs only; T7–T9 (the harness) is
> the gate for all four.

**Goal:** Make Alfy *use* artifacts well: choose the right type, offer one only when it is wanted, create and
edit through three tools whose usage rules live on the tools themselves, show where a made thing's content
came from and that it was made at all, list an artifact in its project's bundle, and — the deliverable that
makes any of that trustworthy — score the model's artifact behaviour automatically in
`scripts/eval-artifact-contracts/` so each type's slice is gated on measured contract quality rather than on
a prototype's word.

**Architecture:** Three new tools register in `normal-chat-tools/index.ts` beside the existing eighteen (the
`asExecutableTool` helper is at `normal-chat-tools/index.ts:199`; `read_generated_file` is the closest
neighbour at `index.ts:1606`), each wrapped in the existing `executeToolWithEnvelope`
(`normal-chat-tools/shared.ts:314`), each adding one `TOOL_TIMEOUTS_MS` row (`shared.ts:196`), and each
carrying its own EN and HU description in `TOOL_I18N` (`index.ts:259-261`) — because per
[ADR-0055](../../adr/0055-tool-usage-guidance-lives-in-the-tool-interface.md) a tool's usage rules live on
the tool's description and **there is no guidance-pack selector to add to**. The type-choice rules therefore
ride on those three descriptions plus one unconditional static paragraph in `prompts.ts`'s live base prompt;
`normal-chat-context.ts` gains only the *catalogue* of artifacts in this conversation — one more optional
pre-built block on `buildTurnGuidance`'s params, exactly where `skillCatalogueBlock` already rides — which
`appendTurnGuidance` appends after the current user message and which is not part of the cached system
prompt. Evidence integration follows decisions.md ruling 6: a made artifact appears as an **evidence row in
the existing Sources panel**, labelled with its type; no new Info popover row is invented. The eval harness
is a standalone `scripts/eval-artifact-contracts/` following `scripts/prototype-artifact-apps/`'s proven
shape, with one addition that makes it affordable as a gate: recorded model responses are replayed and
re-scored without a model call.

**Tech Stack:** the existing AI SDK tool layer (`normal-chat-tools/`), the existing evidence layer
(`message-evidence.ts`, `MessageEvidenceDetails.svelte`), the existing project bundle
(`knowledge/project-knowledge.ts`, `ProjectFilesDialog.svelte`), and `npx tsx` for the harness — the repo's
own convention (`package.json:11`, `package.json:56`; `scripts/eval/README-option-a-fidelity.md:36-38`;
`docs/plans/claude-at-home-2/slice-0.md:946`). No new runtime dependency.

**Spec:** `docs/plans/claude-at-home-2-artifacts-spec.md` §2 (decisions 1, 2, 5, 9, 10, 11), §4 (tools and the
required eval), §5 (card, panel), §6 (Slice 5), §7 (testing), §8 (risk 1, risk 6).
ADRs: [ADR-0055](../../adr/0055-tool-usage-guidance-lives-in-the-tool-interface.md) (guidance in the tool
interface), [ADR-0066](../../adr/0066-artifacts-are-a-family-of-five-types.md) (the family, and the eval
harness as a gate), [ADR-0065](../../adr/0065-living-documents-are-edited-in-place.md) (editing in place).
Rulings that bind this slice: `decisions.md` **5** (guidance on the tools, plus two doc fixes that land
here), **6** (artifacts appear through the existing Sources surface, no new popover row), **7**
(`EvidenceSourceType` widening is approved), **12** (the canonical hash form is Slice 1's).

## Prototype pointers

| Hard part | Read this |
|---|---|
| The whole harness shape: switches, one sequential loop, one retry, stop after two 429/5xx, `results.json` + gallery | `scripts/prototype-artifact-apps/run.ts` on `proto/artifact-apps-quality` (see its header at `run.ts:9-14`; the stop condition at `run.ts:255`) |
| The App verdict rules, and why they are blunt and explainable | `scripts/prototype-artifact-apps/score.ts:5-15`, verdict assembly `score.ts:133-137` |
| The API-key rule and the P1 baseline | `scripts/prototype-artifact-apps/README.md:54-55` (key), `README.md:76` (**10/10 works**) |
| Static App contract checks | `scripts/prototype-artifact-apps/evaluate.ts` (ported into Slice 2's `artifacts/app/audit.ts`) |
| Prompt + source material per fixture | `scripts/prototype-artifact-apps/prompts.ts`, `fixtures/` |
| An in-repo eval that already splits live/CI and never logs a key | `scripts/evaluate-tool-guidance-ab.ts` (SECURITY note at `:40-41`), `scripts/eval/README-option-a-fidelity.md:36-48`, `scripts/eval/option-a-fidelity.ts` |

## Global Constraints

Same as `plan.md` §Global Constraints. In addition, for this slice:

- **Svelte 5 runes only** in the touched components. `MessageEvidenceDetails.svelte` and
  `ProjectFilesDialog.svelte` are large migrated files: append, do not reorganise, and do not reintroduce
  `on:` directives or `<slot>` in anything you touch.
- **Lucide icons only**; **tokens only**; **EN + HU in the same commit** for every new string, including
  tool descriptions (tools carry both, in `TOOL_I18N`).
- **"Artifact" never appears in the UI.** The word is an engineering term (ADR-0066). Tool *descriptions*
  are model-facing rather than UI, and even there the type names are Document, App, Canvas, Slides, File.
- **No guidance pack, and no per-turn prompt splice.** ADR-0055 deleted the selector outright, and
  `buildOutboundSystemPrompt`'s output must stay **byte-identical for a fixed conversation** regardless of
  the latest message's wording, length or language — asserted by the existing regression tests in
  `normal-chat-context.test.ts` under `describe("assembled system prompt stability (G1 / ADR-0055)")`
  (`normal-chat-context.test.ts:645`, cases at `:655`, `:664`, `:689`, `:756`, `:858`, `:1027`; each builds
  `buildOutboundSystemPrompt({ …, fileProductionToolsAvailable: true })`). Anything message-conditioned you
  add there fails those tests, which is the tests doing their job.
- **The tool catalogue must not vary by turn.** `shouldExposeFileProductionTools()` returns a hard `true`
  and documents why (`chat-turn/normal-chat-tool-gating.ts:10-15`): the tool set sits inside the cached
  prompt prefix, so a per-turn decision about *which* tools exist changes the prefix and costs the cache.
  New tools register unconditionally; the only allowed deletion is in `selectNormalChatToolsForRequest`, and
  only for a condition that is stable for a conversation's whole life (memory off, skills off, incognito).
- **The catalogue rides the turn guidance, not the system prompt.** `buildTurnGuidance`
  (`normal-chat-context.ts:611`) is sync and pure, and `normal-chat-context.ts` performs no DB reads — the
  identical constraint that made `skillCatalogueBlock` a *caller-resolved string* (`:622`, `:646-647`);
  the caller is `prepareOutboundContext` in `chat-turn/shared-normal-chat-model-run-helpers.ts`
  (`resolveSkillCatalogueBlock` at `:267`, called at `:326`, passed at `:370`). The artifact catalogue
  follows that seam exactly.
- **No new `EvidenceSourceType` beyond `"artifact"`**, and this slice says so in the PR body (ruling 7
  approves it), with one test per group and the containment suite re-run.
- **The harness API key rule is absolute** (inherited from the App prototype): the key is read from
  `~/.config/opencode/opencode.json`, and is **never printed, never logged, never written into
  `results/`, and never committed** (`scripts/prototype-artifact-apps/README.md:54-55`). `results/` is
  gitignored; a test asserts no file under `results/` contains the key's shape.
- **Everything the harness writes is under `scripts/eval-artifact-contracts/results/`** (gitignored, same
  pattern as `.gitignore:76`) except the prompts, rubric, fixtures and recorded responses, which are
  committed and reviewed.
- **`npm run check` stays at 0 errors, 0 warnings; `npm run build` emits 0 warnings.**
- **Cost discipline.** `MAX_SAME_TURN_PRODUCE_FILE_SUBMISSIONS = 2`
  (`normal-chat-tools/produce-file.ts:2744`) and `MAX_PRODUCE_FILE_SUBMISSIONS_PER_TURN = 6`
  (`produce-file.ts:2753`) stay as they are; the harness runs sequentially, one retry maximum, and stops
  after two consecutive 429/5xx, exactly as the App prototype does (`run.ts:13-14`).

## Gates

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run check && npx biome check src scripts tests && npm test && npm run build
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json
npx playwright test tests/e2e/artifacts-panel.spec.ts tests/e2e/artifact-document.spec.ts \
  tests/e2e/chat.spec.ts tests/e2e/projects.spec.ts

# The contract gate. --replay re-scores committed responses with no model call (CI):
npx tsx scripts/eval-artifact-contracts/run.ts --replay --suite all
# A real model run, sequential, when the contract itself changed:
npx tsx scripts/eval-artifact-contracts/run.ts --suite all
```

**`npx tsx`, not `node --experimental-strip-types`.** The suites must import the *real* validators
(`applyPatchSet`, `validateBoardDiff`, `validateSlidePatch`) and the real types from `src/lib/…`, and
`tsconfig.json` resolves `$lib` only through the SvelteKit-generated path mapping
(`tsconfig.json` extends `.svelte-kit/tsconfig.json`), which node's type stripping does not apply. `tsx`
resolves it, and it is what every other script in the repo uses: `package.json:11`
(`check:migrations`), `scripts/eval/option-a-fidelity.ts`, and Slice 0's own harness command
(`docs/plans/claude-at-home-2/slice-0.md:946`).

## Review Focus

1. **Nothing about artifacts is spliced into the prompt per turn.** The single hard constraint inherited
   from ADR-0055. If `buildOutboundSystemPrompt`'s output changes when the message changes, the guidance was
   put in the wrong place. The regression tests at `normal-chat-context.test.ts:645-1027` are the proof,
   and T1 runs them explicitly.
2. **The tools refuse rather than guess (Tasks T2, T3).** Every op that names a missing id, a stale hash, or
   an unknown layout is refused with a reason the model can act on — never repaired silently. This is §2.5
   and the Canvas §2.13 rule together, and it is what the user's own editing depends on. The refusal
   vocabularies are **Slice 1's, Slice 3's and Slice 4's**, composed — not reinvented (see the contracts).
3. **The harness is a gate, and it can fail (Tasks T7, T8).** A suite that cannot fail is decoration. Each
   suite ships at least one fixture that **must** fail and is asserted to fail (a stale-hash patch that is
   not refused, an app with a wrong quiz key, a deck with an invented number), so the harness is measured
   against known-bad input before it is trusted against the model. The runner refuses to score real
   responses unless every declared known-bad fixture failed.
4. **The API key never reaches a file (Task T8).** One leak into `results/` or a committed fixture makes the
   key part of the repo's history. One function reads it, and the test that greps `results/` runs on every
   harness invocation, not only on the committed tests.
5. **The bundle shows a project's made things without pretending they are files (Task T5).** A row says
   where it came from, and the type word is the UI's own word (Document/App/Canvas/Slides) — never
   `artifact`.

---

## Contracts

### The three tools

Registered in `src/lib/server/services/normal-chat-tools/index.ts`, in the same
`asExecutableTool(tool({ description: i18n.<name>.description, inputSchema, execute }))` shape every
existing tool uses (`asExecutableTool` at `index.ts:199`; `read_generated_file` at `index.ts:1606-1645`),
each execute wrapped in `executeToolWithEnvelope` (`shared.ts:314`). Per-tool schemas, payload shaping and
the per-type dispatch live in beside-modules (`artifact-tools/create.ts`, `edit.ts`, `read.ts`), as
`memory-context.ts` and `produce-file.ts` already do. The artifact type union is **Slice 0's**
`ArtifactKind` (`docs/plans/claude-at-home-2/slice-0.md:195`:
`"document" | "app" | "canvas" | "slides" | "file"`); the kind itself is
`metadata_json.artifactType` (`slice-0.md:198-203`, `:263`) — never re-derived here.

```ts
// src/lib/server/services/normal-chat-tools/artifact-tools/create.ts
import { z } from "zod";
import type { ArtifactKind } from "$lib/server/services/artifacts/record";

/** The four types Alfy may create. "file" is produce_file's, not this tool's. */
export const CREATABLE_ARTIFACT_KINDS = ["document", "app", "canvas", "slides"] as const;

/** Advertised to the model: trimmed descriptions, no server-only bounds. */
export const createArtifactModelInputSchema = z.object({
	artifactType: z
		.enum(CREATABLE_ARTIFACT_KINDS)
		.describe("document, app, canvas or slides"),
	title: z.string().min(1).describe("What the user will see in the card and the panel."),
	body: z
		.string()
		.min(1)
		.describe(
			"Documents: Markdown. Slides: the deck JSON. Canvas: the board JSON, or empty for a new board. Apps: the HTML document.",
		),
});

/** Executed against: the same fields, with the server's bounds applied. */
export const createArtifactInputSchema = z.object({
	artifactType: z.enum(CREATABLE_ARTIFACT_KINDS),
	title: z.string().min(1).max(200),
	/** Documents: Markdown with `<!--b:id-->` markers. Slides: the deck JSON.
	 *  Canvas: the board JSON, or empty for a new board. Apps: the HTML document. */
	body: z.string().min(1),
});

export type CreateArtifactToolInput = z.infer<typeof createArtifactInputSchema>;
```

```ts
// src/lib/server/services/normal-chat-tools/artifact-tools/edit.ts
import { z } from "zod";

/** Advertised to the model. `patches`/`ops` stay permissive on purpose (below). */
export const editArtifactModelInputSchema = z.object({
	artifactId: z
		.string()
		.min(1)
		.describe("The id from create_artifact, read_artifact or the artifact catalogue."),
	patches: z
		.array(z.unknown())
		.optional()
		.describe(
			"Documents and Slides only: [{op, blockId|slideId, fieldId, baseHash, text}]. Read the artifact first; baseHash must be the hash you last read.",
		),
	ops: z
		.array(z.unknown())
		.optional()
		.describe(
			"Canvas only: [{op:'add_frame'|'add_node'|'move'|'add_edge'|'remove_edge'|'update_node'|'remove_node'|'highlight', ...}], at most 40.",
		),
	summary: z.string().min(1).max(200).optional().describe("One short line shown next to Keep/Undo."),
});

/** Executed against: the caps are the server's, and they are enforced here. */
export const editArtifactInputSchema = z.object({
	artifactId: z.string().min(1),
	patches: z.array(z.unknown()).min(1).max(40).optional(),
	ops: z.array(z.unknown()).min(1).max(40).optional(),
	summary: z.string().min(1).max(200).optional(),
});
```

```ts
// src/lib/server/services/normal-chat-tools/artifact-tools/read.ts
import { z } from "zod";

export const readArtifactInputSchema = z.object({
	artifactId: z.string().min(1),
	/** `blocks` returns the addressable ids and hashes; `full` returns the whole body. */
	detail: z.enum(["blocks", "full"]).optional(),
});
```

Patches and ops are `z.unknown()` **deliberately**: the per-type validator is the authority, and it is the
same code path the ops routes use (slice-1's `applyPatchSet`/`applyDocumentPatch`, slice-3's
`validateBoardDiff` on the `ops` route, slice-4's `validateSlidePatch` on the slides route). A second,
schema-shaped validator on the model-facing surface would be a second source of truth about what applies —
the reason every artifact op is refused is a *server decision* (§4), and it has to be one implementation.

**Refusal vocabularies are composed, not invented.** This slice owns the *payload envelope*; the reasons are
the per-type ones:

```ts
// artifact-tools/edit.ts — the envelope only; the unions are imported, not restated.
import type { RefusalReason } from "$lib/server/services/artifacts/serialize/document";
import type { BoardRefusalReason } from "$lib/server/services/artifacts/serialize/canvas";
import type { SlideRefusalReason } from "$lib/server/services/artifacts/serialize/slides";

export type ArtifactRefusalReason =
	| RefusalReason        // slice 1: block_missing | block_unseen | block_changed | not_a_text_block |
	                       //   empty_text | find_not_found | find_ambiguous | not_a_task_block |
	                       //   not_a_table_block | bad_row        (slice-1.md:221-231)
	| BoardRefusalReason   // slice 3: unknown_id | duplicate_id | unknown_kind | kind_mismatch |
	                       //   missing_parent | self_parent | cycle | invalid_data | limit_exceeded
	| SlideRefusalReason;  // slice 4: unknown_slide | unknown_field | stale_base_hash |
	                       //   layout_dropped_field | invalid_text | limit_exceeded
```

Note what this means for the two contracts this slice was drafted against: the document stale-hash reason
is **`block_changed`** (slice 1's `applyPatchSet`, `slice-1.md:255-256`) and **`stale_base_hash` belongs to
Slides only** (`slice-4.md:180`). `slice-1.md:368-370` sketches the three schemas with a `label` argument;
`summary` is the model-facing name here and maps onto the version row's `summary` column (spec §3), because
`BoardDiff` already calls it `summary` (`slice-3.md:350`) and the DDL has one word for it. Slice 5 owns the
tool schemas (slice-3.md:685), so that sketch is read as superseded.

Payload shapes, mirroring `read_generated_file`'s honesty about not finding things:

```ts
export type ReadArtifactModelPayload =
	| {
			success: true;
			artifactId: string;
			artifactType: ArtifactKind;
			title: string;
			/** Documents: [{blockId, kind, label, hash, text}] (slice 1's readDocumentForAlfy shape).
			 *  Canvas: [{id, kind, label, x, y, parentId}].
			 *  Slides: [{slideId, layout, fields: [{fieldId, hash, text}]}]. */
			blocks?: Array<Record<string, unknown>>;
			body?: string;
		}
	| { success: false; error: string; candidates?: Array<{ artifactId: string; title: string }> };

export type EditArtifactModelPayload =
	| { success: true; artifactId: string; versionId: string; applied: number; refused: ArtifactRefusal[] }
	| { success: false; error: string; refused?: ArtifactRefusal[] };

export interface ArtifactRefusal {
	/** Document: blockId. Canvas: the op's target id. Slides: slideId. */
	target?: string;
	/** Document: blockLabel (slice-1.md:376). Slides: the SlideTarget. */
	label?: string;
	reason: ArtifactRefusalReason;
}
```

`success: false` with `candidates` is the ambiguity path, copying `read_generated_file`: if the model asks
for an artifact id that is not in this conversation, the tool says so and lists what *is* there, rather than
letting the model invent an id and have a later call fail obscurely.

**Tool-call metadata (the evidence seam).** Each successful call records
`metadata: { artifactId, artifactKind, artifactTitle }` on its `ToolCallEntry`
(`messages-types.ts:185-200`; `metadata` is already `Record<string, string | number | boolean | null>`), so
Task T4 derives "what this turn made" from the turn's own tool calls instead of adding a table or a second
link. `create_artifact` sets it from the row it just wrote; `edit_artifact` from the row it just changed.

### `TOOL_TIMEOUTS_MS` rows

```ts
create_artifact: 30_000,   // a whole body may be written in the call; no sandbox, no network
edit_artifact: 20_000,     // a validation pass and one version row
read_artifact: 10_000,     // the same as read_generated_file: a read, not a computation
```

`TOOL_TIMEOUTS_MS` is `Record<string, number>` (`shared.ts:196`); adding names needs no type change.

### The artifact catalogue (turn guidance)

Three pieces, at three seams that already exist:

```ts
// src/lib/server/services/artifacts/catalogue.ts  (new; pure + one reader)
export interface ArtifactCatalogueEntry {
	artifactId: string;
	artifactType: ArtifactKind;
	title: string;
	updatedAt: number;
}

/** Pure. Returns null when there is nothing to say. */
export function buildArtifactCatalogueBlock(entries: ArtifactCatalogueEntry[]): string | null;

/**
 * The artifacts reachable in this conversation, newest first. Reads through
 * getArtifactOwnershipScope(userId, { conversationId })
 * (knowledge/store/core.ts:141-144) so an incognito conversation's artifacts
 * stay inside it — the same scope the containment suite already guards.
 */
export async function listArtifactCatalogueEntries(params: {
	userId: string;
	conversationId: string;
}): Promise<ArtifactCatalogueEntry[]>;

/** The turn-guidance seam, beside resolveSkillCatalogueBlock (:267). */
export async function resolveArtifactCatalogueBlock(params: {
	userId: string;
	conversationId: string;
}): Promise<string | null>;
```

```ts
// normal-chat-context.ts — one more optional pre-built block on the existing params object (:611-627),
// rendered in the same sections array as the skill catalogue (:636-651).
artifactCatalogueBlock?: string | null;
```

```ts
// chat-turn/shared-normal-chat-model-run-helpers.ts — the caller, exactly like :326.
const artifactCatalogueBlock = await resolveArtifactCatalogueBlock({
	userId: params.userId,
	conversationId: params.conversationId,
});
// …passed through prepareOutboundChatContext beside skillCatalogueBlock (:370).
```

Format, and its size bound (the whole reason it is bounded):

```
## In this chat
- a1f3kq · Document · "Vienna plan" (updated 2 h ago)
- c91m2x · Canvas · "Saturday board" (updated 12 min ago)

Use read_artifact to see one before editing it. Never invent an id.
```

**The heading does not contain the word "artifact"** — ADR-0066 applies to model-facing text too, and the
same rule is why the tools are named against the types. The section is a fact about the conversation, not a
rule.

Caps: at most `ARTIFACT_CATALOGUE_MAX = 12` entries, newest first, titles clipped to 60 characters, and the
whole section omitted when there are none. A 40-artifact conversation is a real possibility and an unbounded
list is a prompt that grows with use. Entries beyond the cap are not hidden from the model: the section ends
with `(and N more in this chat)` so the model knows to ask rather than assume the list is complete.

**Why this is allowed where a guidance pack is not.** It is not a decision about *which guidance to show*,
it is a factual list of what exists, it is identical for every message in the same conversation state
(`listArtifactCatalogueEntries` reads the conversation, never the message), and it lives in
`buildTurnGuidance` — which `appendTurnGuidance` (`normal-chat-context.ts:659`) appends **after the current
user message** and which is therefore not part of `buildOutboundSystemPrompt`'s byte-identical system
prompt. The *rules* for choosing a type do not come here; they come from the tool descriptions, which is
ADR-0055's rule.

### The type-choice guidance, in the one place it may live

`TOOL_I18N.<lang>.create_artifact.description` (EN and HU, hand-written at parity, both in the same commit)
must carry, in this order, the rules the model needs:

1. **When to make an artifact at all.** When the user will come back to the thing, edit it, or keep it —
   a checklist, a plan, an itinerary, a draft, a letter, a deck, a board. **Not** for an answer that is
   complete in the reply; not when the user asked for a downloadable file — that is `produce_file`, and the
   negative clause says so in both languages (the existing negative-clause test at `index.test.ts:4895`
   requires `NEGATIVE_CASE_MARKER.en = "Do not use"` / `.hu = "Ne használd"`, `index.test.ts:4770`).
2. **How to choose the type**, in one line per type:
   - **Document** — rich text that will be read and edited over time: plans, checklists, itineraries,
     letters, drafts, trackers.
   - **App** — an interactive tool: a calculator, a splitter, a quiz, something with inputs and results.
   - **Canvas** — a board: things to arrange in space, with frames, notes, arrows and blocks.
   - **Slides** — a deck to present: a small ordered set of slides with a beginning and an end.
   - **File** — anything the user asked to *download*: `produce_file` makes it, and it appears as a File.
     (There is no `artifactType: "file"`; the type exists so the model can say the word and pick the right
     tool.)
3. **One artifact per request.** Do not also paste the same content into the reply; say what was made and
   offer to open it.
4. **Never invent an id.** Read before editing.
5. **One worked example** of each call, short.
6. **What to do on failure:** read the refusal reason, fix that op, retry at most once.

`edit_artifact`'s description carries the block-addressed contract: read first, `baseHash` is the hash you
last read, a refusal means the user changed it (tell the user, do not retry the same patch), and a batch
applies partially. `read_artifact`'s carries the two detail levels and what each returns.

**The catalogue token budget must be raised once, explicitly.** The measured whole-catalogue budget is
tested at `index.test.ts:4920` against `CATALOGUE_TOKEN_CEILING = { en: 4160, hu: 6850 }`
(`index.test.ts:4825`), with per-tool ceilings of `PER_TOOL_TOKEN_CEILING = 750` (`:4824`) and the
conversion `CHARS_PER_TOKEN = { en: 4.0, hu: 2.9 }` (`:4785`). The current measurement is **4,153 en /
6,672 hu** (`:4818`), so EN has **7 tokens** of headroom (`:4820`: "That is a tripwire, not a budget.").
Three substantial new descriptions cannot fit. So: measure the new catalogue with the existing test, then
raise `CATALOGUE_TOKEN_CEILING` in the same commit as the descriptions, with the measured numbers and the
margin named in the commit message. Do not delete or weaken the assertion; it is the thing that makes the
next growth visible.

### The static paragraph, in the live base prompt

The paragraph goes into **`ALFYAI_NEMOTRON_PROMPT`** (`src/lib/server/prompts.ts:5-99`) — the live base
prompt, which is what `getSystemPrompt("alfyai-nemotron")` resolves to (`prompts.ts:377-383`, called from
`normal-chat-context.ts:397`). It does **not** go under `### Files And Artifacts`: that heading exists only
in `LEGACY_ALFYAI_NEMOTRON_PROMPT_TOOL_TABLE` (`prompts.ts:107-236`, heading at `:182`), a retired snapshot
that `normalizeSystemPromptReference` replaces with the live prompt (`prompts.ts:357-370`). The live prompt's
`## Tools` section (`prompts.ts:41-47`) is where `produce_file` is already described, and the new paragraph
belongs beside it:

> You can also keep something as a Document, App, Canvas or Slides item beside the chat, so the user can
> come back to it and edit it with you. Offer one when they will return to the work; the tool descriptions
> say when, and which type.

Two sentences, no list, **unconditional** — not "appended when a flag is set", because the flag would change
the cached prefix. The list is on the tool, where the model reads it at the moment it has the schema in
front of it. (One caveat worth knowing, not fixing: an admin who has replaced `MODEL_1_SYSTEM_PROMPT` with
custom prompt text in settings does not get this paragraph; that is the existing override behaviour, and the
prompt text is still where the guidance should live.)

**The existing dead field must be noted, not used.** `buildOutboundSystemPrompt` declares and threads
`fileProductionToolsAvailable` (`normal-chat-context.ts:441`, `:1848`, `:1932`) and **nothing reads it** —
the only production setter is `chat-turn/shared-normal-chat-model-run-helpers.ts:355`, and `grep` finds no
reader anywhere. `shouldExposeFileProductionTools()` returns a hard `true`
(`normal-chat-tool-gating.ts:10-15`) with a comment saying the catalogue must not vary by turn. Task T6
deletes the dead field; either way, do **not** wire artifact guidance to a flag like that one; it is the
exact shape ADR-0055 removed.

### Evidence: where a made artifact appears

Ruling 6 governs the surface: **the Info popover shows counts and the message's Sources panel shows the
detail** (`ResponseAuditDetails.svelte` vs `MessageEvidenceDetails.svelte`, wired through
`MessageBubble.svelte`). An artifact that an answer drew on — and one the turn made — appears as an evidence
row there, labelled with its type. **No new popover row is invented**, and the parent spec's §6 phrase "the
Info popover rows" is read through this ruling. (If the owner ever wants a count row, it is one row in
`buildPrimaryRows()` in the existing `AuditRow` shape (`ResponseAuditDetails.svelte:28-40`,
`onSelect` at `:39`, the "Project files" precedent at `:159-171`, the `onOpenSources` prop at `:25`,
`MessageBubble.svelte:699-703` + `:1141-1148` + `:1237-1242`) — kept here as the shape, built only on
request.)

**An artifact's sources** are the web/document sources the model actually used, which the tool-call entries
already carry: a `create_artifact` or `edit_artifact` entry with `candidates` in its persisted
`ToolCallEntry` is the record, and the recorder already persists those into `messages.toolCalls` as
`ThinkingSegment[]` (`messages-types.ts:202-222`). So no new table:

```ts
// src/lib/server/services/artifacts/read-model.ts
export interface ArtifactSourceRef {
	id: string;
	title: string;
	url?: string | null;
	sourceType: EvidenceSourceType;
	/** Which tool call brought it in. */
	callId?: string | null;
}

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

They render in the panel through the **existing** `MessageEvidenceDetails.svelte` row: items with a
`url` are already links with a favicon (`:471-499`, favicon proxy `:201-206`), and items with an
`artifactId` become buttons into the shared workspace — **but only when the source type is `document`
today** (`isDocument()` at `:320-326` returns `item.sourceType === "document" && …`). That gate is the one
line this slice must widen…

**The widening (ruling 7, approved).** Add `"artifact"` to `EvidenceSourceType`
(`message-evidence.ts:770`) and one row each to the module-private
`GROUP_LABELS` (`message-evidence.ts:16-21`, EN **"Made in this chat"**) and `GROUP_ORDER`
(`:23-28`, after `document`, before `tool`), plus the type-icon case (`MessageEvidenceDetails.svelte:178-191`
— the `switch` has a `default: FileText`, so the compiler will *not* catch it: add the case by hand) and the
`isDocument()` gate. The union is additive (evidence is JSON in the message metadata), and every consumer is
a `Record`/`switch` that gains one branch.

Widening the record is necessary but **not sufficient to make a label user-visible**: the panel re-groups by
citation status, not by `sourceType` (comment and code at `MessageEvidenceDetails.svelte:68-100`), and
nothing in the app renders `MessageEvidenceGroup.label` — the string travels on the data model
(`message-evidence.ts:845-851`) and is persisted, but `MessageEvidenceDetails.svelte` never reads it (its
only uses of `groups` are `flatMap` at `:73` and a `.length` check in `MessageBubble.svelte:1143`). So the
**user-visible** word for an artifact row is the i18n type word below, and the server constant stays the
data-model label the group is keyed by. State that in the PR body rather than claiming the constant is what
the user sees.

```ts
// message-evidence.ts — the new group, built from the turn's own tool calls.
export interface TurnArtifactRef {
	artifactId: string;
	artifactKind: ArtifactKind;
	title: string;
}

export async function buildAssistantEvidenceSummary(params: {
	// …existing params (:700-718)…
	/** What this turn made or changed, derived in finalize-steps.ts from the turn's
	 *  completed create_artifact / edit_artifact calls (`metadata.artifactId`). */
	turnArtifacts?: TurnArtifactRef[];
}): Promise<MessageEvidenceSummary | null>;

// One group per turn, only when turnArtifacts is non-empty:
//   { sourceType: "artifact", label: GROUP_LABELS.artifact, reranked: false,
//     items: turnArtifacts.map((a) => ({
//       id: a.artifactId, title: a.title, sourceType: "artifact", status: "reference",
//       artifactId: a.artifactId, description: null, channels: ["tool"],
//       metadata: { artifactKind: a.artifactKind },   // the row's type word
//     })) }
```

`status: "reference"` is deliberate: it is what puts a made artifact in the panel's *Also found* bucket
rather than claiming the answer cited it. The thread: `finalize-steps.ts`'s `persistAssistantEvidence`
builds the summary (`:247`, the call at `:272`) — derive `turnArtifacts` there from `doneToolCalls`
(`:250-251`) and pass it in the same object, so the evidence write and `projectFilesRead` stay one write
(`updateMessageEvidence`, `:291`).

### The project bundle

`ProjectKnowledgeItem` is declared in `knowledge/project-knowledge.ts:42-56` (**not** in `knowledge/types.ts`,
where only `ArtifactType` (`:12-17`) and `ArtifactSummary` (`:60-86`) live) and already carries
`type: ArtifactType`, `sizeBytes`, `linkedAt` and `summary`; `listProjectKnowledge` is at `:307-327` and
orders through the module-private `sortItems` (`:296-305`, name → `linkedAt` → id, shared with the prompt
section and the read targets so the model's prefix cache keeps matching). The dialog is route-local:
`src/routes/(app)/projects/[projectId]/_components/ProjectFilesDialog.svelte`, with rows at `:306-355`
(`FileTypeIcon`, `formatFileType` `:96-110`, `formatSize` `:112-116`, `formatRelativeTime`, and the two
action buttons `project-file-preview` / `project-file-unlink`; the whole row is a `div`, not a button) and the
open path `preview()` at `:133-144` building `artifact:<id>` via `toWorkspaceDocument` (`:118-131`) — the
same id shape `MessageEvidenceDetails.openDocument()` builds (`:348-359`). `HomeSurface.svelte` counts the
bundle from `listProjectKnowledge` (`home-summary.ts:658-659`, field at `:106`; the quiet line at
`HomeSurface.svelte:257-272`, rendered `:1274-1282`).

Additions:

- **`ArtifactType` gains `"artifact"`** (`knowledge/types.ts:12-17`) — the value Slice 0 writes
  (`slice-0.md:262`: "the row is written with `type: "artifact"` … no DDL change") and the union the readers
  need. Shared with **Slice 0**, which lands first (see File ownership).
- **`ProjectKnowledgeItem` gains `artifactKind?: ArtifactKind` and `sourceConversationTitle?: string | null`**
  (`project-knowledge.ts:42-56`), both read from the artifact's `metadata_json.artifactType` and its
  conversation row — never a second column (`slice-0.md:263-265`).
- **`listProjectKnowledge` includes artifacts** linked to the project, ordered by the existing `sortItems`
  (`:296-305`). The resolution path already walks `derived_from` siblings and owned links
  (`readOwnedLinkRows` `:119-142`, `readDerivedSiblings` `:154-190`, `readOwnedArtifactRows` `:201-228`);
  artifacts join it through the same ownership condition, so no new query authority appears.
- **The row's provenance text**: `artifacts.bundle.fromChat` (`from “{title}” · {time}`) when the artifact
  came from a chat, `artifacts.bundle.projectFile` for an uploaded or generated file, and the type pill uses
  the UI's own word (Document / App / Canvas / Slides) — never `artifact`.
- **The row action opens the artifact panel**, not the document viewer: an artifact is edited in place, so
  opening it must land on the editor. `toWorkspaceDocument` stays for files.
- **`HomeSurface`'s bundle line counts artifacts too** — the count is literally
  `listProjectKnowledge(...).length` (`home-summary.ts:658-659`), so it follows automatically once the list
  includes them; the test asserts the two cannot disagree.
- **"Add a file to this project"** stays as it is; there is no "add an artifact" flow, because an artifact
  reaches a project by being linked from its chat. That is a scope decision, stated rather than implied.

**Type words, owned elsewhere, consumed here.** The five type names are **already committed** twice in the
plan: `artifacts.kind.*` in Slice 0 (`slice-0.md:496-500`) and `artifacts.type.*` in Slice 3
(`slice-3.md:775-779`), with identical values. This slice consumes `artifacts.kind.*` (Slice 0 lands first)
and adds no second family; the duplicate is reported as a cross-slice conflict, to be unified by whoever
owns the loser.

### i18n, with real strings

New keys live in `src/lib/i18n/artifacts.ts` — the module **Slice 0 creates** (`slice-0.md:928-929` wires
`src/lib/i18n/index.ts` and `src/lib/i18n.test-helpers.ts`; `I18N_MODULES` is at
`src/lib/i18n.test-helpers.ts:7-15`, `AUDITED_PREFIXES` at `:16-90`). EN and HU in the same commit.

| Key | English | Hungarian |
|---|---|---|
| `artifacts.bundle.fromChat` | `from “{title}” · {time}` | `a(z) „{title}” beszélgetésből · {time}` |
| `artifacts.bundle.projectFile` | `project file` | `projektfájl` |
| `artifacts.bundle.openA11y` | `Open {name}` | `{name} megnyitása` |
| `artifacts.sources.empty` | `Nothing recorded about where this came from.` | `Nincs feljegyzés arról, honnan származik.` |
| `artifacts.sources.loadFailed` | `Could not load what this was built from.` | `Nem sikerült betölteni, miből készült.` |
| `artifacts.evidence.madeInThisChat` | `Made in this chat` | `Ebben a beszélgetésben készült` |

Consumed, not added: `artifacts.kind.*` (slice 0), `messageEvidenceDetails.sourcesLabel` = `Sources` /
`Források` (`src/lib/i18n/chat.ts:866`, HU `:1970`) for the panel's own heading, and the refusal notices
Slice 1 owns (`artifacts.document.refused.*`, `slice-1.md:448-453`).

### Failure modes

| What happens | User sees | Code / payload |
|---|---|---|
| Model asks for an id this conversation does not have | nothing (model-facing) | tool returns `{success:false, error:"no_artifact_in_this_conversation", candidates:[…]}`; no HTTP status — tools never surface a transport error |
| Model patches a block the user changed since it last read it | the panel's existing refusal notice, naming the block (Slice 1) | per-op `reason: "block_changed"` inside a `success: true` payload with `applied`/`refused`; the rest of the batch applies |
| Model edits an App (no patch path) | nothing new | per-op refusal carrying Slice 2's explanation (`slice-2.md:736`: an App is edited by regeneration) |
| Sources read fails or the artifact was deleted while open | `artifacts.sources.loadFailed` in the panel; the stored evidence stays readable | `GET /api/artifacts/[id]/sources` → **404** for a missing or another user's artifact (the artifact routes' existing not-found convention); `{ sources: [] }` + 200 is "no sources", which shows `artifacts.sources.empty` |
| Catalogue read fails | nothing: the turn proceeds without the catalogue block | fail open, `catch → null`; the reason goes to the existing `[NORMAL_CHAT_CONTEXT]` log prefix (`src/lib/server/services/AGENTS.md:142`) — no new tag |
| An artifact is unlinked from a project while the bundle is open | the row disappears on the next list read; nothing is deleted | `unlinkProjectKnowledge` (`project-knowledge.ts:710`) is a link delete only |
| The bundle read fails | the dialog's existing failure path (Feature 1) | unchanged; this slice adds no new error surface |
| A harness fixture's response is missing or schema-stale on `--replay` | the run fails loudly, naming the fixture | non-zero exit; never a skip (see Risks) |

### Limits and configuration

| Value | Default | Read / enforced at |
|---|---|---|
| `ARTIFACT_CATALOGUE_MAX` | `12` | `artifacts/catalogue.ts`, asserted by test |
| Catalogue title clip | `60` chars | same |
| Artifact title cap | `200` chars | `createArtifactInputSchema` (above) |
| Patches / ops per call | `1…40` | `editArtifactInputSchema` (above); canvas also has `MAX_OPS_PER_DIFF = 40` and `MAX_NEW_NODES_PER_DIFF = 24` (slice-3.md:352-353), slides its own caps through `validateSlidePatch` |
| Version summary | `1…200` chars | `editArtifactInputSchema` |
| `TOOL_TIMEOUTS_MS` | `create 30_000`, `edit 20_000`, `read 10_000` | `normal-chat-tools/shared.ts:196` |
| `MAX_SAME_TURN_PRODUCE_FILE_SUBMISSIONS` / `MAX_PRODUCE_FILE_SUBMISSIONS_PER_TURN` | `2` / `6`, unchanged | `produce-file.ts:2744`, `:2753` |
| Catalogue token ceilings | raised once, with measured numbers | `index.test.ts:4824-4825` |
| Harness switches | see the harness section | `scripts/eval-artifact-contracts/config.ts` |

All of these are **hard-coded, not admin-configurable**, and that is deliberate: none of them is an operator
tuning knob, and threading one through `env.ts` → `config-store.ts` would put a prompt-shape decision in the
admin UI where a change could silently cost the prefix cache. If the owner ever wants one configurable, it
goes through `config-store.ts` (AGENTS.md Config rules) with `README.md` and `.env.example` updated.

---

## The eval harness

```
scripts/eval-artifact-contracts/          # Slice 0 creates this directory (slice-0.md:512-526); this slice fills it
  README.md            # the switches, the key rule, the gate table, how to add a fixture, how to re-record
  run.ts               # the runner: --suite, --replay (alias --skip-model), --limit, --only, --out, --help
  config.ts            # env switches, all EVAL_ARTIFACTS_* prefixed
  client.ts            # the one place the API key is read; nothing else touches it
  types.ts             # EvalCase / EvalAttempt / EvalVerdict (Slice 0's names) + the per-suite case types
  scoring.ts           # the pure scoring entrypoint (Slice 0 created it; this slice extends it) + scoring.test.ts
  cases.ts             # the case registry (Slice 0 created it empty; each type's slice appends)
  fixtures/
    apps/*.json  documents/*.json  canvas/*.json  slides/*.json  verification/*.json
    <suite>/known-bad/*.json          # must fail, asserted before any real response is scored
    <suite>/responses/*.json          # COMMITTED recorded model responses, for --replay
  suites/  apps.ts  documents.ts  canvas.ts  slides.ts  verification.ts
  results/            # GITIGNORED (`.gitignore`, pattern of :76): results.json, index.html, screenshots/
```

**Flag semantics** (one table, one implementation):

| Flag | Meaning |
|---|---|
| `--suite <name>` | `file`, `document`, `app`, `canvas`, `slides`, `verification`, or `all` — the singular names Slices 0–2 already use (`slice-0.md:946`, `slice-1.md:1099`, `slice-2.md:790`) |
| `--replay` | Re-score committed responses under `fixtures/<suite>/responses/`. **No model client is constructed**, no key is required. `--skip-model` is an accepted alias (the prototype's switch, `run.ts:9`) |
| `--limit <n>`, `--only <ids>` | Cap or select fixtures; `--only` takes comma-separated fixture ids |
| `--out <dir>` | Override `results/` |
| `--help` | Print the switch table |

**Env switches** (`config.ts`, modelled on the App prototype's table):

| Switch | Default | Meaning |
|---|---|---|
| `EVAL_ARTIFACTS_SUITE` | `all` | Same vocabulary as `--suite` |
| `EVAL_ARTIFACTS_ONLY` | — | comma-separated fixture ids |
| `EVAL_ARTIFACTS_LIMIT` | — | cap the fixture count |
| `EVAL_ARTIFACTS_REPLAY` | `0` | re-score committed responses, **no model call** |
| `EVAL_ARTIFACTS_SKIP_MODEL` | `0` | alias of replay |
| `EVAL_ARTIFACTS_SKIP_EVAL` | `0` | call the model, write raw responses, do not score |
| `EVAL_ARTIFACTS_THINKING` | `off` | App generation is thinking-off by decision (§2.9); the harness **asserts** it against the suite's own policy rather than offering a choice |
| `EVAL_ARTIFACTS_OUT` | `results` | output directory |
| `EVAL_ARTIFACTS_BASE_URL` / `_MODEL` / `_API_KEY` | — | provider override; the key falls back to `~/.config/opencode/opencode.json` (`client.ts` only) |

**Sampling**, identical to the App prototype so results are comparable: temperature 0.6, top_p 0.95, top_k
20, max_tokens 24000, streamed (`run.ts:29`, `:492-493`). Strictly sequential, one retry maximum, stop after
two consecutive 429/5xx (`run.ts:13-14`, `:215-255`).

**How each suite is scored — automatically, with no human in the loop.** Each suite is one pure function
`score<Suite>(attempt, fixture) → { verdict, reasons, facts }`, unit-tested in `scoring.test.ts` with no
model and no browser.

| Suite | What is called | What is measured | Pass bar |
|---|---|---|---|
| **1. `app`** (spec §4.1) | the App contract prompt, thinking off | the P1 pipeline unchanged: open in headless Chromium with network blocked and `window.alfy.storage` mocked, four loads, one smoke interaction, plus the four static contract checks (`no-script-src`, `no-link-href`, `no-remote-img`, `no-network-api` — Slice 2's `APP_CONTRACT_RULES`, `slice-2.md:156-172`) | the P1 baseline: **10/10 works** (`README.md:76`). Any `broken` verdict fails the suite; `works-with-glitches` is counted and reported against the baseline (verdict rules `score.ts:133-137`) |
| **2. `document`** (§4.2) | a real stored document + a real request → `edit_artifact`-shaped patches | fed through the **real** `applyPatchSet({ blocks, patch, snapshot })` / `applyDocumentPatch` (slice-1.md:249, `:312-314`): does it apply; does the refusal fixture (the user edited the block first) come back `block_changed` rather than applied; is every patch inside the requested scope (fixture-declared block ids) | every apply-fixture applies completely; every refusal-fixture refuses **only** the intended block (the other ops still apply, `applied + refused === ops.length`); zero patches outside scope |
| **3. `canvas`** (§4.3) | a real stored board + "arrange Saturday" → a `BoardDiff` | fed through the **real** `validateBoardDiff(diff, body)` (slice-3.md:361-376) — `{accepted, refused: [{index, op, reason}]}` — then a **rubric** over the resulting board: every requested item is on the board; ids are all resolvable; no node was moved out of the frame it belongs to; no two nodes overlap after the arrangement; labels are non-empty; nothing was removed that the request did not name | every diff parses; zero `invalid_data`/`cycle` refusals on a fixture that should apply; all rubric items true, for every fixture. The board is also screenshotted into the gallery for the owner's eye, but the verdict is the rubric |
| **4. `slides`** (§4.4) | a request → deck JSON | schema validity against `SlidesBody` (slice-4.md:132-141); layout ids in `LAYOUT_REGISTRY` (slice-4.md:213); language matches the request (the repo's own detector); **no invented number or proper noun** — every number and capitalised proper noun in the deck must appear in the supplied source material or be an arithmetic relation of values in it; caps respected (`MAX_SLIDES = 120`, `MAX_BULLETS_PER_SLIDE = 12`, `MAX_FIELD_CHARS = 400`, `MAX_NOTES_CHARS = 4000` — slice-4.md:352) | zero invalid decks; zero unregistered layouts; zero language misses; zero invented facts |
| **5. `verification`** (§4.5) | fixture pairs: a fabricated artifact body **and** its source material | Slice 2's `verifyApp` (`slice-2.md:225-233`) returns `AppVerification`; the score compares its `findings[]` against the fixture's declared answer — `{ expectedClass, claimContains }` per seeded bug, and `clean: true` for the negatives | every seeded bug appears in `findings[]` with the right `class`; **zero findings on the clean fixtures** |

**How the fact-verification pass is judged.** This is the suite with the most room to be vague, so it is
judged by outcome, not by wording. `AppVerification` has no `detected` flag and no `location`: it has
`checked`, `verdict: "clean" | "repaired" | "uncertain"`, and
`findings: { claim, problem, class }[]` with `class: "wrong_key" | "mislabelled_aggregate" | "wrong_unit" |
"other"` (`slice-2.md:225-231`). So the fixture declares expectations in that shape's terms:

```json
// fixtures/verification/apps-03-quiz-key.json (excerpt)
"expect": {
  "checked": true,
  "findings": [{ "class": "wrong_key", "claimContains": "B) 1918" }],
  "clean": false
}
```

A verifier that returns `verdict: "uncertain"` with the right finding still scores the finding; a verifier
that "notices something is off" without naming the class scores as a **miss**, because a miss is what it is.
`class: "other"` is a miss for a fixture whose bug is one of the three measured classes — the fixture says
which class it seeded. Clean fixtures must come back with **no** findings, which is what stops the suite
from being an alarm that is always ringing.

**How each slice is gated on its suite.**

| Slice | Gate |
|---|---|
| Slice 1 — Document | `--suite document` |
| Slice 2 — App | `--suite app` **and** `--suite verification` |
| Slice 3 — Canvas | `--suite canvas` |
| Slice 4 — Slides | `--suite slides` |
| this slice | `--replay --suite all`: every suite re-scores committed responses with no model call, so the gate is cheap and deterministic in CI |
| a prompt or tool-description change | `--suite all` against a real model, because a replayed response cannot measure a prompt change |

**The known-bad fixtures are the harness's own test.** Each suite commits at least one fixture that must
fail, with its declared failure written into the fixture:

| Suite | Known-bad fixture | It proves |
|---|---|---|
| `document` | a patch batch that applies a stale-hash patch instead of refusing it (`fixtures/documents/known-bad/ignores-stale-hash.json`) | the scorer reads the refusal codes and fails a silent overwrite |
| `document` | a batch touching a block outside the declared scope | the scope check is not decorative |
| `app` | an app whose only text is a heading and which has no controls; an app loading a remote script | the App checks can fail (`score.ts:50`, `:66`) |
| `canvas` | a diff that leaves two nodes overlapping; a diff that moves a node out of its frame | the rubric can fail |
| `slides` | a deck whose number does not appear in the source; a deck with an unregistered layout id; a Hungarian request answered in English | the fact/language/layout checks can fail |
| `verification` | a "verifier" that flags a clean fixture | the negatives have teeth |

`run.ts` runs the known-bad set **first**, and refuses to score the recorded responses unless every declared
one failed. That is the sentence that makes this a gate rather than a report, and it is asserted in
`scoring.test.ts` too (`it("fails a patch batch that applies a stale-hash patch instead of refusing it")`).

**The key rule, in one place.** `client.ts` reads `EVAL_ARTIFACTS_API_KEY`, else
`~/.config/opencode/opencode.json` (`README.md:54-55`), returns a client, and never returns or logs the key
— the `evaluate-tool-guidance-ab.ts:40-41` SECURITY pattern. `scoring.test.ts` greps every file under
`results/` for the key's shape and fails on a hit; `results/` is gitignored (`.gitignore:76` pattern) so a
run's artefacts cannot be committed by accident.

**The replay switch is the whole reason this is a gate and not a ritual.** A committed response set under
`fixtures/<suite>/responses/` is re-scored on every CI run for free; a real model run happens when the
contract or the prompt changed, and its raw responses are reviewed and committed with the PR. That makes the
harness's cost proportional to how often the contract changes rather than to how often someone pushes.

---

## File ownership

| File | Change |
|---|---|
| `src/lib/server/services/normal-chat-tools/artifact-tools/{create,edit,read}.ts` + tests | create — schemas, normalisation, payload builders, tool-call metadata |
| `src/lib/server/services/normal-chat-tools/index.ts` + `index.test.ts` | extend — register three tools, add six `TOOL_I18N` entries (EN+HU), raise the catalogue ceiling |
| `src/lib/server/services/normal-chat-tools/shared.ts` | extend — three `TOOL_TIMEOUTS_MS` rows (`:196`) |
| `src/lib/server/services/chat-turn/normal-chat-tool-gating.ts` + test | extend — the artifact tools in the fake catalogue; **no per-turn gating** |
| `src/lib/server/services/normal-chat-context.ts` + `normal-chat-context.test.ts` | extend — `artifactCatalogueBlock` param on `buildTurnGuidance` (`:611`), rendered in the sections array (`:636-651`), threaded through `prepareOutboundChatContext`'s params (`:1848` shapes) at `:2163`'s neighbour; **delete the dead `fileProductionToolsAvailable`** (`:441`, `:1848`, `:1932`) |
| `src/lib/server/services/chat-turn/shared-normal-chat-model-run-helpers.ts` | extend — resolve and pass the catalogue beside `skillCatalogueBlock` (`:326`, `:370`); drop the dead `fileProductionToolsAvailable:` assignment (`:355`) |
| `src/lib/server/prompts.ts` | extend — two sentences in `ALFYAI_NEMOTRON_PROMPT`'s `## Tools` section (`:41-47`) |
| `src/lib/server/services/artifacts/catalogue.ts` + test | create — `buildArtifactCatalogueBlock`, `listArtifactCatalogueEntries`, `resolveArtifactCatalogueBlock` |
| `src/lib/server/services/artifacts/read-model.ts` + test | extend — `getArtifactSources` |
| `src/lib/server/services/message-evidence.ts` + test | extend — `EvidenceSourceType` gains `"artifact"` (`:770`), one row in `GROUP_LABELS`/`GROUP_ORDER` (`:16-28`), `turnArtifacts` + the artifact group in `buildAssistantEvidenceSummary` (`:700-719`) |
| `src/lib/server/services/chat-turn/finalize-steps.ts` + test | extend — derive `turnArtifacts` from the turn's tool calls, pass it into `buildAssistantEvidenceSummary` (`:272`) |
| `src/lib/components/chat/MessageEvidenceDetails.svelte` | extend — `isDocument()` accepts `"artifact"` (`:320-326`), an `artifact` case in the icon switch (`:178-191`), the type word from `artifacts.kind.*` on the row |
| `src/lib/server/services/knowledge/types.ts` | extend — `ArtifactType` gains `"artifact"` (`:12-17`). **Shared with Slice 0** |
| `src/lib/server/services/knowledge/project-knowledge.ts` + test | extend — `ProjectKnowledgeItem` gains `artifactKind`/`sourceConversationTitle` (`:42-56`), artifacts in `listProjectKnowledge` (`:307-327`) |
| `src/routes/(app)/projects/[projectId]/_components/ProjectFilesDialog.svelte` | extend — artifact rows, provenance line, type pill, open-the-panel (`:306-355`, `preview()` `:133-144`) |
| `src/lib/components/home/HomeSurface.svelte` | extend — the bundle line's count follows `listProjectKnowledge` (`:257-272`) |
| `src/lib/i18n/artifacts.ts` + `artifacts.test.ts` | extend — the keys in the table above. **Shared with Slice 0** (it creates the module) |
| `AGENTS.md`, `src/lib/server/services/AGENTS.md` | extend — the ruling-5 doc fixes (three sites, Task T6) |
| `scripts/eval-artifact-contracts/**` | extend — the five suites, fixtures, known-bad set, responses, README; Slice 0 created the skeleton |
| `.gitignore` | extend — `scripts/eval-artifact-contracts/results/*`, pattern of `:76` |
| `package.json` | extend — `eval:artifacts` and `eval:artifacts:replay` scripts (`npx tsx …`) |
| `tests/cross-cutting/incognito-artifact-containment.test.ts` | extend — the catalogue read, the sources read, the bundle listing |

**Serialisation.** `src/lib/i18n/artifacts.ts`, `src/lib/i18n/index.ts`, `src/lib/i18n.test-helpers.ts` and
`knowledge/types.ts` are **shared with Slice 0, which lands first** (this slice only extends what Slice 0
creates). `message-evidence.ts` and `MessageEvidenceDetails.svelte` are shared with nothing else in Feature 2,
but the `EvidenceSourceType` widening (T4) reaches Slice 3's `liveweb` block and Slice 1's sources row, so
**do T4 last of the four product tasks**, against merged code rather than against four open branches.

---

## Tasks

### Task T1: The catalogue, the static paragraph, and the byte-identical proof

**Files:** `artifacts/catalogue.ts` + test, `normal-chat-context.ts` + test, `prompts.ts`,
`shared-normal-chat-model-run-helpers.ts`
**Test:** unit

- [ ] **Step 1: Write the failing tests**

```ts
// artifacts/catalogue.test.ts
it("builds no catalogue section for a conversation with no artifacts", ...);
it("lists at most ARTIFACT_CATALOGUE_MAX entries, newest first", ...);
it("clips a long title to 60 characters", ...);
it("ends with '(and N more in this chat)' when entries were dropped", ...);
it("carries the artifact id and the type name in every line", ...);
it("never says the word artifact in the section it renders to the model", ...);
it("returns only this conversation's artifacts", ...);
it("returns nothing for another user's conversation", ...);

// normal-chat-context.test.ts
it("keeps the system prompt byte-identical when only the message changes", ...);      // existing (:655-…) stays green
it("keeps the system prompt byte-identical when only the message language changes", ...);
it("changes the turn guidance when the conversation's artifacts change", ...);
it("leaves the turn guidance unchanged when only the message changes", ...);
```

- [ ] **Step 2: Run them to verify they fail**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run src/lib/server/services/artifacts/catalogue.test.ts \
  src/lib/server/services/normal-chat-context.test.ts
```
Expected: FAIL on the new cases; the existing byte-identical cases must stay green throughout.

- [ ] **Step 3: Implement**

`artifacts/catalogue.ts`, the `artifactCatalogueBlock` param and its one line in the sections array, the
resolver call beside `resolveSkillCatalogueBlock`, and the two sentences in `ALFYAI_NEMOTRON_PROMPT`. Do
**not** touch `buildOutboundSystemPrompt`'s structure, and do not introduce a flag.

- [ ] **Step 4: Run them to verify they pass**

```bash
npx vitest run src/lib/server/services/artifacts/catalogue.test.ts \
  src/lib/server/services/normal-chat-context.test.ts
```
Expected: PASS, including the pre-existing byte-identical cases (the ADR-0055 proof).

- [ ] **Step 5: Commit**

```
git add src/lib/server/services/artifacts src/lib/server/services/normal-chat-context.ts \
  src/lib/server/services/normal-chat-context.test.ts src/lib/server/prompts.ts \
  src/lib/server/services/chat-turn/shared-normal-chat-model-run-helpers.ts
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
it("keeps every description's negative clause in both languages", ...);   // NEGATIVE_CASE_MARKER, index.test.ts:4770
it("keeps the whole catalogue inside its prompt token budget", ...);      // index.test.ts:4920 — raise the ceiling once, here
it("does not change the catalogue between two turns with different messages", ...);
it("advertises the trimmed schema and validates with the full one", ...);
it("creates a document artifact with a version row and an alfy author", ...);
it("returns the new artifact's id and the version id", ...);
it("refuses to create an artifact in another user's conversation", ...);
it("refuses to create an artifact with an empty body", ...);
it("records artifactId, artifactKind and artifactTitle on the tool-call entry", ...);
it("reads back the block ids and hashes it just wrote", ...);
it("returns candidates and no body for an id this conversation does not have", ...);
it("reads a File-type id from this conversation and says the type", ...);
it("never returns a body belonging to another user", ...);
it("surfaces a domain failure as a model-safe string, not a stack", ...);
it("records one tool-call entry per call with its duration", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

Build the two modules, register them beside the existing tools, add the timeout rows. Follow
`read_generated_file`'s shape closely (`index.ts:1606-1645`): validate against an execution schema separate
from the advertised one, return a model-safe payload rather than going through the envelope for a validation
failure. Measure the catalogue and raise `CATALOGUE_TOKEN_CEILING` (`index.test.ts:4825`) in this commit, with
the measured numbers in the message.

- [ ] **Step 4: Run them to verify they pass**, plus
  `npx vitest run src/lib/server/services/chat-turn/normal-chat-tool-gating.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/server/services/normal-chat-tools
git commit -m "Let Alfy make something that outlives the reply

create_artifact and read_artifact are one call each and both are cheap: creating
writes a body the model just produced, reading returns the ids and hashes it will
need to edit. Reading before editing is the contract, so the read tells the model
what the edit will be addressed against. The catalogue's token ceiling moves once,
by the measured amount."
```

### Task T3: `edit_artifact`, the refusal path, and the type-choice guidance

**Files:** `artifact-tools/edit.ts` + test, `index.ts` + test
**Test:** unit + integration

- [ ] **Step 1: Write the failing tests**

```ts
it("applies a document patch batch and returns the version id", ...);
it("refuses a patch whose baseHash is not the block's current hash and applies the rest", ...);   // block_changed
it("returns one refusal per refused op with its target, label and reason", ...);
it("refuses a canvas op naming an id the board does not have", ...);                              // unknown_id
it("refuses a slides patch on a field the slide's layout does not have", ...);                    // layout_dropped_field
it("refuses an App edit with the regeneration explanation", ...);
it("refuses when neither patches nor ops is present", ...);
it("refuses when both are present", ...);
it("refuses a batch over 40 ops without applying part of it", ...);
it("never edits another user's artifact", ...);
it("records the summary as the version's one-line description", ...);
it("carries the guidance for every type in both languages", ...);
it("names produce_file as the path for a download in the description", ...);
it("names the four creatable types and never the word artifact", ...);
it("keeps the en and hu descriptions at parity in length and structure", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

Union-typed input, per-type dispatch into the same validators the ops routes use (`applyDocumentPatch`,
`validateBoardDiff`, `validateSlidePatch`), `applied`/`refused` in the payload. Then write the descriptions
— this is the task's real content, since ADR-0055 makes them the guidance. The EN and HU versions carry the
same six points in the same order.

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

**Files:** `artifacts/read-model.ts` + test, `message-evidence.ts` + test, `finalize-steps.ts` + test,
`MessageEvidenceDetails.svelte`, `src/lib/i18n/artifacts.ts`
**Test:** unit + integration + cross-cutting

- [ ] **Step 1: Write the failing tests**

```ts
it("returns the sources of a create_artifact call, in order, deduped by url", ...);
it("returns nothing for an artifact whose tool calls carried no candidates", ...);
it("never returns a source from another user's conversation", ...);
it("puts this turn's made artifacts in one group labelled Made in this chat", ...);
it("does not put a made artifact into the document group", ...);
it("gives the item sourceType artifact and status reference", ...);
it("carries the type word for the row in metadata, not the body", ...);
it("omits the group entirely for a turn that made nothing", ...);
it("keeps the evidence summary shape backward compatible for stored rows", ...);
it("does not carry an artifact body into the evidence summary", ...);

// component
it("renders an artifact item as a button into the shared workspace", ...);        // the isDocument() gate
it("renders the artifact's type word on the row in both languages", ...);
it("uses the artifact icon, not the default document icon", ...);                 // the icon switch
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL (the widening does not exist yet).

- [ ] **Step 3: Implement**

`getArtifactSources`, the `EvidenceSourceType` widening with its group row, `turnArtifacts` derived in
`finalize-steps.ts` from the turn's completed tool calls, the `artifact` branch in `MessageEvidenceDetails`,
and both languages. Re-run the containment suite: the catalogue read and the sources read are new places
artifact rows are queried by user, so PART B's guard must name them beside `getArtifactOwnershipScope`, or
the reads must go through that scope.

- [ ] **Step 4: Run them to verify they pass**

```bash
npx vitest run src/lib/server/services/message-evidence.test.ts \
  src/lib/server/services/chat-turn/finalize-steps.test.ts \
  tests/cross-cutting/incognito-artifact-containment.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/server/services src/lib/components/chat src/lib/i18n tests/cross-cutting
git commit -m "Show where an artifact's content came from, and that it was made at all

The sources were already in the tool-call record; this reads them out for the
artifact the call made, so no new table appears. A made artifact is evidence of
the turn it was made in, and it gets its own group because "Retrieved Documents"
would misdescribe a thing that did not exist before the turn started. The word
the reader sees is the type's own name, in their language."
```

### Task T5: The project bundle lists artifacts

**Files:** `knowledge/types.ts`, `knowledge/project-knowledge.ts` + test, `ProjectFilesDialog.svelte`,
`HomeSurface.svelte`, `src/lib/i18n/artifacts.ts` + test
**Test:** unit + integration + e2e

- [ ] **Step 1: Write the failing tests**

```ts
it("includes a project's artifacts in its bundle, ordered with its files", ...);
it("carries the concrete artifact kind from metadata, not a second column", ...);
it("labels a row with the chat it came from when it came from a chat", ...);
it("labels a plain file row as a project file", ...);
it("never shows the word artifact in a row", ...);
it("counts artifacts in the bundle's item line, from the same list", ...);
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

Widen `ArtifactType`, extend `ProjectKnowledgeItem`, `listProjectKnowledge` and its ordering, extend the
dialog's row rendering and its open action, and let `HomeSurface`'s count follow the list. The type pill
reuses `artifacts.kind.*`.

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

### Task T6: The two documentation corrections ruling 5 requires

**Files:** `AGENTS.md`, `src/lib/server/services/AGENTS.md`
**Test:** none (docs); the dead-field deletion is compile-checked by the gates

- [ ] **Step 1: Fix the file-production guidance claim in three places**

`AGENTS.md:69` and `AGENTS.md:224` say outbound file-production guidance lives in
`normal-chat-context.ts`. It does not: the text is in `src/lib/server/prompts.ts` (the live prompt's
`## Tools` section at `:41-47`, with six `produce_file` occurrences across the file) and in the tool's own
description (`normal-chat-tools/produce_file.ts`); `normal-chat-context.ts` consumes it and imports
`getSystemPrompt` at `:13`, `:397`. The same wrong claim appears a third time in
`src/lib/server/services/AGENTS.md:139` ("Normal Chat prompt note"). Reword all three to name both files for
what each does:

- `normal-chat-context.ts` — assembles the prompt from the base prompt, the recorded prompt name and the
  turn guidance;
- `prompts.ts` — owns the base prompt text, including the file-production guidance;
- `normal-chat-tools/produce_file.ts` — owns the model-facing `produce_file` contract.

- [ ] **Step 2: Delete the dead `fileProductionToolsAvailable`**

`buildOutboundSystemPrompt` declares and threads it (`normal-chat-context.ts:441`, `:1848`, `:1932`) and
nothing reads it; the only setter is `shared-normal-chat-model-run-helpers.ts:355`, which passes
`!params.disableTools && shouldExposeFileProductionTools({...})` into a field no code consumes. Delete the
field at all three declaration/threading sites and the assignment at `:355`, and leave
`shouldExposeFileProductionTools` where it is — it is still the documented reason the catalogue does not vary
by turn (`normal-chat-tool-gating.ts:10-15`). If any of the six byte-identical tests in
`normal-chat-context.test.ts:655-1027` passes that field, drop it from the call there too, in the same
commit.

- [ ] **Step 3: Run the gates the change touches**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run check && npx vitest run src/lib/server/services/normal-chat-context.test.ts
```
Expected: 0 errors, 0 warnings; the six byte-identical cases green.

- [ ] **Step 4: Commit**

```
git add AGENTS.md src/lib/server/services/AGENTS.md src/lib/server/services/normal-chat-context.ts \
  src/lib/server/services/normal-chat-context.test.ts \
  src/lib/server/services/chat-turn/shared-normal-chat-model-run-helpers.ts
git commit -m "Point the docs at the file that holds the words, and drop dead state

Outbound file-production guidance is written in prompts.ts and on the tool; the
context service assembles it. The doc lines said otherwise in three places. The
fileProductionToolsAvailable field was threaded through two param objects and a
call site and read by nothing, which is the shape ADR-0055 deleted, so it goes
rather than being carried forward."
```

### Task T7: The harness's scorers and its known-bad fixtures

**Files:** `scripts/eval-artifact-contracts/{config.ts,client.ts,types.ts,scoring.ts,scoring.test.ts,fixtures}/**`
**Test:** unit (the scorers), no model, no browser

- [ ] **Step 1: Write the failing tests**

```ts
// scoring.test.ts — every scorer against known-bad and known-good input
it("fails an app whose only text is a heading and which has no controls", ...);
it("fails an app that loads a remote script", ...);
it("passes an app with one working control and no console errors", ...);
it("fails a patch batch that applies a stale-hash patch instead of refusing it", ...);   // block_changed
it("fails a patch batch that touches a block outside the requested scope", ...);
it("fails a diff that leaves two nodes overlapping after an arrangement", ...);
it("fails a diff that moves a node out of the frame it belongs to", ...);
it("fails a deck whose number does not appear in the source material", ...);
it("fails a deck whose language does not match the request", ...);
it("fails a deck that uses an unregistered layout id", ...);
it("passes a deck whose numbers all derive from the source", ...);
it("scores a verifier that notices a wrong key but cannot classify it as a miss", ...);
it("fails a verifier that flags a clean fixture", ...);
it("fails the run when a known-bad fixture did not fail", ...);                          // the gate's own gate
it("never writes the api key shape into any file under results/", ...);
it("replays committed responses without constructing a model client", ...);
```

- [ ] **Step 2: Run them to verify they fail**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run scripts/eval-artifact-contracts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Write the scorers first (they are the part that must be trustworthy), then `config.ts`, `client.ts`, the
fixtures with their `expect` blocks, and the known-bad set. Each scorer is pure and takes
`(attempt, fixture)`; the "known-bad fixtures must fail" rule is enforced in `run.ts` **and** unit-tested
here. Commit the recorded response sets beside their fixtures so `--replay` works in CI; `results/` stays
ignored.

- [ ] **Step 4: Run them to verify they pass**

```bash
npx vitest run scripts/eval-artifact-contracts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add scripts/eval-artifact-contracts .gitignore
git commit -m "Make the artifact scorers fail before they are trusted to pass

Every suite ships a fixture that must fail, and the runner checks that before it
scores anything, because a rule that cannot fail is not a gate. The scorers are
pure functions over a recorded attempt, so they are unit-tested in CI with no
model and no browser."
```

### Task T8: The runner, the suites, the responses, and the README

**Files:** `scripts/eval-artifact-contracts/{run.ts,suites/*,README.md}`, `fixtures/*/responses/**`,
`package.json`
**Test:** the harness itself, in replay mode

- [ ] **Step 1: Write the runner and the five suites**

`--suite` / `--replay` (alias `--skip-model`) / `--limit` / `--only` / `--out` / `--help`, the env switches,
the sampling constants, sequential execution with one retry and the two-429/5xx stop, the gallery, and the
README documenting all of it plus how to add a fixture and how to re-record a suite.

- [ ] **Step 2: Verify the replay path is what CI runs**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx tsx scripts/eval-artifact-contracts/run.ts --replay --suite all
```
Expected: exits 0 with no key required; the known-bad fixtures fail as declared; the committed responses
score at or above each suite's bar; `results/index.html` builds. (Before any response set is committed this
exits 0 with an explanation of what is missing — Slice 0's "nothing configured" behaviour.)

- [ ] **Step 3: Commit**

```
git add scripts/eval-artifact-contracts package.json
git commit -m "Run the artifact suites from one switch table, and replay them for free

Replay re-scores committed responses with no model call, so the gate is cheap
enough to run on every push and the expensive run happens when the contract
changed. The runner refuses to score anything until every known-bad fixture has
failed."
```

### Task T9: The real-model run, the README's numbers, and the wiring

**Files:** `fixtures/*/responses/**`, the CI script, the PR body
**Test:** the harness against a real model, once

- [ ] **Step 1: Run the real-model harness for all five suites**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx tsx scripts/eval-artifact-contracts/run.ts --suite all
```
Sequential, one retry maximum, stop after two consecutive 429/5xx.

- [ ] **Step 2: Read the result before committing it**

Record the per-suite verdict counts in the PR body, with the failing fixtures named. The API key does not
appear in any file, in any log, or in the PR body. If a suite is below its bar, **the design for that type
changes rather than the bar** (spec §8 risk 1, ADR-0066): the named fallback is that Alfy proposes and the
user approves. That is an owner decision; stop and ask.

- [ ] **Step 3: Commit the responses and the README's measured table**

- [ ] **Step 4: Confirm the wiring**

`package.json` runs the replay form in CI and the live form never runs in CI; `npm test` does **not** run the
live harness (`scripts/eval/README-option-a-fidelity.md:36-48`'s split).

- [ ] **Step 5: Commit**

```
git add scripts/eval-artifact-contracts package.json
git commit -m "Record what the model actually did, so the gate is re-runnable

A replayed response cannot measure a prompt change, and a live run costs money on
every push. Both exist: the responses are committed and re-scored for free, and a
real run happens when the contract or the descriptions changed."
```

## Non-goals

- **No fourth tool.** `create_artifact`, `edit_artifact` and `read_artifact` are the whole surface. In
  particular, no `delete_artifact` (deletion is the user's, in the panel) and no `link_artifact_to_project`
  (linking is a user action in the bundle).
- **No new Info popover row.** Ruling 6: counts stay where they are, artifacts appear in the Sources panel.
- **No artifact guidance pack, and no flag that switches guidance on.** ADR-0055 deleted that machinery.
- **No prompt caching changes.** The catalogue rides with the turn guidance; the cached prefix is untouched.
- **No new `EvidenceSourceType` beyond `"artifact"`** (ruling 7 approves that one).
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
| Guidance lands somewhere message-conditioned | It fails `normal-chat-context.test.ts`'s byte-identical assertions, or worse, passes review and costs the prefix cache | The rules live on the tools; the catalogue is a fact in turn guidance, resolved from the conversation (never the message); T1's step 4 runs the byte-identical cases explicitly |
| The catalogue grows without bound | A 40-artifact conversation pays for a 40-line prompt on every turn | Capped at 12 with a visible `(and N more)`, and a test asserts the cap |
| A tool's patch validator diverges from the route's | Two answers to "does this apply", and the user's own edit loses | Model-facing patches and ops are `z.unknown()`; the per-type validators are the only authority, and their reason unions are imported rather than restated |
| The catalogue token ceiling is "fixed" by deleting the assertion | The next description growth becomes invisible, and the prefix budget drifts | The ceiling may only move up, in a reviewed commit, with the measured numbers in the message |
| The harness cannot fail | It becomes decoration, and a type ships on an unmeasured contract | Every suite ships a known-bad fixture the runner asserts fails first |
| The key leaks into `results/` or a fixture | It is in the repo's history | One function reads it; a test greps `results/` on every invocation; `results/` is gitignored |
| The `EvidenceSourceType` widening breaks a stored row | Evidence is JSON in `messages.metadata_json`, so an old row has no `artifact` items and stays readable | Additive union, one new group row, and a backward-compatibility test on a stored summary |
| The artifact group's server label is assumed to be user-visible | It is not rendered anywhere today; a UI claim built on it would be false | The row's word comes from `artifacts.kind.*`; the server constant is documented as the data-model label, and the PR body says so |
| The bundle shows made things as files | The user cannot tell what they are looking at, and the row opens the wrong surface | Provenance label plus the UI's own type word; the row opens the panel; an e2e asserts the destination |
| Replay scores a stale response set | CI passes on responses that no longer match the schema | The README requires re-recording whenever the contract or a description changes, and `--replay` fails on a schema mismatch rather than skipping |
| Suite 3's rubric becomes a taste argument | "A board a human would accept" is exactly the vague thing risk 1 warns about | The rubric is mechanical: requested items present, ids resolvable, no node outside its frame, no overlapping nodes, non-empty labels, nothing unnamed removed |

## Verification checklist

- [ ] Every task's tests were seen failing first, then green.
- [ ] `npm run check` — 0 errors, 0 warnings.
- [ ] `npx biome check src scripts tests` — clean (scope it to those three directories; nested agent
      worktrees under `.claude/worktrees` break the repo-root biome run).
- [ ] `npm test` — green, including the harness's scorer tests and the i18n key parity test.
- [ ] `npm run build` — 0 warnings.
- [ ] `npx fallow --no-cache --format json --quiet --score` — no new findings, no new ignores.
- [ ] `npx vitest run src/lib/server/services/normal-chat-context.test.ts` — green, including the six
      pre-existing byte-identical cases (the ADR-0055 proof).
- [ ] `npx playwright test tests/e2e/artifacts-panel.spec.ts tests/e2e/artifact-document.spec.ts tests/e2e/chat.spec.ts tests/e2e/projects.spec.ts` — green.
- [ ] `npx tsx scripts/eval-artifact-contracts/run.ts --replay --suite all` — green, with no key required,
      and the known-bad set failing as declared.
- [ ] A real-model `--suite all` run was made, its per-suite verdicts and failing fixture names are in the
      PR body, and its responses are committed.
- [ ] **Real-app visual check** at **1440×900 and 390×844, light and dark**: an artifact's evidence row
      shows its type word, is keyboard-reachable in row order, and opens the panel; the project bundle's
      artifact row is labelled with its provenance and type and opens the panel; nothing overflows.
- [ ] **Staging, real model:** ask for a trip plan → Alfy makes a Document, the reply says what it made, the
      card appears; ask for a deck → Slides; ask for something to arrange → Canvas; ask for "a PDF" →
      `produce_file`, not an artifact. Ask in Hungarian and confirm the type names and the text are
      Hungarian.
- [ ] **Staging:** read an artifact, change a block by hand, then ask Alfy for a change to that block →
      refused with the reason visible, and the other changes applied.
- [ ] **Staging:** link an artifact to a project from its chat and see it in that project's bundle with its
      provenance.
- [ ] **Staging:** an artifact made in an **incognito** chat is not in the catalogue next to a normal chat,
      is not in the library, and is not cited later.
- [ ] Read the staging service journal for new warnings.

## Open questions for the owner

1. **A count row for made artifacts in the Info popover.** Ruling 6 says no new popover row, and this slice
   follows it — the artifact appears in the Sources panel with its type, and the popover is untouched. The
   *recommendation* is to keep it that way: the popover's rows are all counts of things that happened
   *inside* the answer, and "made in this chat" is a thing that now exists beside it. If you want the count
   anyway, it is one row in the same table (`ResponseAuditDetails.svelte:159-171`) plus
   `artifacts.infoMade` / `infoMadeValue` / `infoMadeValueOne` in both languages — say so and T4 grows by a
   step.
2. **Human review in the harness.** Suite 3 has a rubric (`no overlaps`, `ids resolvable`, and so on) that
   is mechanical, but "arrange Saturday" is a request where a human would also say *whether it is an
   arrangement they wanted*. The gallery screenshot is there for that eye. Recommendation: keep the rubric
   as the gate and add a per-fixture `humanVerdict` field that is **recorded but never scored**, so the eye
   has a place to write without turning taste into a pass bar.
3. **Suite 1's baseline.** The App suite's bar is the P1 result (10/10 works). Recommendation: the absolute
   count, with a ratio recorded beside it — an absolute bar is what stops a slow drift, and the ratio is the
   number to look at when the model or a dependency changes and the absolute count moves.
4. **The duplicate type-word key families.** Slice 0 ships `artifacts.kind.*` (`slice-0.md:496-500`) and
   Slice 3 ships `artifacts.type.*` (`slice-3.md:775-779`) with identical values; this slice consumes
   `artifacts.kind.*` because Slice 0 lands first. Recommendation: unify on `artifacts.type.*` (the surface
   that reads it per type is the card and the panel) and have Slice 0's five rows removed in the slice that
   owns them — not by this slice, which would then be editing another slice's file.
