# Feature 2 — rulings on the slice specs' open questions

When the slice specs were drafted, nine places were ambiguous or contradictory. Each was reported rather
than decided silently; the rulings are below. **Where a ruling and a slice spec disagree, this file wins**,
and the slice spec should be corrected in the same commit that touches it.

## 1. Comments are never part of an artifact body

The parent spec's §3 body list mentioned `comments` for Canvas; §2.7 and the `artifact_comments` DDL make
comments one shared table. **The table wins.** A body carries only what the artifact *is* — for Canvas
`{nodes, edges, viewport, annotations}`; comments, versions and per-App key-value state are rows keyed by
`artifact_id`. The spec's §3 body list is corrected to match.

## 2. Slides: layouts are code-owned, the body carries the deck

`{layouts, slides[]}` is read as *deck theme and aspect*, not body-defined layouts. The layout set is fixed
in code (title, section, bullets, two-column, image, quote, closing); a body may choose among them and set
theme values, never define new ones. Rationale: fixed layouts are what makes PPTX export reliable, and it
keeps the model's job to content.

## 3. Slides export: PPTX in v1, PDF deferred

The mockup's export matrix said "PPTX · PDF"; slice 4 said PPTX only. **PPTX only in v1.** There is no PPTX
renderer in `file-production/` today (only output validation), so slides export through
`sourceMode: "program"` using `python-pptx` (confirmed present in `SANDBOX_PYTHON_PACKAGES`); a PDF of a
deck is a second renderer and is a stated non-goal of slice 4. The mockup line is corrected to "PPTX" and
PDF is recorded as deferred, not forgotten.

## 4. Tours: code-owned defaults, campaign override

ADR-0012's campaigns are immutable snapshots with required crops, which a per-type tour cannot be. Ruling:
each tour's **structure and trigger are code-owned**, with shipped default text and illustration; a tour may
be **overridden by a published campaign** carrying a new `summary` layout value (one line of body text
under the artwork). The owner's decision stands: the text is editable, the trigger is not.

## 5. Tool guidance lives on the tools, and a doc claim is wrong

ADR-0055 wins over the handoff brief's shorthand: the model-facing **rules go on the tool** (schemas and
descriptions in `normal-chat-tools/`); what belongs in the turn guidance is only the **catalogue** — that
these tools exist this turn. Two documentation fixes fall out of this and must land with slice 5:

- `AGENTS.md`'s line that outbound file-production guidance lives in `normal-chat-context.ts` is wrong —
  the text is in `src/lib/server/prompts.ts` (6 occurrences; zero in `normal-chat-context.ts`), consumed by
  normal-chat context assembly. Reword it to name both files for what they do.
- `fileProductionToolsAvailable` is declared and threaded (`normal-chat-context.ts:441,1848,1932`) but
  nothing reads it. Confirm during slice 5 and either read it or delete it; do not carry dead state forward.

## 6. Artifacts appear as evidence through the existing Sources surface

The brief's "Info popover rows" were never in the parent spec. The ruling follows Feature 1's settled
design: the Info popover shows **counts**, and the message's **Sources panel** (`ResponseAuditDetails` /
`MessageEvidenceDetails`) shows the detail. An artifact that an answer drew on appears there as an evidence
row labelled with its type. No new popover row is invented.

## 7. Widening `EvidenceSourceType` is approved

Showing a made artifact as evidence means adding a case to `EvidenceSourceType`
(defined in `message-evidence.ts:770` — *corrected; an earlier draft named `messages-types.ts`, which only
re-exports it*), which is an exhaustive union consumed by `GROUP_LABELS` and `GROUP_ORDER` in
`message-evidence.ts` — so the compiler enforces that the new case is handled everywhere. Do it in the
slice that first surfaces artifacts as evidence (slice 5), with a test per group label.

## 8. Four tours, not five

**File gets no tour.** `produce_file` already exists and File is not a new kind; a tour would explain
something the user already knows. Tours ship for Document, App, Canvas and Slides, and the parent spec's
"each type shows a tour" is read as the four new types.

## 9. The performance gate: structural in CI, measured locally for the figure

A strict "≥ 60 fps" assertion cannot be honest on a shared CI runner. Ruling:

- **CI asserts structural budgets** — board JSON size, node and stroke counts, and a timing ceiling with a
  generous margin, all deterministic and machine-independent.
- **The 60 fps figure is a local, recorded measurement** (the prototype's `_probe.mjs` already produces it:
  163 nodes + 202 annotations at 8.3 ms average frame). Slice 3's spec must say which of the two a failing
  check means, so nobody "fixes" a slow CI runner by weakening the product.

## 10. The panel keeps its path and name: no rename in this feature

`slice-6.md` calls the panel `ArtifactPanel.svelte`; slices 0 and 3–5 keep
`document-workspace/DocumentWorkspace.svelte`. **Keep the existing path and name.** Three live callers render
it, and one source-scan suite pins the path (`src/lib/shared/file-types/no-ad-hoc-maps.test.ts:164`;
*corrected — an earlier draft of this ruling also cited `DocumentsList.test.ts`, which does not pin it*), and the
same shell serves surfaces that are not artifacts at all (generated files, chat attachments, library opens,
search-result opens). Renaming it is a separate, reviewed change with the callers and the pinning tests
updated together — not part of Feature 2. `slice-6.md`'s four references are corrected to the real path.
The glossary's **Artifact Panel** names the surface, not the filename.

## 11. One comment layer: shared interface, per-type anchor resolvers

`slice-3.md` proposes `src/lib/shared/artifacts/comments.ts`; `slice-1.md` keeps its own anchor modules. Per
§2.7 there is **one** comment feature, split like this:

- **Threads, status, replies and the `@Alfy` hook** — `src/lib/server/services/artifacts/comments.ts`
  (Slice 0), over the single `artifact_comments` table. No slice opens its own columns or its own thread
  logic.
- **The anchor interface** — one small shared type (`Anchor`, `AnchorResolution` with `exact | moved |
  orphaned`) in `src/lib/shared/artifacts/`, implemented **per type**: the Document resolves `text` anchors
  against its block index (`slice-1`'s `anchor.ts`), the Canvas resolves `node` and `point` anchors against
  its board (`slice-3`). Slice 3's `comments.ts` becomes that interface plus the canvas resolver, and it
  must not reimplement resolution the Document already owns, or vice versa.
- Both resolvers are pure and unit-tested against the same three outcomes, including the orphan.

## 12. The hash substrate needs a canonical form, pinned by a test

`slice-1` hashes **canonical block Markdown** rather than ProseMirror JSON (which is unreachable
server-side). That is right, but the prototypes measured that the Markdown round trip is **not
byte-identical** — reopening the document rewrote six table lines' padding and blank lines. Hashing the raw
serialiser output would make a hash change on a mere open, and every patch would be refused as "you changed
this block".

Ruling: define one **canonical block form** used for hashing (trimmed lines, collapsed table padding,
normalised list markers, no trailing blank lines), document it next to the hasher, and pin it with a test:

> open → serialise → reload → serialise, with **no user edit**, produces identical hashes for every block.

That test is a gate on slice 1, and the canvas body's `body_hash` (slice 0's version rows) uses the same
canonicalisation rule for JSON (stable key order).

## 13. The write route takes `body`, not `markdown`

Slice 1's body route carried `{markdown, expectVersion}`, but Canvas and Slides write JSON bodies — so the
field name would lie for three of five types. **Every type's write route takes `body`** (plus
`expectVersion`); a Document's body happens to be Markdown. No alias, no per-type field name.

## 14. One ops module, per-type vocabularies

Slices 3 and 4 both wanted to create `ops.ts` (the id-addressed change application). **One shared module**
owns the generic mechanism — `src/lib/shared/artifacts/ops.ts`: parse an ops envelope, validate it against a
supplied op vocabulary, apply it to a document in order, and return per-op results (`applied` / `refused`
with a reason). Each type owns its **vocabulary** in its own file: `board-ops.ts` (Canvas),
`deck-ops.ts` (Slides), with the Document's block patches staying in slice 1's patch engine. Slice 3 creates
the shared module; slice 4 extends nothing in it.

## 15. The component directory is `src/lib/components/artifacts/` (plural)

Slice 3 uses the plural, slices 4 and 6 the singular. **Plural wins** — consistent with the existing
`campaigns/` and `instructions/`. Slices 4 and 6 are corrected in the review pass.

## 16. Undo semantics, the perf gate, and two blocks that need review attention

- **Undo has two meanings and both are kept.** The canvas's in-session undo/redo (Ctrl/Cmd+Z) reverses your
  own recent steps and strokes and is transient by design, exactly as the prototype had it. Undoing an
  Alfy change, or any change from an earlier session, is **version restore** through History. The two are
  labelled differently in the UI so they cannot be confused, and the spec says which is which.
- **Ruling 9 is amended.** CI asserts the structural budgets and a **loose** timing ceiling only (average
  frame under 33 ms across the scripted pan sweep — roughly four times the measured 8.3 ms, so it catches a
  catastrophic regression without failing on a slow runner). The real fps figure is produced by the probe
  script and recorded in the pull request body, not asserted.
- **Photos and live web are explicit review focus** in slice 3. They have the least reuse from the chat
  (no reusable photo or live-result component exists), so they are new work and reviewers must look at them
  first.

## 17. `artifact_kv` uses a surrogate key, not a composite primary key

The repo has **no** composite primary keys (`schema.ts` never imports `primaryKey`; every table uses
`id: text("id").primaryKey()`). So `artifact_kv` gets a surrogate `id` plus a **unique index** on
(`artifact_id`, `key`) — matching the house idiom instead of introducing a first-of-its-kind pattern.

## 18. File stays `generated_output`; the File type is presentation

Produced files must keep `type = "generated_output"`: `knowledge/store/core.ts:218` excludes that type from
canonical ownership and `account-lifecycle/index.ts:94` keys "Clear memory and knowledge" on it. The File
type is therefore a **presentation** of existing rows in the new card and panel, never a reclassification.
The spec's "one new artifact type value" applies to the four **new** types only.

## 19. An auth test names its layer

`requireAuth` **redirects** (302), so a route-handler-level test must assert the redirect; an HTTP-level test
asserts **401**, which is what `hooks.server.ts` returns for an unauthenticated API request (it distinguishes
API calls from browser navigations). Both behaviours are correct in their own layer — a slice that asserts
the wrong one is testing nothing. Every slice that covers authentication says which layer it is testing.

## 20. Naming that avoids a collision, and the UI labels

- Our card summary type is **`ArtifactCardSummary`**. `ArtifactSummary` already exists in
  `knowledge/types.ts:60`, and importing it in `conversation-detail` under an alias hides which type is in
  play — rename ours instead.
- UI labels are confirmed per ADR-0066: Document / Dokumentum, App / Alkalmazás, Canvas / **Tábla**,
  Slides / Diasor, File / Fájl.

## 21. Shared files have one owner

- **`AGENTS.md` and `src/lib/server/services/AGENTS.md` belong to slice 5** (three factually wrong sites:
  `AGENTS.md:69`, `AGENTS.md:224`, `services/AGENTS.md:139`). No other slice edits them.
- **E2E fixtures for produced files are seeded directly through `db`**, as other specs already do — there is
  no stream-body fixture for a produced file, and building one is not this feature's work.

## 22. One i18n family for types

Slices 0 and 3 both shipped type labels (`artifacts.kind.*` and `artifacts.type.*`) with identical values.
**`artifacts.type.*` wins** — the domain term is Artifact Type (`CONTEXT.md`) — and it is owned by slice 0;
slice 3's keys collapse into it.

## 23. Raising the tool-catalogue budget is allowed, once and measured

The EN tool catalogue has roughly **7 tokens** of headroom (`normal-chat-tools/index.test.ts:4820`), and this
feature adds three tool schemas. Raise the ceiling **once**, in the commit that adds them, with the measured
token counts in the commit message and the test updated in the same change. Keep the same discipline
afterwards: byte-identical prefixes, short descriptions, compact schemas.

## 24. App key-value rows are archived, and erased

An App's stored data can be real user content — a cost splitter's expenses, a tracker's ticks — so
`artifact_kv` rows are **included in the account data archive** as readable JSON per artifact, and deleted on
erasure. (An earlier recommendation was to exclude them as machine state; user content wins.)

## 25. The evaluation harness's scoring rules

Confirmed from slice 5's proposals: a **human verdict is recorded but not scored** (suite 3); suite 1's bar
is an **absolute count plus a ratio**, not a bare percentage; every suite runs **known-bad fixtures that must
fail** before its scores count, so the harness can be seen to fail; and `client.ts` is the only module that
reads the API key.

## Consequences for the slice specs (cumulative)

- Slice 3: body list loses `comments`; the perf gate is split as §9.
- Slice 4: PPTX only; layouts fixed; the mockup's export line corrected.
- Slice 5: tool guidance on the tools; the two `AGENTS.md` fixes; `EvidenceSourceType` widening with tests;
  artifacts as evidence rows, not new Info rows.
- Slice 6: four types, code-owned structure with a campaign override and the `summary` layout.
