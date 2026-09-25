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

## Consequences for the slice specs (cumulative)

- Slice 3: body list loses `comments`; the perf gate is split as §9.
- Slice 4: PPTX only; layouts fixed; the mockup's export line corrected.
- Slice 5: tool guidance on the tools; the two `AGENTS.md` fixes; `EvidenceSourceType` widening with tests;
  artifacts as evidence rows, not new Info rows.
- Slice 6: four types, code-owned structure with a campaign override and the `summary` layout.
