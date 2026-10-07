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

## 26. The panel end-to-end spec is `tests/e2e/artifacts-panel.spec.ts`

Slices 0 and 3 disagree (`artifact-panel` vs `artifacts-panel`). **Plural wins**, matching
`src/lib/components/artifacts/`. Slice 0 is corrected in the review pass.

## 27. Slices reference each other by section, never by line number

Slice 3 cites slice 4 by line numbers, which a rewrite invalidates (it already has). Cross-slice references
name the **heading** (`slice-4.md §The deck contract`), not a line. The stale citations in `slice-3.md` are
fixed in the consistency pass.

## 28. Deck exports are not remembered; notes are same-device; PDF stays deferred

- **A deck does not track its exports** in v1: the read model does not expose `idempotencyKey`, so there is
  nothing to match an export against. Deferred, not designed around. (*Citation corrected: an earlier draft
  pointed at `read-model.ts:491`, an accessor; the identifier appears nowhere in that file, though the
  substance — the read model does not carry it — holds.*)
- **Presenter notes are same-device** (a presenter view on the screen you are presenting from). The mockup's
  "read them from your phone" would need a second device seeing the same artifact, which needs the sharing
  ADR-0066 rules out.
- **PDF export of a deck stays deferred** (ruling 3, confirmed) — PPTX only.

## 29. The migration story, precisely — and a list nobody remembered

Two slices described this differently; both are half right, and the verified picture is:

1. **`verify-migrations.ts` errors** (exit 1) when a table in `schema.ts` has no migration file — this runs
   as `npm run check:migrations`, and `npm start` runs it before serving.
2. **`prepare-db.ts` throws** after migrating if the runtime database is missing required schema pieces
   (`scripts/prepare-db.ts:804-808`, pinned by its test).
3. **`verify-migrations.ts` only warns** about a table that is absent from prepare-db's
   `requiredExistingTables` list.

So every new table needs three things, not two: the migration with its `_journal.json` entry, **and** an
entry in `requiredExistingTables` (`scripts/prepare-db.ts:74-82`). Slice 0 adds all three tables there in the
same commit.

## 30. Tours are Slice 6's, all four together

`plan.md` assigns tours to slice 5 in three places and `slice-0.md` gives each type's tour to that type's
slice. **Ruling 8 and slice 6 win:** all four tours are Slice 6's, landed last, because they depend on the
four types existing and on the campaign machinery being adapted once. `plan.md` and `slice-0.md` are
corrected in the consistency pass.

## 31. Shared test suites: created once, appended to

**Corrected:** `tests/cross-cutting/incognito-artifact-containment.test.ts` already exists in-tree (669
lines), so slice 0 **extends** it rather than creating it; the panel e2e spec is created by slice 0. Later
slices append a case to either, in serialisation order — append-only, never restructure. `plan.md:174`
reserving the containment suite to slice 0 is corrected to say "extended by 0, appended by 5 and 6".

## 32. Tour replay lives in the panel, and a real defect must be fixed first

The version badge stays **announcement campaigns only**. Tour replay is offered **in the panel** (the
artifact list's menu and the type's empty state), which avoids rewriting the header. This is not cosmetic: a
published tour would otherwise be picked up by `getLatestPublishedCampaign`
(`announcement-campaigns.ts:1137-1151`), which has **no type predicate** — it would hijack the sidebar badge
and record a spurious replay. The predicate fix is part of slice 6, with a test that a published tour never
becomes the badge's campaign.

## 33. Tour state follows the user, and incognito sees nothing

- The per-user "seen" state is **user-scoped data**: it joins the account data archive and is removed on
  erasure (unlike campaign state, which is app-owned).
- **An incognito chat never shows a tour.** A tour is a write, and incognito promises none.
- **No "don't show again" switch** in v1: a tour already shows once per type per user, so a switch would add
  a settings row for nothing.

## 34. The spec gains its Slice 6

The parent spec's §6 listed slices 0–5 and never mentioned tours, so slice 6 had no hook in the document
above it. A **Slice 6 — first-open tours** paragraph is added, and the mockup is cited as section 7 (an
earlier draft said section 6).

## 35. The Document's engine lives in `src/lib/shared/artifact-document/`

Confirmed: the Document's pure engine (block model, patch engine, canonical hasher, anchor resolver, tracker
chips, sidecar) lives under `src/lib/shared/artifact-document/`, its editor components under
`src/lib/components/artifacts/document/`, and slice 0's `types.ts` **re-exports the shared `Anchor` type**
(one line, type-only) instead of declaring a second union. Two unions for one concept is how they drift.

## 36. An exported checklist shows ticks, not `[x]`

Slice 1 found that the document-source `list` items are plain strings, so a checklist exports as
`[x] Book tickets` — in a PDF, which is exactly the artefact people print. The agent recommended accepting
it for v1; **overruled.** Add an **optional** `checked?: boolean` to the document-source list item and teach
all four renderers (PDF, DOCX, HTML, Markdown) to draw a real checkbox or tick, with a test per renderer.
The envelope stays version 1 because the field is optional, and the same improvement reaches today's
`produce_file` output.

## 37. Four defects slice 0 must lose in the consistency pass

Slice 0's deepened file contradicts rulings in four places, each found by a sibling slice:

1. It declares its own anchor union (`slice-0.md:429-433`) — remove it in favour of the shared type
   (ruling 35).
2. `ArtifactMetadata.idIndex` has no writer — either write it or drop it; dead state is not allowed to ride
   along.
3. Its `artifact_kv` Drizzle block still declares a composite `primaryKey` (`slice-0.md:264`) — ruling 17
   says a surrogate `id` plus a unique index.
4. `slice-0.md:870` contradicts ruling 24 (App key-value rows are archived, not excluded).

These are the consistency pass's first four fixes, and it must check every other slice file for the same
class of drift.

## 38. The "29%" figure in the spec is the unfixed prototype's

The parent spec's §5 says the prototype's mobile toolbar "took 29% of a 390 px viewport" — measured at 780 px
of height, which is the *unfixed* number. Slice 1 carries the budget that matters: 226 px before, **137 px
after** at 844 px, with the type's own toolbar layout. No decision changes; the spec's sentence is clarified.

## 39. Our artifact routes return 401, like `campaign-assets` does

**Amended 2026-09-25.** The repo already has the right tool: `requireApiUser`
(`src/lib/server/api/auth.ts:14-21`) is documented as the API sibling of `requireAuth` — same job, but it
throws `error(401)` itself, which SvelteKit renders as JSON from a `+server` endpoint. **The artifact routes
use `requireApiUser`.** Catching a redirect is not the pattern; an earlier draft of this ruling proposed it
before the helper was found. Ruling 19's layering note stands: tests assert **401 at the HTTP layer**, and no
slice writes its own auth check.

## 40. `create_artifact` gets 120 s, in one place

Slice 1 said 10 s, slice 5 said 30 s — and a **missing row means no timeout at all**
(`normal-chat-tools/shared.ts:343-350`), which is worse than either. App generation costs roughly 113 s
(generation plus the verification pass), so the canonical `TOOL_TIMEOUTS_MS` row is **120 000**, owned by
slice 5's registry; slices 1 and 2 reference it rather than restating it. Closing the "missing row means no
timeout" hazard is worth a look while that table is open.

## 41. `normal-chat-tools/index.ts` lands in one order

Three slices touch it. **Slice 5 first** (the tool registry, the catalogue and the timeout table), **then
slice 2** (the App generation path — the first real user of `create_artifact`), **then slice 1** (the
Document's `read_artifact` / `edit_artifact`). Each appends its own tool and its own timeout row; nobody
restructures what an earlier slice landed.

## 42. The App's `.html` export is a download, and Clear Memory still deletes Apps

- **Download-only.** The shared preview path renders HTML through a weaker profile
  (`preview-runtime/index.ts:303`, `DocumentPreviewRenderer.svelte:205-209`), so the export is served with
  `Content-Disposition: attachment` and never previewed. The *panel* remains the place to see an App, in its
  sandboxed frame with the strict CSP.
- **Clear Memory keeps deleting App artifacts** (`account-lifecycle/index.ts:93-97`) — Apps are
  `type: "artifact"`, so they are user workspace content. A previously downloaded `.html` is the user's own
  file and stays, exactly like any other download; the archive covers the artifact itself (ruling 24).

## 43. One owner for the three tools: Slice 5, landed early as "5a"

*Approved by the owner with the working plan, 2026-09-25.* Slices 1, 2 and 5 each described the three model
tools, and slice 5's own T2/T3 tests call slice 1/3/4 validators, so no single reading of the slices could land.

- **5a** (right after slice 0) lands `normal-chat-tools/artifact-tools/{create,read,edit}.ts` as
  `slice-5.md §The three tools` specifies (advertised vs executed schemas; `summary`, not `label`; the payload
  shapes; `ArtifactRefusal`; tool-call metadata), their registration in `index.ts`, the **final family-wide EN
  and HU descriptions** in `TOOL_I18N`, **all three** `TOOL_TIMEOUTS_MS` rows (`create_artifact: 120_000`,
  `edit_artifact: 20_000`, `read_artifact: 10_000`), the one measured catalogue-ceiling raise (ruling 23), the
  gating test, and a per-kind dispatch seam into the artifacts service with no creatable kind registered yet.
- Each type slice appends **only** its kind's handler entry per tool, its member of `ArtifactRefusalReason`, and
  its kind's tests. **No type slice edits `normal-chat-tools/index.ts` or `shared.ts`.**
- Superseded: slice-1's `normal-chat-tools/artifacts.ts`, its `label` argument, its description table and its
  two timeout rows; slice-2's "Slice 1 creates it; Slice 5 moves it" rows; slice-5's reading that T2/T3's
  per-type tests land with the shell. Rulings 40 and 41 are satisfied as written.

## 44. The harness core lands early; each type slice owns, and runs, its own suite

*Approved 2026-09-25.* 5a lands, on slice 0's skeleton, the core of `slice-5.md §The eval harness` —
`config.ts`, `client.ts` (the only reader of a key), `run.ts` and its flag table, the known-bad-first refusal,
the per-suite scorer dispatch, the results-leak test, the `.gitignore` line and the `eval:artifacts` scripts.
Each type slice writes `suites/<suite>.ts`, `fixtures/<suite>/**` (with `known-bad/` and committed
`responses/`), its scorer and its `cases.ts` entry, and runs its live gate before it is called done: slice 1
`document`; slice 2 `app` and `verification`; **slice 3 `canvas`** (a task its spec lacked); slice 4 `slides`.
No type slice edits `run.ts`, `config.ts` or `client.ts`; slice 5's T9 is the all-suite run. Superseded:
slice-1 T13's file list, and slice-5 T8 writing every suite.

## 45. One home per shared comment and anchor symbol; slice 1 creates the comment card

*Approved 2026-09-25.* `src/lib/shared/artifacts/anchor.ts`: slice 0 declares `Anchor`; slice 1 appends the
interface pieces (`AnchorResolution`, `AnchorState`, `AnchorTone` and the pure helpers its table lists); the
Document's text resolver stays in `src/lib/shared/artifact-document/anchor.ts` (ruling 35). Slice 3's
`src/lib/shared/artifacts/comments.ts` imports those and never redeclares them. `CommentCard.svelte` lives at
`src/lib/components/artifacts/CommentCard.svelte`, **created by slice 1** and consumed by slice 3 — the
`RefusalNotice.svelte` pattern. Every exported symbol is declared once in the tree.

## 46. Surfaces 4 and 6 get an owner: Slice 7

*Owner, 2026-09-25: "Build the missing surfaces too, yes."* Knowledge → Documents lists all five kinds in one list,
with a Version column and the mockup's six chips — All · Documents · Canvas · Apps · Slides · Uploaded — where a
produced File groups under Uploaded with its file-format pill, exactly as surfaces mockup §4 shows (*corrected
2026-09-25: an earlier wording, "all five kinds with type chips", read as a separate File chip the mockup does not
have*); Workspace Search finds every kind, as flat rows labelled with the
kind (§6). Both obey the containment rules — never an incognito artifact, never another user's, never outside
`getArtifactOwnershipScope`. Specified as `slice-7.md` in the house format, landed in wave 3. Slice 0's non-goal
line ("no Knowledge-page listing change and no new search scope") stays true of slice 0.

## 47. A user's own saves coalesce into one version per editing burst; nothing else does

*Orchestrator, 2026-09-25, from Slice 0's data review.* Every version stores the whole body (up to 2 MiB), and
Slice 1's editor autosaves every 800 ms, so one version per save would store hundreds of full copies per editing
hour. Rule, owned by Slice 1's body-write path (`updateArtifactBody`):
- **Always a new version:** every Alfy change (edit_artifact, an `@Alfy` comment edit, an App regenerate), every
  restore, and the artifact's creation. Undo and History depend on these; they are never merged.
- **Coalesced:** a save authored by the user **updates the latest version in place** (body, body_hash, its
  timestamp; the version number is unchanged) when that latest version is also the user's and was created less
  than **10 minutes** earlier. Otherwise it appends a new version. So an Alfy change always closes the user's
  burst, and "Undo" of an Alfy change restores exactly the user's text just before it (spec §2.4 holds).
- The version-number guard (`expectVersion`) is unaffected: an in-place user save keeps the number, and any
  Alfy version still bumps it and refuses a stale save.
- No hard cap on version count in v1 (single-user accounts); History lists newest first, paged. Revisit if a
  measured artifact exceeds ~200 versions.

## 48. An App's key-value storage has a total cap as well as per-value caps

*Orchestrator, 2026-09-25, from Slice 0's data review.* Slice 0 caps each value (256 KiB) and the key count (200),
which still allows ~50 MiB per App. **Slice 2** adds `ARTIFACT_KV_TOTAL_MAX_BYTES = 512 * 1024` to Slice 0's
`limits.ts` and enforces it inside `setKv`'s transaction (the sum of value bytes after the write), refusing with
the same no-write semantics and reason family as the per-value cap; `APP_KV_LIMITS` derives from it like the others,
with a test that pins the equality.

## 49. Every artifact route answers `{ ok: true, … }` on success

*Orchestrator, 2026-09-25.* `slice-0.md` states it ("Success and failure have one shape across this feature") and
slices 1–6 were written against it (`ok: true` appears in each), but Slice 0 shipped flat success bodies for
`GET /api/artifacts/[id]` and `GET /api/conversations/[id]/artifacts`-style reads. They gain `ok: true` in Slice 0's
post-review integration step, with the client parser and tests updated in the same commit. The failure shape
`{ ok: false, reason }` is unchanged, and a foreign id and a missing id keep byte-identical 404 bodies.

## 50. The artifact tools' dispatch seam, as Slice 5a built it

*Orchestrator, 2026-09-26, confirming Slice 5a's report.* Slices 1–4 code against this; where `slice-5.md`'s
sketches differ, this wins.
- **Three registries, one per tool**, each `Partial<Record<CreatableArtifactKind, Handler>>`:
  `CREATE_ARTIFACT_HANDLERS`, `READ_ARTIFACT_HANDLERS` and `EDIT_ARTIFACT_HANDLERS` in
  `normal-chat-tools/artifact-tools/{create,read,edit}.ts`. A type slice appends one entry per tool it supports,
  in those files only (ruling 43 unchanged: nobody else edits `normal-chat-tools/index.ts` or `shared.ts`).
  File has no entries: `read_artifact` answers a File with a short summary from `getArtifact()`, and
  `edit_artifact` refuses it.
- **`ArtifactRefusalReason`** (edit.ts) starts as `"unsupported_kind"`. Each type slice widens it with `|` from
  its own refusal union, under whatever name that union really has, and never redeclares it.
- **An edit on an unknown id** answers `success: false` with the conversation's own candidates, as a read does.
- **`read_artifact` without `detail` reads `"full"`.** Whether a full read reaching the model needs a size bound is
  an open question for RV-5a's report.
- **The harness circuit breaker** counts a case's outcome after its one retry: two consecutive cases ending in
  429/5xx stop the run. The npm scripts call bare `tsx`, like the repo's other scripts.
- **The harness core was built from the ADR text** (the apps-quality prototype is a plain folder,
  `.claude/worktrees/agent-afcaa6f617ee84abe/scripts/prototype-artifact-apps/`, not a branch, and 5a could not
  find it). Slice 2 aligns its App and verification suites with that prototype and reports any change the core
  needs.

## 51. Bodies are told the conversation, so an incognito conversation's artifacts open for their owner

*Orchestrator, 2026-09-26, from Slice 2's report.* An incognito conversation's artifact is readable only when the
read names that conversation (`?conversationId=` on the artifact routes, `fetchArtifact(id, conversationId)`), but
the panel's body contract had no conversation. `ArtifactBodyProps` gains `conversationId?: string | null`;
`DocumentWorkspace.svelte` gains the matching prop and passes it to the body; the chat page supplies it (the
knowledge page and the project Files dialog never show an incognito conversation's artifacts and pass nothing).
Every type body passes it to `fetchArtifact` and to every artifact route it calls. Landed by the small branch
`feat/artifacts-bodyprops`, merged with Slice 5a.

## 52. An App repair is re-verified before it is accepted, within the create budget

*Orchestrator, 2026-09-26, from Slice 2's report.* `slice-2.md` §verification stands as written: a clear error is
repaired once and **re-verified**, and a repair is accepted only when the re-verification finds nothing wrong
**and** the claim list did not gain a claim (compare the lists). The model's own "the repair is safe" answer may
stay as an extra guard, never as the only one. To stay inside `create_artifact`'s 120 s: the re-verification runs
without `research_web` (named facts settled in the first pass are matched by claim text), and the verification
pass carries its own deadline. Running out of time after a clear error gives `uncertain` with the original HTML
and the finding in Alfy's note: never `repaired`, and never a failed create.

## 53. The artifact tools pass the abort signal, bound what a read returns, and cap creates per turn

*Orchestrator, 2026-09-26, from RV-5a's open questions and one gap the review missed.*
- **Abort.** Every handler receives `abortSignal: AbortSignal`: the envelope's, which fires on the tool timeout
  and on the user's stop. A handler checks it before any write and passes it to any model call; after an abort it
  writes nothing. Without it an App generation outlives its 120 s timeout and can still write an artifact after
  the model was told the call failed: an orphan, and a duplicate when the model retries.
- **Read bound.** The read shell bounds what reaches the model, whatever the handler returns: `body` is clipped at
  the file tools' inline cap (`MAX_INLINE_TEXT_CHARS`, 100 000 characters, exported from `files.ts` and reused),
  with `truncated: true` and the number of characters left out; `blocks` are included in order until their
  serialised size reaches the same cap, then `truncated: true` and the number of blocks left out. The tool
  descriptions do not change.
- **Per-turn cap.** `MAX_CREATE_ARTIFACT_CALLS_PER_TURN = 3`, counted and refused the way
  `MAX_PRODUCE_FILE_SUBMISSIONS_PER_TURN` is: the call past the cap runs no handler and tells the model to stop and
  say what it made. No idempotency key: a retried turn is a new answer, and the abort rule removes the duplicate a
  timeout would cause.
- **Kept as they are:** English-only runtime refusal texts (model-facing; the tool layer's convention), the
  opencode fallback's all-or-nothing, and the catalogue reusing `listArtifactsForConversation`. A forked
  conversation does not reach its parent's artifacts through the tools (they are pinned to
  `artifacts.conversationId`, like the catalogue); revisit only if forks need it.

## 54. The eval harness only talks to an endpoint it is given

*Orchestrator, 2026-09-26, after Slice 1's first document eval.* A live run requires `EVAL_ARTIFACTS_BASE_URL` and
`EVAL_ARTIFACTS_MODEL`; the key comes only from `EVAL_ARTIFACTS_API_KEY` (the local vLLM needs none). The
`~/.config/opencode/opencode.json` fallback (`slice-5.md` §Global Constraints, `:710`, `:777`) is **removed**: it
let a run send prompts to whatever provider that file names, with the owner's key, and it made Slice 1's document
eval look live while not measuring the production model. The recipe is `working-plan.md` §1.9's tunnel to
`qwen3-6-27b`, one command, one local port per agent. Recorded replay responses come from `qwen3-6-27b` only;
Slice 1's document fixtures are re-recorded that way. The key rule is otherwise unchanged: never printed, logged,
written into `results/` or committed.

## 55. An artifact is made in the turn's language, never a per-message guess

*Orchestrator, 2026-09-26, from Slice 2's live eval: 3 of 10 English prompts produced Hungarian Apps.* Wave 0
resolves the reply language once per turn (`resolveTurnResponseLanguage`), and the tool context already carries it
(`CreateNormalChatToolsContext.language`). `CreateArtifactHandler` params gain `language: "en" | "hu"`, threaded
from that context by the create closure in `normal-chat-tools/index.ts` (an authorized edit, like ruling 53's), and
every handler uses it. The App path's `detectLanguage(brief)`, the per-message heuristic Wave 0 retired from the
chat path because it reads English as Hungarian, is removed. The panel's regenerate uses the same resolver (the
user's instruction, then the conversation's established language, then the UI language). The `app` eval gives
each fixture its declared language, and scores the output's language: a UI in the wrong language is `broken`.

## 56. The App suite's browser pass is part of the gate

*Orchestrator, 2026-09-26.* `slice-2.md` A9 Step 3 and `slice-5.md`'s suite table require the P1 pipeline's
headless-Chromium evaluation (1280×800 and 390×844, light and dark; every request but the document aborted;
`window.alfy.storage` injected before the app's own scripts; one smoke interaction), and the `works` /
`works-with-glitches` / `broken` verdicts come from it. Scorers stay synchronous and read records; the harness core
gains an optional async per-suite `evaluate` step that runs after extraction and records its result next to the
response. `--replay` re-scores the committed responses and evaluation records with no model and no browser; a live
run does both. The port follows the prototype's `evaluate.ts`, `score.ts` verdict rules and `gallery.ts`.

## 57. No new import cycle: `research_web` gets its own module

*Orchestrator, 2026-09-26.* Slice 2's verifier took `research_web` from `createNormalChatTools`, which closed a new
cycle (`artifacts/app/create.ts → … → verify.ts → normal-chat-tools/index.ts → artifact-tools/create.ts → …`; Fallow
4 → 5). The research_web tool's construction moves out of `index.ts` into its own module, used by both `index.ts`
and the verifier. It is a pure move (an authorized edit to `index.ts`), and the frozen catalogue snapshots prove the
tool is unchanged. Fallow's circular count returns to 4.

## 58. Apps work inside their own sandbox, and cannot quietly leave it

*Orchestrator, 2026-09-26, from RV-2A; a security-relevant change the owner may overrule.* Measured under the
product's exact frame and CSP: a form's `submit` never fires, `confirm()` returns false and `eval` throws. 4 of the 10
eval apps had a dead main action while the eval scored them "works". An App can also still leak what it holds by
navigating itself or through WebRTC, which no CSP directive stops in Chromium. `slice-2.md` and spec §5 pin
`sandbox="allow-scripts"`; this amends them (spec §5 is not a §2 decision).
- **Forms.** The frame's sandbox becomes exactly `allow-scripts allow-forms`, and the CSP's `sandbox` directive
  matches. `form-action 'none'` stays, so a submit event fires and the submission itself is still refused
  (measured). The exact-string tests pin the new value. Still never `allow-modals`, `allow-same-origin`,
  `allow-popups`, `allow-top-navigation` or `'unsafe-eval'`.
- **Contract and audit.** The generator is told: handle `submit` with `preventDefault()`; never
  `alert`/`confirm`/`prompt` (draw an inline confirmation); never `eval`/`new Function`; never navigate (`location`
  assignment, `window.open`, an external `href`, `<meta http-equiv="refresh">`); never `RTCPeerConnection`. The audit
  gains matching rules. The dialog/eval rules are glitches. The navigation/WebRTC rules are violations: the
  generation is retried once with the violation named, then refused with a visible, localized message. The audit's
  tag regexes are bounded (`[^>]{0,4096}`): same verdicts, linear time.
- **Tripwire.** The parent tears the frame down and shows a localized notice when the frame fires a `load` the parent
  did not cause (the App navigated itself). It acts after the fact, but it ends a phishing flow.
- **The eval runs Apps the way users get them.** The browser pass (ruling 56) loads each App in the product's exact
  frame attribute and CSP header, read from the shared constants. An app whose main action dies there is `broken`.
- **Runtime hardening from the same review.** The bootstrap accepts replies only from `window.parent`; saves to one
  key keep their order; the pending queue also caps bytes; the kv read sends `no-store`; a non-string key is refused;
  the download error is localized; an expired session inside the frame shows a localized notice, not a dead login
  form; the Code tab loads its highlighter on demand.

## 59. A known-bad fixture is a recorded answer, never a model call

*Orchestrator, 2026-09-26, from RV-2B.* The verification suite's known-bad case asked the model to break its contract
("reply CONFIRMED"). `qwen3-6-27b` kept the contract instead, so the live known-bad passed and the gate (rightly)
refused to trust any score in that run. A known-bad fixture exists to prove the scorer can fail, so it must not depend
on the model misbehaving. Every suite's known-bad cases are hand-written responses, committed, and served from disk in
live runs too: the harness never sends them to the model. This is owned by Slice 5b's T9 (the all-suite live run),
unless an earlier slice needs it first.

## 60. The Documents tab filters ordinary files by type too (two tiers)

*Owner, 2026-09-27, while testing Wave 2.* The top row is `All · Documents · Canvas · Apps · Slides · Files` ("Uploaded"
renamed Files/Fájlok; the same bucket: uploads, produced files, Skill Notes). Choosing Files shows a second row of file
families with live server-side counts, zero families hidden: PDF · Word · Spreadsheets · Presentations · Images ·
Text & Markdown · Other. The family is a fold over the one file-type registry's categories
(`src/lib/shared/file-types/`), so every registered type lands in exactly one family. Counts and the filter run on the
server under the existing ownership scope. Amends ruling 46 and the slice-7 amendment.

## 61. The redesign is approved and built before anything else

*Owner, 2026-09-27: "I love the redesign"; the three open questions in `redesign.md` §12 delegated to the orchestrator.* Build
`docs/design/artifacts-redesign/` as specified, now, before Wave 3, so Documents and Apps are publishable for the owner.
- **A pending Alfy change survives a reload.** The edit is already a saved version; only its review state was lost. The
  artifact records the last Alfy version the user has reviewed; on load, an unreviewed Alfy version's changed blocks
  (its diff against its parent, block by block) are marked again and counted in the review bar. Keep acknowledges them;
  Undo restores the parent's content for those blocks as a user edit; a user's own edit to such a block acknowledges it.
- **The comment margin shows Open threads by default,** with a quiet "N resolved" toggle to All; resolved threads fold to
  one line either way.
- **Tabs show only their own section.** Search, export, the card preview and Alfy's reads still cover the whole document.

## 62. What a tool advertises is what its validator parses

*Orchestrator, 2026-09-29 (Wave 3), from the Document edit's live failure in Wave 2: the model guessed op names seven
times, then duplicated the document.* This supersedes `slice-5.md §The three tools`' "patches and ops are `z.unknown()`
deliberately" for Canvas and Slides, exactly as the Document already did (`documentPatchesArraySchema`, `edit.ts`):
- Canvas `ops` and Slides `patches` (and Slides' `create_artifact` body) are advertised with **the same zod schema the
  handler validates with** — one exported schema, used by both `buildEditArtifactModelInputSchema` and the handler, never
  a hand-written twin.
- Each kind's description carries **one compact worked example**, and a unit test parses that literal through the
  executed schema and the kind's validator against a real fixture body (`EDIT_ARTIFACT_DOCUMENT_EXAMPLE` is the pattern).
- Every refusal the model sees **names the valid ops or fields** it could have used, so a wrong guess is corrected in one
  step.
- Every eval suite's live run goes through the real tool description and schema (`buildFullToolCatalogue`'s path), never
  a hand-written prompt. Registering a kind's create handler spends catalogue headroom: raise
  `CATALOGUE_TOKEN_CEILING` by the measured cost plus the existing margin, numbers in the commit message, and update the
  frozen catalogue snapshots in the same commit (ruling 23's discipline; the test's own note anticipates this).

## 63. A Canvas change is reviewed as one change, with the Document's review parts

*Orchestrator, 2026-09-29 (Wave 3); the owner may overrule.* The approved redesign (§8) gives Canvas the Document's
change pill and review bar; ruling 16 made "undo an Alfy change" a version restore. They meet like this:
- An Alfy diff that lands on a board is **one pending change**: its touched nodes are highlighted, one change pill
  (`ChangeBar`'s pill: "Alfy · Keep · Undo") sits at the corner of the touched nodes' bounding box, and the shared
  `ReviewBar` at the bottom of the board steps through the touched nodes (prev/next centres the camera on each) with
  Keep / Undo for the whole diff. There is no per-node Undo in v1.
- **Undo** writes the parent version's body back as a **user** version ("Undid Alfy's change", the shared
  version-summary vocabulary); if the user changed the board after the diff landed, Undo is refused with the shared
  refusal card and History (restore) is the way back. Keep acknowledges.
- A pending change **survives a reload** through the same review marker ruling 61 put in `metadata_json` (the last
  reviewed Alfy version): a Canvas branch computes the touched node ids of each unreviewed Alfy version against its
  parent. The in-session Ctrl/Cmd+Z (your own strokes and moves) stays as ruling 16 says, labelled differently.
- Cost if wrong: per-node Undo later needs a node-level restore; the pill and bar are unchanged by that.

## 64. Canvas block data schemas are server-safe, and the model makes only note-shaped blocks

*Orchestrator, 2026-09-29 (Wave 3).* `slice-3.md §The block registry` puts each kind's zod schema in the component
registry, but the server validates BoardDiffs with them and must never import Svelte components or icons.
- The per-kind data schemas and the kind list live in **`src/lib/shared/artifacts/canvas-blocks.ts`** (zod only, no
  Svelte), next to `canvas.ts`'s types; `_lib/block-registry.ts` imports them and adds component, icon, label, size and
  poster policy. One schema per kind, declared once.
- The model's `add_node` (and `add_frame`) may create **`frame`, `sticky`, `text`, `checklist` and `chart`** only — the
  advertised `data` is the discriminated union of those five schemas, the same one the validator parses. The other kinds
  (`map`, `file`, `app`, `photo`, `liveweb`) carry app-owned references the model cannot mint; they are placed by the
  user's own inserts through the body route. An `add_node` of one of them from the ops path is refused `unknown_kind`,
  and the refusal names the five kinds it may add. `update_node`, `move`, `remove_node` and `highlight` work on every
  kind already on the board (an `update_node` is validated against that kind's own full schema).
- The client keeps using the one shared body route and `saveArtifactBody` (`src/lib/client/api/artifacts.ts`); there is no
  `saveCanvasBody`.

## 65. Wave 3 order, and Slides waits on its own branch until Canvas ships

*Orchestrator, 2026-09-29, from the owner's Wave 3 instruction (S3, S4, then the S6 remainder and focus-trap pass two;
stop at each milestone for the owner's check).*
- Canvas is the first milestone. Slides work runs beside it on **`feat/artifacts-slides`** (branched from
  `feat/artifacts`, its agents branch from it, and `feat/artifacts` is merged into it after each Canvas merge). It joins
  `feat/artifacts` only when Slides is whole, so ai.dev never offers a kind whose panel is half built.
- Slides de-risks first: the deck model, the `create_artifact` handler and eval suite 4's create cases run before its
  panel is built (`slice-4.md` treats suite 4 as a hard precondition; a weak result is an owner decision per ADR-0066).
  The suite scores the fixture's **declared** language (ruling 55), not `detectLanguage`.
- The S6 remainder follows Slides without waiting for S5b: ruling 31's order only governs appends to the shared
  containment suite, which stays append-only either way.

## 66. A deck is fact-checked before it is written

*Owner, 2026-09-29, after suite 4's live run missed its bar (7/16 decks clean; 9/16 carried a number or name from the
model's own knowledge, 5 of them only in speaker notes; 0 language misses in 69 decks): "Agreed with your
recommendation" — option (c) of `wave-3/s4d-report.md` §7.* ADR-0066's rule applied: the design changes, not the bar.
- **Before a deck is written**, the Slides create path runs a verification pass on the App pattern (Slice 2's
  verifier, rulings 52 and 57): list the specifics in the deck — numbers, dates, times, prices, names, places — that the
  user's own material (the conversation and the sources the turn used) does not contain; check the general-knowledge ones
  with `research_web`; **remove or neutrally rephrase whatever cannot be confirmed**; then write. A personal specific
  (a train time, a price, a booking, a person) is never "confirmed" by the web — if the user did not give it, it goes.
  Speaker notes are checked like slide text.
- It runs inside `create_artifact`'s 120 s (ruling 40) with its own deadline and the abort signal (ruling 53). Running
  out of time removes the unconfirmed specifics rather than writing them; it never fails the create.
- The result is recorded with the version (what was checked, confirmed with its source, removed) and shown the way an
  App's fact check is: one quiet line on the card and in the panel ("Alfy checked 6 details; removed 2 it couldn't
  confirm"), localized. Alfy's later edits that add text to a deck go through the same check.
- **Suite 4's bar stays "zero unsupported specifics"**, measured on the deck as written, where a specific confirmed by the
  verifier counts as sourced (its source recorded next to the response), over three repeats, reported as a rate.
- Cost if wrong: one extra model pass (plus bounded web checks) per deck, about 20–60 s.

## 67. What Alfy may change on a board, and Alfy never overwrites the reader's newer words

*Orchestrator, 2026-09-30, from RV-3 (I5, I6); the owner may overrule at the Canvas check.*
- **Amends ruling 64.** On the five app-owned kinds the model's `update_node` may change **only descriptive fields**: a
  map's `label`, `route` and `meta`; an App's `title`. A live-web block's `query`/`sources`/`fetchedAt`, a photo block's
  `items`, a file block's `fileId`/`name`, an App block's `artifactId`, and **any block's `poster`** are set only by the
  app (the user's Insert, Refresh, the poster capture). Anything else is refused `invalid_data`, naming what may change
  and saying the rest comes from Insert or Refresh. Why: a prompt-injected turn could otherwise plant attacker links
  dressed as the app's own search result (with a fresh "Updated" line) that beacon through the favicon proxy on every
  open.
- **Alfy's edit is refused where the reader changed the block after Alfy read it** — the Document's `block_changed`
  rule, for boards. The edit handler takes the version the model last read of this board **in the same turn** (the
  turn's earlier `read_artifact` result) as its base; an op addressing a node whose content differs between that version
  and now is refused `stale` ("the reader changed it; read the board again"), and the rest of the batch applies. With no
  read in the turn, the edit applies to the current board and the one-change review (ruling 63) is the safeguard.
- Cost if wrong: an extra read when the reader and Alfy touch the same block in one turn.

## 68. The Canvas editor's first paint is budgeted at 67 KiB gzip, measured honestly

*Orchestrator, 2026-09-30, from S3-X.* `slice-3.md`'s 65 kB came from the prototype's 51 kB route chunk; the product
editor now also carries the hooks for comments, Alfy's landing and review, the selection pill and the Insert menu. S3-X
brought what opening a board downloads (the editor chunk, its static imports and CSS, the lazy parts' shared chunks
counted as its own) from 74.1 to **66.3 KiB gzip**; the last 1.3 KiB would cost an extra request at first paint (the
note-shaped blocks), a visual change or the minimap. The budget for that honest measure is **67 KiB (68,608 B) gzip**,
enforced by `check:artifact-chunks`; the chat route without an artifact open stays within +2 kB; Chart.js and MapLibre
stay out of the editor's closure. Cost if wrong: 2 KiB more on a board's first open.
- **Amended the same day, after F-C:** the review's I2 fix (flush the reader's pending step before a turn; merge it
  with a landing Alfy change) put ~0.1 KiB of necessary safety into the first-paint closure (the merge itself loads
  on demand). The ceiling is **68 KiB (69,632 B) gzip**; the guard enforces that number, and the next raise needs the
  same kind of recorded reason.
- **What the number counts (RC-3's N4):** the editor's own closure — its chunk, its static imports and CSS, the lazy
  parts' shared chunks — **not** the chunks the chat route has already loaded. Opened from a cold page that has not
  loaded the chat's Mermaid path, a board downloads 84.4 KiB gzip; the usual path (a board opened from its chat) is the
  measured one.
- **Raised twice more after the owner's walk (2026-10-01):** OW-1's working undo, the pill on the reviewed block and frames
  as groups added 1.2 KiB of first-paint code (ceiling 69,632 → 70,656 B), and OW-C's diagram block row and loader
  0.3 KiB; together 70,710 B → **ceiling 71,680 B (70 KiB) gzip**. The owner asked for both; the multi-select that comes
  next loads on demand.
- **The chat-route baseline moved once, 2026-10-01 (OW-C), by a measured 1,112 B gzip (535,771 → 536,883):** the diagram
  block's names in both languages live in the dictionary the chat loads (+463 B) and the chat's own Mermaid component now
  shares a chunk with the board's diagram block, as Chart.js's already did. A move of this baseline needs the same:
  measured on one machine against the commit before, the reason in the commit message.
- **Moved again for the tours (Wave 4, TR-B, 2026-10-05), by a measured 1,682 B gzip (536,883 → 538,565):** the tours'
  groundwork (`feat/artifacts-s6`: the admin campaign strings and types in the dictionary every route loads) used the
  remaining headroom (+2,048 at its merge), and the tour's chrome strings plus the panel's trigger add the rest; the card
  and its drawings are one lazy chunk (2.8 kB) the chat never loads until a tour shows. TR-C may move it by its own
  measured growth the same way.
- **Moved for the final round's merges (orchestrator, 2026-10-06), by a measured 462 B gzip (539,608 → 540,070):** FU-2's
  focus traps (`ImageLightbox`, `ModelSelectionGuideModal`, `ModelForm`; its agent measured +175 B) and W4-B's project-bundle
  rows and strings (~+210 B) were each measured on their own base and merged into `feat/artifacts` together; on this Mac
  `dev` `9aed65c0` builds the chat route at 541,618 B (+2,010) and `feat/artifacts` `86a736b5` at 542,080 B, so the move is
  exactly that difference and the route again reads +2,010.
- **And for W4-E (orchestrator, 2026-10-07), by a measured 415 B gzip (540,070 → 540,485):** the "Made in this chat" group in
  the message's Sources panel (its row, the kind's icon and word, one string in each language); `feat/artifacts` builds the
  chat route at 542,080 B before the merge and 542,495 B after it on this Mac (its agent measured +409 B on its own base).
- **And for FX-B (orchestrator, 2026-10-07), by a measured 429 B gzip (540,485 → 540,914):** the panel joining the dialog
  stack over a project's Files dialog (its focus trap and Escape handling in the panel the chat also loads), the tours'
  reader threading and `forgetArtifactTours`: 542,496 B before the merge, 542,925 B after it (its agent: +414 B).

## 69. Slides is shelved; the tours come next

*Owner, 2026-09-30: "I would shelf Slides for now and do the Tours as that would be necessary for a live deploy on main
prod."* After the Canvas milestone and the owner's check, the next work is **the Slice 6 remainder (the tours)**, not
Slides.
- `feat/artifacts-slides` stays as it is (the deck model, the create handler, suite 4, the fact check of ruling 66) and
  is not merged; nothing on `feat/artifacts` advertises or renders Slides, so the model never offers a deck.
- **Three tours ship** — Document, App, Canvas (ruling 8's four, less Slides); Slides' tour lands with Slides.
- Release checklist: the Knowledge tab's "Slides" chip (ruling 60's top row) is hidden while no Slides can exist, so
  production shows no filter for a kind it cannot make.

## Consequences for the slice specs (cumulative)

- Slice 3: body list loses `comments`; the perf gate is split as §9.
- Slice 4: PPTX only; layouts fixed; the mockup's export line corrected.
- Slice 5: tool guidance on the tools; the two `AGENTS.md` fixes; `EvidenceSourceType` widening with tests;
  artifacts as evidence rows, not new Info rows.
- Slice 6: four types, code-owned structure with a campaign override and the `summary` layout.

## 70. Internal model calls take their sampling through one route (Wave 4, orchestrator, 2026-10-05)

*From SMP.* `normal-chat-model/sampling.ts` (`resolveModelCallSampling`) is the only way a model call gets its temperature
and top_p; top_k stays the provider builder's body injection from the same family `defaultSampling`. A path whose text a
person reads takes the whole profile; an explicit temperature stays only for a deterministic machine-read answer (memory
judge, reconcile/merge, recuration, the three model-facing digests), each listed with its reason in the structural guard
(`sampling.test.ts`). The owner's garble premise did not hold on `dev` or `main` (no path sent "no sampling"; the garble
reproduces only without any); the follow-up defects found by the probe (titles falling back on a stray `<think>`, the
English-only reasoning-leak check, English follow-ups in Hungarian chats) are SMP-2's, and titles' temperature is decided
by its measurement.

## 71. Tours: archiving falls back to the default, a closed tour starts over (Wave 4, orchestrator, 2026-10-05)

- Archiving a published tour **falls back to the code-owned copy**; it never retires the kind (ruling 4: the text is
  editable, the trigger is not; slice 6's failure table). TR-A's reading (archive = no tour) is corrected by TR-C.
- A tour closed mid-way writes nothing and **starts again at slide one** next time (three slides; a client-side resume
  would cost ~150 B on the chat route for little). Cost if wrong: that resume, later.
- The list's replay row appears where a row already has its menu; the empty state's link (TR-C) is the host every item has.
- An admin cannot publish an `artifact_tour` whose kind (`releaseVersion`) is not a shipped kind (TR-A's concern 2).

## 72. The evidence slice builds what has a surface (Wave 4, orchestrator, 2026-10-05)

`getArtifactSources` and the `artifacts.sources.*` strings (slice 5 T4) are not built: the approved redesign has no place
in the panel that lists an item's sources, the turn's web sources already show in the message's Sources panel, and an
unused export is a Fallow finding. The "Made in this chat" group (rulings 6, 7) is built. Cost if wrong: one read-model
function and a panel row later.

## 73. A project's bundle is its own list; the prompt's project files stay files (Wave 4, orchestrator, 2026-10-06)

*From W4-B.* `listProjectBundle` (artifacts service) lists what a person sees in a project — its files plus the
Documents, Apps and Canvases its chats made (membership by the chat's project at read time, never stored) or linked
from the library — and feeds the Files dialog, the project page and the home cards. `listProjectKnowledge` stays
files-only, because it feeds the prompt and the project-file mention path, where a family row (never prompt-ready)
would refuse the turn, and because knowledge importing artifacts would be a cycle. Slice 5 T5's "listProjectKnowledge
includes artifacts" is read through this ruling.

## 74. Alfy may draw the chat's diagrams on a board (Wave 4, orchestrator on the owner's request, 2026-10-07)

*The owner:* "Are you sure you fixed Canvas so that the model can actually render the same charts from chat?" A live probe on
ai.dev showed Alfy's Chart.js charts land (bar, radar, pie, line) but a requested flowchart became three sticky notes,
because ruling 64 kept diagrams to the reader's Insert. **Ruling 64 is amended:** a `diagram` block joins the kinds Alfy may
add — the Mermaid source it writes in a chat reply, drawn by the chat's own component under the chat's security settings —
and `update_node` may change a diagram's source. Maps, files, Apps, photos and web blocks stay the reader's (they carry
references the model cannot mint). Built by CV-A, with the placement work the owner asked for beside it.

## 75. A request for content in another language keeps the conversation's language (owner, 2026-10-07)

RV-F M-8, the owner: "Írj egy e-mailt angolul a kollégámnak…" keeps the reply, the chips and the status line in the
conversation's language; only the requested content is written in the other one. Only a request for the *reply* in a
language ("válaszolj angolul", "answer in English") flips the turn (CHP's rule, narrowed). Built by LANG-2.

