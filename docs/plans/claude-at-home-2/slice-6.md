# Slice 6 — First-open tours: three slides per kind, once per user, editable by the admin

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking. Read `plan.md` first. **This slice needs Slice 0** (the artifact panel) and each type's slice for
> the panel it hangs in: Document (Slice 1), App (Slice 2), Canvas (Slice 3), Slides (Slice 4). It does not
> need Slice 5.

**Goal:** The first time a user opens an artifact of a kind, show a three-slide tour that says what it is,
what you can do with it, and how to ask Alfy for something — once per user per kind, replayable from the
artifact's version badge, with the text living as **content** a deployment can edit in admin Settings (the
Announcement Campaign machinery of [ADR-0012](../../adr/0012-announcement-campaigns-and-first-run-onboarding.md))
rather than as strings frozen in a component.

**Architecture:** One panel-local component, `ArtifactTour.svelte`, shown inside the artifact panel — not the
app-level campaign modal. Its content is resolved through one new server service,
`src/lib/server/services/artifact-tours.ts`, which prefers a **published** tour campaign snapshot for the
kind and falls back to a **code-owned default** when no campaign has been published. The five kinds' copy is
therefore shippable out of the box (the defaults, in code, the `prompts.ts` `SYSTEM_PROMPTS` precedent) and
editable without a deploy (a published campaign, the campaign machinery). Seen-tracking is a small new
per-user table keyed `(user_id, artifact_type, content_key)` — **not** the campaign's user-state table,
because a code-owned default has no snapshot to key on, and because
[ADR-0012](../../adr/0012-announcement-campaigns-and-first-run-onboarding.md) says a seeded template is not
auto-published. The tour's one-line summary is the canonical copy for the kind's **empty state**, with the
i18n key as the fallback.

**Tech Stack:** the existing campaign service (`announcement-campaigns.ts`), the campaign admin pane and its
`SlideEditor.svelte`, a new `artifact_tour` campaign type, Svelte 5 runes, one new table plus a migration,
Vitest and Playwright.

**Spec:** `docs/plans/claude-at-home-2-artifacts-spec.md` §2 (decision 2: one panel), §5 (the panel),
§6 (cross-cutting: EN + HU, archive and erasure, migrations, telemetry without content).
ADRs: [ADR-0012](../../adr/0012-announcement-campaigns-and-first-run-onboarding.md) (campaigns, versioned and
localized, published snapshots immutable, seeded templates not auto-published, the version badge replays
without resetting completion state), [ADR-0066](../../adr/0066-artifacts-are-a-family-of-five-types.md) (each
type shows a three-slide tour the first time it is opened; "Artifact" is never shown in the UI),
[ADR-0029–0032](../../adr/) (account data archive and erasure).
Mockup: `claude-at-home-2-artifact-surfaces-mockups.html` §7 — the dots (3), `.tourart` illustration, the
`h3` `A board for anything`, the body paragraph, the `.tourfoot` line
`You'll see this once. Replay it any time from the version badge.`, and `Skip` / `Next`. The legend reads:
"Three slides per kind — what it is, what you can do with it, how to ask Alfy. Shown on the first open of
that kind, once per user."

## Global Constraints

Same as `plan.md` §Global Constraints. In addition, for this slice:

- **Svelte 5 runes only**; callback props; `onclick`; `{@render}`.
- **Lucide icons only** for icons. The `.tourart` illustration is an **illustration**, not an icon — it is
  declared as such, one component per kind, built from token-coloured shapes and Lucide icons where a Lucide
  icon expresses the part, with a comment naming AGENTS.md's exception and why no Lucide icon depicts
  "a board with three blocks on it". Do not extend that reasoning to a control's icon.
- **Tokens only**; the tour's surfaces use the existing `--surface-*`, `--text-*`, `--border-*`, radius and
  shadow tokens.
- **EN + HU in the same commit**, both dictionaries, for the tour's chrome. The tour's **content** is not in
  the i18n dictionary — it is content, stored per locale in the campaign columns (EN + HU), with the
  code-owned defaults holding both languages at parity. That split is ADR-0012's: campaign slide copy is
  campaign content, reusable controls and validation messages stay in the app dictionary.
- **"Artifact" never appears in the UI.** The tour says Document, App, Canvas, Slides (HU: Dokumentum,
  Alkalmazás, Tábla, Diasor). The tour's own name for `File` is not needed: File does not get a tour
  (see Non-goals).
- **One user, permanently.** The seen state is per user; there is no sharing, no team-level "we have all seen
  it", and no admin view of who has seen it beyond the campaign analytics that already exist.
- **The seen state is server-side.** Not `localStorage`, not a cookie. It follows the user across devices and
  survives a cleared browser. (The App prototype used `localStorage`; that is not a pattern to carry here.)
- **The tour is shown once per user per kind, and replaying never resets the state** — the same rule the app
  version badge already follows (`shouldPersistCampaignCompletion(mode) => mode === "auto"` in
  `src/lib/client/campaign-replay.ts`).
- **No new component library, no animation library.** The tour's transition is the app's existing motion
  tokens or none.
- **Every new `sqliteTable()` needs a migration, a `_journal.json` entry and a `scripts/prepare-db.ts`
  entry**, verified with `npm run check:migrations`.
- **`npm run check` stays at 0 errors, 0 warnings; `npm run build` emits 0 warnings.**

## Gates

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run check:migrations
npm run check && npx biome check src scripts tests && npm test && npm run build
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json
npx playwright test tests/e2e/artifact-tours.spec.ts tests/e2e/settings-admin.spec.ts \
  tests/e2e/artifacts-panel.spec.ts tests/e2e/incognito-indicator.spec.ts
```

## Review Focus

1. **The tour is not the campaign modal (Task T3).** It is a card inside the artifact panel, for the kind
   that is open, and it must not join `getEligibleCampaignForUser`'s one-at-a-time auto-show queue or appear
   from the sidebar App Version Badge. A tour that hijacks the app-level modal on load would fight the
   first-run onboarding and the release announcements that already own it.
2. **A code-owned default exists, so the feature works before anyone publishes anything (Tasks T2, T5).**
   ADR-0012 says seeded templates are not auto-published; a design that needs an admin to press publish
   before a single tour appears would ship a feature that looks broken.
3. **Seen-tracking is a new table, and it is small on purpose (Task T4).** It keys on
   `(user_id, artifact_type, content_key)` and holds **no conversation id and no artifact id**, so an
   incognito chat can mark a tour seen without the row revealing anything about that chat. The containment
   suite asserts exactly that.
4. **The empty state and the tour say the same thing (Task T6).** The summary line the tour shows is the
   empty state's text. A test asserts the shipped default and the slice-3/4 fallback i18n string agree, so
   editing one and not the other fails rather than drifts.
5. **The admin can change the words without a deploy, and publishing is a snapshot (Task T5).** The
   published revision is immutable; a re-publish re-shows the tour once (a new `content_key`), which is
   ADR-0012's existing behaviour and the reason the copy must be edited deliberately.

---

## Contracts

### The new campaign type

The campaign type union is closed and asserted: `CAMPAIGN_TYPES` in
`src/lib/server/services/announcement-campaigns.ts`, `assertType`, and `CampaignType` in
`src/lib/client/api/campaigns.ts`. Adding one is a service-plus-client change:

```ts
// announcement-campaigns.ts
export const CAMPAIGN_TYPES = ["first_run_onboarding", "release_update", "artifact_tour"] as const;
export type AnnouncementCampaignType = (typeof CAMPAIGN_TYPES)[number];
```

Slide layout values gain one:

```ts
export type AnnouncementCampaignSlideLayout = "setup" | "standard" | "summary";
```

`layout_type` is a text column, so this is a union value and a publish rule, not a schema change.

**Type-specific publish rules** (`validatePublishInput`, which already enforces
`first_run_onboarding` = exactly one `setup` slide + at least one `data_disclosure` slide):

- `artifact_tour` requires **exactly one `summary` slide** and **exactly three `standard` slides**, in that
  `sortOrder` order (summary first).
- EN + HU `title` and `body` remain required on every slide (the existing rule) — the summary slide's `title`
  is the empty state's one-line text and its `body` is the smaller second line, so no rule is relaxed.
- **No crop assets are required.** The existing rule requires EN + HU alt text only when a crop is attached,
  and a tour attaches none; its illustration is app-drawn per kind (see below). A `summary` or `standard`
  slide in an `artifact_tour` with a crop attached **is** allowed and gets the existing alt-text requirement.
- `semanticRole` is not constrained for this type (the `data_disclosure` requirement stays
  `first_run_onboarding`'s).

**The default tour content** is code-owned, one entry per kind, in
`src/lib/server/artifact-tour-defaults.ts` — the same shape as `prompts.ts`'s `SYSTEM_PROMPTS` registry:

```ts
export type ArtifactTourType = "document" | "app" | "canvas" | "slides";

export type ArtifactTourContent = {
	artifactType: ArtifactTourType;
	summary: { en: string; hu: string };
	slides: Array<{ title: { en: string; hu: string }; body: { en: string; hu: string } }>;
};

/** Bumping this re-shows every default tour once, deliberately. It is a
 *  product decision, not a cache key: raise it only when the shipped copy
 *  changed in a way a user should see again. */
export const ARTIFACT_TOUR_CONTENT_VERSION = 1;

export const ARTIFACT_TOUR_DEFAULTS: Record<ArtifactTourType, ArtifactTourContent>;
```

**The resolved tour** is what the panel sees, whether it came from code or from a snapshot:

```ts
// src/lib/server/services/artifact-tours.ts
export type ResolvedArtifactTour = {
	artifactType: ArtifactTourType;
	/** `snapshot:<id>` for a published campaign, `default:<version>` for the code copy. */
	contentKey: string;
	source: "published" | "default";
	/** Always three, in order. A published tour with any other count is not publishable. */
	slides: Array<{ title: { en: string; hu: string }; body: { en: string; hu: string } }>;
	/** The kind's empty-state line, from the summary slide (or the code default). */
	summary: { en: string; hu: string };
};

export async function getArtifactTour(params: {
	userId: string;
	artifactType: ArtifactTourType;
}): Promise<{ tour: ResolvedArtifactTour; seen: boolean; lastSlide: number } | null>;

export async function markArtifactTourSeen(params: {
	userId: string;
	artifactType: ArtifactTourType;
	contentKey: string;
	status: "completed" | "dismissed";
	lastSlide: number;
}): Promise<void>;

export async function seedArtifactTourDrafts(createdByUserId: string): Promise<{ created: number; existing: number }>;
```

`getArtifactTour` returns `null` only when the kind has neither a published campaign nor a code default —
which cannot happen for the four kinds, and is a `null` rather than a throw so a broken campaign table cannot
break the panel. A **published** tour wins over the default; a **draft or archived** one does not (a draft is
not live, and an archived campaign is a deliberate retirement — if an admin archives the Canvas tour, the
default does **not** silently reappear; the kind simply has no tour). That last rule is the one worth a
comment in the module, because "fall back to the default" is the tempting thing to do and it would make
archiving meaningless.

### The seen table

```sql
CREATE TABLE artifact_tour_states (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL,            -- 'document' | 'app' | 'canvas' | 'slides'
  content_key   TEXT NOT NULL,            -- 'snapshot:<id>' | 'default:<version>'
  status        TEXT NOT NULL,            -- 'completed' | 'dismissed'
  slide_count   INTEGER NOT NULL,         -- what the tour had when it was seen
  last_slide    INTEGER NOT NULL DEFAULT 0,
  completed_at  INTEGER,
  dismissed_at  INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX artifact_tour_states_user_type_content_unique_idx
  ON artifact_tour_states(user_id, artifact_type, content_key);
CREATE INDEX artifact_tour_states_user_type_idx ON artifact_tour_states(user_id, artifact_type);
```

Deliberate properties, each of which a test asserts:

- **No `conversation_id`, no `artifact_id`.** The row records that a kind of thing was explained, not what
  the user was working on. This is what lets an incognito chat's artifact open a tour without the row
  becoming a trace of that chat.
- **`content_key` in the unique key**, so publishing a new revision re-shows the tour once (new snapshot →
  new key) while an ordinary open does not.
- **`last_slide` so a tour can resume** where it was left if it was dismissed mid-way — with `status:
  "dismissed"` meaning "do not auto-show again" regardless of `last_slide`.
- One row per (user, kind, content). Insert-if-absent, like `completeCampaignForUser`.

### The panel's contract

```ts
// src/lib/components/artifact/tour/ArtifactTour.svelte
let {
	tour,
	startSlide = 0,
	onSeen,
	onDismiss,
	onReplayLater = undefined,
}: {
	tour: ResolvedArtifactTour;
	startSlide?: number;
	onSeen: (lastSlide: number) => void;
	onDismiss: (lastSlide: number) => void;
	onReplayLater?: (() => void) | undefined;
} = $props();
```

The panel owns the decision to show it; the tour owns its own steps and reports completion. `onSeen` fires
when the user reaches the end (the third slide's `Done`), `onDismiss` when they use `Skip` or close it, and
both persist through `markArtifactTourSeen` with `status` `completed` / `dismissed`. Replay passes
`onReplayLater={undefined}` and **neither callback writes a state row** — the replay path calls a no-op
`markArtifactTourSeen` guard, mirroring `shouldPersistCampaignCompletion(mode)`.

### Where it is triggered, and where it is not

| Surface | Tour? | Why |
|---|---|---|
| Opening any artifact of a kind, first time for this user | **yes** | the whole feature |
| Opening the same kind again | no | a state row exists for this `content_key` |
| The artifact's version badge menu → `How this kind works` | **yes, replay** | ADR-0012's replay path; no state written |
| The sidebar App Version Badge | **no** | that badge opens `getLatestPublishedCampaign`, which filters by type and never sees `artifact_tour` — assert this rather than assume it |
| `getEligibleCampaignForUser`'s auto-show | **no** | same reason; the tour is not in the queue |
| The Knowledge library | no | a tour is not an artifact |
| A brand-new empty artifact the user just created | **yes** | "created or reopened" — the first open of the kind is the first open, however it came to exist |

### The version badge menu

Slice 0 owns the panel header's version badge (`v7 · You and Alfy · saved just now`, opening the version
list). This slice adds one row to that menu, below the version list:

```
How this kind works        ← opens the tour in replay mode, no state written
```

and one **enabled** affordance in the panel's own empty state: the empty state shows the kind's summary line
and a quiet `How this kind works` link that opens the same replay. If Slice 0 or the relevant type slice has
not landed a badge menu, this slice adds the row to whatever menu exists and does not build a second one.

### The empty state

The empty state's one-line text comes from the resolved tour's `summary`, with the type slice's i18n key as
the fallback:

```ts
// src/lib/components/artifact/empty-state.ts
/** The kind's empty-state line: the tour's summary when it resolves, the i18n
 *  key when it does not. Both are shipped, and a test asserts they agree. */
export function emptyStateLine(tour: ResolvedArtifactTour | null, t: (key: string) => string, kind: ArtifactTourType): string;
```

Fallbacks and the shipped defaults that must match them:

| Kind | Fallback key | Default summary (EN) |
|---|---|---|
| Document | `artifacts.document.emptyState` | `Empty document. Start writing, or ask Alfy to draft it.` |
| App | `artifacts.app.emptyState` | `Nothing here yet. Ask Alfy to build a small tool.` |
| Canvas | `artifacts.canvas.emptyBoard` | `Empty board. Insert a block, or draw on it.` |
| Slides | `artifacts.slides.emptyDeck` | `Empty deck. Add a slide to start.` |

The Canvas and Slides keys are the ones slices 3 and 4 already ship. This slice makes the tour the source of
truth and those keys the fallback, and its test makes disagreement a failure rather than a copy-edit
accident.

### i18n (chrome only)

| Key | EN | HU |
|---|---|---|
| `artifacts.tour.region` | `How this kind works` | `Így működik ez a típus` |
| `artifacts.tour.stepOf` | `Step {n} of {m}` | `{n}. lépés, összesen {m}` |
| `artifacts.tour.dots` | `{count} steps` | `{count} lépés` |
| `artifacts.tour.next` | `Next` | `Tovább` |
| `artifacts.tour.back` | `Back` | `Vissza` |
| `artifacts.tour.done` | `Got it` | `Értem` |
| `artifacts.tour.skip` | `Skip` | `Kihagyás` |
| `artifacts.tour.close` | `Close` | `Bezárás` |
| `artifacts.tour.replayHint` | `You'll see this once. Replay it any time from the version badge.` | `Egyszer látod. A verziójelvényről bármikor újranézheted.` |
| `artifacts.tour.replay` | `Show it again` | `Újra megmutatja` |
| `artifacts.tour.replayOpened` | `Replaying` | `Újranézés` |
| `artifacts.tour.illustrationAlt` | `An illustration of a {kind}` | `Egy {kind} illusztrációja` |
| `artifacts.tour.loadFailed` | `Could not load the introduction.` | `Nem sikerült betölteni a bemutatót.` |
| `artifacts.tour.emptyStateFallback` | (used only if a kind has no tour at all) | — |

`{kind}` resolves through the existing `artifacts.type.*` rows (`artifacts.type.canvas` = `Canvas` / `Tábla`),
so the alt text cannot drift from the type name.

### The illustrations

`src/lib/components/artifact/tour/illustrations/` — one component per kind, `TourArtDocument.svelte`,
`TourArtApp.svelte`, `TourArtCanvas.svelte`, `TourArtSlides.svelte`, each a small picture of the thing:
a Document as three text lines and a checklist row, an App as a panel with two controls, a Canvas as a frame
with a note and a stroke, a Slides as a slide with a title bar. Each takes `{ class?: string }`, uses tokens
only, is `aria-hidden="true"` (the tour's text already says what it is; the `illustrationAlt` string is used
only when an illustration is shown without adjacent text), and carries the AGENTS.md-exception comment
described in Global Constraints. They are **not** screenshots: a screenshot would need re-taking on every UI
change, would need per-locale crops, and would be the campaign machinery's `desktop_crop`/`mobile_crop`
requirement — which is exactly the friction this design avoids.

---

## File ownership

| File | Change |
|---|---|
| `src/lib/server/db/schema.ts` | extend — `artifactTourStates` |
| `drizzle/<when>_artifact_tour_states.sql` + `drizzle/meta/_journal.json` | create — the table and its indexes |
| `scripts/prepare-db.ts` | extend — `requiredExistingTables` |
| `src/lib/server/services/artifact-tours.ts` + test | create — resolve, mark seen, seed |
| `src/lib/server/artifact-tour-defaults.ts` + test | create — the code-owned copy and its version |
| `src/lib/server/services/announcement-campaigns.ts` + test | extend — the `artifact_tour` type, the `summary` layout, the publish rules |
| `src/lib/client/api/campaigns.ts` | extend — the `CampaignType` and layout unions |
| `src/routes/api/artifact-tours/[type]/+server.ts` + test | create — GET the resolved tour and the seen state |
| `src/routes/api/artifact-tours/[type]/seen/+server.ts` + test | create — POST the state |
| `src/routes/api/admin/artifact-tours/seed/+server.ts` + test | create — seed the four drafts |
| `src/lib/client/api/artifact-tours.ts` + test | create — the browser calls |
| `src/lib/components/artifact/tour/ArtifactTour.svelte` + test | create — the panel card |
| `src/lib/components/artifact/tour/illustrations/*.svelte` | create — four illustrations |
| `src/lib/components/artifact/empty-state.ts` + test | create |
| `src/lib/components/document-workspace/DocumentWorkspace.svelte` | extend — the first-open trigger, the badge-menu row, the empty-state line |
| `src/routes/(app)/settings/_components/SettingsAdminCampaignsPane.svelte` | extend — the seed item for the four tour drafts |
| `src/routes/(app)/settings/_components/campaigns/SlideEditor.svelte` | extend — the `summary` layout's fields and the tour's publish checklist |
| `src/lib/i18n/artifacts.ts` + test | extend — `artifacts.tour.*` |
| `src/lib/server/services/account-lifecycle/user-scoped-tables.ts` | extend — `artifact_tour_states` |
| `src/lib/server/services/account-data-archive/*` + test | extend — the states in the archive and erasure |
| `tests/e2e/artifact-tours.spec.ts` | create |
| `tests/cross-cutting/incognito-artifact-containment.test.ts` | extend — the tour-state invariant |
| `src/lib/components/artifact/{document,app,canvas,slides}/…` | extend — the empty-state line reads through `emptyStateLine` |

**Serialisation.** `document-workspace/DocumentWorkspace.svelte` is Slice 0's file and the four type slices each touch it; land this
slice **after** them (the assignment's plan.md orders it last for this reason), and append rather than
restructure. `announcement-campaigns.ts` is shared with nothing else in Feature 2 — its changes are additive
to a closed union plus two new publish rules.

## Tasks

### Task T1: The table, the migration, and the lifecycle wiring

**Files:** `schema.ts`, the migration + `_journal.json`, `scripts/prepare-db.ts`,
`account-lifecycle/user-scoped-tables.ts`, `account-data-archive/*` + test
**Test:** integration

- [ ] **Step 1: Write the failing tests**

```ts
it("creates the artifact_tour_states table with its unique index", ...);
it("has a matching CREATE TABLE in a migration and a journal entry", ...);   // npm run check:migrations
it("lists the table in prepare-db's requiredExistingTables", ...);
it("marks artifact_tour_states as a user-scoped table", ...);
it("carries the states into the account archive", ...);
it("erases the states on account deletion", ...);
it("cascades the rows when the user is deleted", ...);
```

- [ ] **Step 2: Run them to verify they fail**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run check:migrations
npx vitest run tests/cross-cutting
```
Expected: FAIL — `check:migrations` reports a `sqliteTable` with no `CREATE TABLE`.

- [ ] **Step 3: Implement**

Add the table exactly as the Contracts block specifies, then the migration and the journal entry, then the
two lists that make it live in the lifecycle.

- [ ] **Step 4: Run them to verify they pass**

```bash
npm run check:migrations && npx vitest run tests/cross-cutting src/lib/server/services/account-data-archive
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/server/db drizzle scripts/prepare-db.ts src/lib/server/services/account-lifecycle \
  src/lib/server/services/account-data-archive
git commit -m "Remember that a kind of thing was explained, and nothing about the chat it was explained in

The row has no conversation id and no artifact id on purpose: a tour opens inside
an incognito chat too, and the promise there is that the chat leaves nothing
behind, not that the product cannot remember it taught you something."
```

### Task T2: The code-owned defaults and the resolver

**Files:** `artifact-tour-defaults.ts` + test, `artifact-tours.ts` + test
**Test:** unit

- [ ] **Step 1: Write the failing tests**

```ts
it("has a default for every tour type", ...);
it("gives every default exactly three slides", ...);
it("gives every default both en and hu for every title, body and summary", ...);
it("keeps en and hu at paragraph parity for every slide", ...);
it("never says the word artifact in any default string", ...);
it("names the type the way the UI does, per language", ...);
it("prefers a published campaign snapshot over the default", ...);
it("ignores a draft campaign", ...);
it("ignores an archived campaign and does not fall back to the default", ...);
it("keys a published tour as snapshot:<id> and a default as default:<version>", ...);
it("returns null for a kind with neither, without throwing", ...);
it("reports the seen state and the last slide for this user", ...);
it("reports seen: false for a different user", ...);
it("is unaffected by another kind's seen state", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

Write the four defaults' copy — this is the task's real content. Each kind's three slides answer, in order:
**what it is**, **what you can do with it**, **how to ask Alfy for it**. Then the resolver, with the
archived-is-a-retirement rule commented.

- [ ] **Step 4: Run them to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/server/artifact-tour-defaults.ts src/lib/server/services/artifact-tours.ts
git commit -m "Ship the tours in code, so the feature works before anyone publishes a campaign

A seeded campaign is a draft by ADR-0012, and a tour nobody has published yet is
not a tour. The code copy is the shipped default and a published campaign is the
override, which is the same shape the admin system prompts already use."
```

### Task T3: The panel card, its trigger, and the badge replay

**Files:** `ArtifactTour.svelte` + test, `illustrations/*.svelte`, `document-workspace/DocumentWorkspace.svelte`,
`src/lib/client/api/artifact-tours.ts` + test
**Test:** component + e2e

- [ ] **Step 1: Write the failing tests**

```ts
it("renders the first of three slides with its dots, and advances on Next", ...);
it("goes back, and never past the first or last slide", ...);
it("calls onSeen once, with the last slide index, when the user finishes", ...);
it("calls onDismiss with the current index when the user skips", ...);
it("shows the replay hint on the last slide", ...);
it("announces the step to assistive tech", ...);
it("is one region and traps no focus", ...);
it("calls neither callback when replaying", ...);
it("renders the current language's copy and switches languages live", ...);
it("survives a tour whose copy is missing a language by falling back to en", ...);

// e2e (artifact-tours.spec.ts)
it("shows the tour on the first open of a kind", ...);
it("does not show it on the second open", ...);
it("shows it again for a different kind", ...);
it("does not appear from the sidebar version badge", ...);
it("replays from the version badge menu and writes no new state", ...);
it("does not show it when the tour request fails, and does not break the panel", ...);
it("shows the same tour to a second user", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

Write the illustrations, then the card, then the trigger in `document-workspace/DocumentWorkspace.svelte`: on open, one request for
the kind; if it resolves and is unseen, render the card **in the panel's content area** above the artifact.
Fire the seen write on finish or skip, not on render — a user who closes the panel mid-tour has not seen it
and should meet it again next time (`lastSlide` is what makes that resumption sane).

- [ ] **Step 4: Run them to verify they pass**

```bash
npx vitest run src/lib/components/artifact
npx playwright test tests/e2e/artifact-tours.spec.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/components/artifact src/lib/client/api/artifact-tours.ts
git commit -m "Explain a kind of thing the first time it is opened, inside the panel it opened in

It is a card in the panel rather than the app-level campaign modal, because the
thing being explained is right there and the modal queue already belongs to
onboarding and release notes. The illustrations are drawn, not screenshotted:
a screenshot needs re-taking on every UI change and per-locale crops, and it
would be out of date the first time someone moves a button."
```

### Task T4: Seen-tracking, resumption, and the incognito invariant

**Files:** `/api/artifact-tours/[type]/seen/+server.ts` + test, `artifact-tours.ts` + test,
`tests/cross-cutting/incognito-artifact-containment.test.ts`
**Test:** integration + cross-cutting

- [ ] **Step 1: Write the failing tests**

```ts
it("records a completed tour once and is idempotent on a second write", ...);
it("records a dismissed tour and does not auto-show it again", ...);
it("keeps the last slide index on a dismissal", ...);
it("re-shows a kind's tour when a new snapshot is published", ...);
it("does not re-show it when the same snapshot is opened again", ...);
it("refuses a write for a type that is not a tour type", ...);
it("never stores a conversation id or an artifact id in the row", ...);
it("marks a tour seen inside an incognito chat, and the row still names only the kind", ...);
it("erases the user's states on erasure, so a recreated user sees the tours again", ...);
it("does not carry the seen state into telemetry with any content", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

The route validates the type against the tour union, then insert-if-absent. In the containment suite, add the
incognito case as an **explicitly allowed** behaviour with its reason in the test name and a comment, plus the
invariant that the row's columns cannot identify a conversation. A future reviewer will otherwise read the
allowed case as a leak.

- [ ] **Step 4: Run them to verify they pass**

```bash
npx vitest run tests/cross-cutting src/lib/server/services/artifact-tours.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/routes/api/artifact-tours src/lib/server/services/artifact-tours.ts tests/cross-cutting
git commit -m "Record what was taught, not where it was taught

An incognito chat may open a tour, and the state it writes names the kind and
nothing else, so the row cannot become a trace of the chat. The containment
suite says that out loud instead of leaving the next reader to guess whether it
was an oversight."
```

### Task T5: The admin side — seeding, editing, publishing

**Files:** `announcement-campaigns.ts` + test, `src/lib/client/api/campaigns.ts`, the seed route + test,
`SettingsAdminCampaignsPane.svelte`, `SlideEditor.svelte`
**Test:** unit + integration + e2e

- [ ] **Step 1: Write the failing tests**

```ts
it("accepts artifact_tour as a campaign type and refuses an unknown one", ...);
it("publishes a tour with exactly one summary and three standard slides", ...);
it("refuses a tour with two summary slides", ...);
it("refuses a tour with two standard slides", ...);
it("requires en and hu title and body on every slide", ...);
it("does not require a crop or alt text", ...);
it("accepts a crop on a tour slide and then requires its alt text", ...);
it("keeps a published tour immutable when the draft is edited", ...);
it("seeds four drafts, one per kind, and seeds nothing on a second call", ...);
it("gives each seeded draft a distinct identity key", ...);
it("leaves a seeded draft unpublished", ...);
it("records the tour's events in the campaign event ledger", ...);

// e2e (settings-admin.spec.ts)
it("seeds the four tour drafts from the Campaigns pane and shows them in the rail", ...);
it("edits the summary slide's text and publishes, and the panel shows the new copy", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

Extend the unions, add the publish rules, write `seedArtifactTourDrafts` (mirroring
`seedFirstRunOnboardingTemplate`'s return shape and its do-nothing-on-second-call behaviour), expose it
through the existing seed affordance in the Campaigns pane, and make `SlideEditor.svelte` render the
`summary` layout's fields with a hint that this slide is the kind's empty-state line.

- [ ] **Step 4: Run them to verify they pass**

```bash
npx vitest run src/lib/server/services/announcement-campaigns.test.ts
npx playwright test tests/e2e/settings-admin.spec.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/server/services/announcement-campaigns.ts src/lib/client/api/campaigns.ts \
  src/routes/api/admin src/routes/'(app)'/settings
git commit -m "Let a deployment rewrite what the tours say, without shipping a build

The copy is content, so it is edited where the other content is edited and
published as an immutable snapshot like every other campaign. Seeding writes
drafts, because ADR-0012 says a seeded template is not published for you."
```

### Task T6: The empty state says what the tour says

**Files:** `empty-state.ts` + test, the four type slices' empty-state call sites
**Test:** unit + e2e

- [ ] **Step 1: Write the failing tests**

```ts
it("returns the tour's summary when a tour resolves", ...);
it("returns the i18n fallback when the tour is null", ...);
it("returns the fallback when the tour resolves but has no summary in this language", ...);
it("keeps every shipped default's summary identical to its fallback string", ...);   // the drift guard
it("resolves the summary in hu when the language is hu", ...);

// e2e
it("shows the summary line in a new empty canvas's empty state", ...);
it("shows the edited campaign copy in the empty state after a publish", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

Write `emptyStateLine`, point the four kinds' empty states at it, and make the drift test read both sources
so editing one without the other is a failure.

- [ ] **Step 4: Run them to verify they pass**

```bash
npx vitest run src/lib/components/artifact
npx playwright test tests/e2e/artifact-tours.spec.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/components/artifact src/lib/i18n
git commit -m "Say the same sentence when the thing is empty and when it is explained

Two copies of one line is how a product starts describing itself two ways. The
tour's summary is the source and the i18n string is the fallback, and a test
fails when they disagree, so the next copy edit has one place to go."
```

### Task T7: i18n, lanes and the archive

**Files:** `src/lib/i18n/artifacts.ts` + test, `account-data-archive/*` + test
**Test:** unit + cross-cutting

- [ ] **Step 1: Write the failing tests**

```ts
it("has both en and hu for every artifacts.tour key", ...);
it("never shows the word artifact in either locale, in chrome or in default content", ...);
it("uses the ratified Hungarian type names in every default string that names a kind", ...);
it("keeps the illustration alt text built from artifacts.type.* in both languages", ...);
it("includes the tour states in the account archive", ...);
it("erases the tour states on account deletion", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

Fill both dictionaries and finish the archive and erasure coverage T1 opened.

- [ ] **Step 4: Run them to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/i18n src/lib/server/services/account-data-archive
git commit -m "Say Dokumentum, Alkalmazás, Tábla and Diasor in the tours too

The ratified names are the ones the rest of the interface uses, and the tour is
where a user learns them, so it is the worst place to invent a fifth word for
the same thing."
```

## Non-goals

- **No tour for the File type.** File is what `produce_file` already makes; its card explains itself and the
  user meets it in the chat. A tour for it would explain the app, not the thing. Four kinds, not five — see
  Open questions.
- **No tour inside the chat card.** The tour belongs to the panel, where the artifact is open.
- **No screenshots, no crops, no per-locale images.** The illustrations are drawn.
- **No video, no animation walkthrough, no spotlight/callout overlay** on the panel's controls.
- **No first-run onboarding changes.** That campaign type and its modal are untouched.
- **No change to `getEligibleCampaignForUser`, `getLatestPublishedCampaign` or the sidebar App Version
  Badge.**
- **No "don't show tours again" master switch.** A user who wants no more tours has already seen the four.
  (If a setting is wanted later, it is one preference row and this slice does not invent it.)
- **No admin view of who has seen a tour** beyond the campaign analytics that already exist.
- **No tour for an artifact type added later by anything other than this list** — a fifth kind gets its tour
  and its empty state in the slice that adds the kind.
- **No telemetry carrying tour text.** Event types and the kind are fine; the copy is not.

## Risks

| Risk | Why it bites | Mitigation |
|---|---|---|
| The tour joins the auto-show campaign queue | It fights the first-run onboarding and the release announcements for the one app-level modal | The `artifact_tour` type is filtered out of `getEligibleCampaignForUser` and `getLatestPublishedCampaign`, with an e2e asserting the sidebar badge never opens one |
| Nothing shows until an admin publishes | The feature looks broken out of the box | Code-owned defaults with a published campaign as the override |
| Archiving a tour resurrects the default | An admin's deliberate retirement is silently undone | The resolver does not fall back when an archived campaign exists for the kind; a test names that rule |
| The seen row becomes a trace of an incognito chat | The containment promise is broken by a row nobody thought of as content | No conversation id, no artifact id, and an explicitly-allowed case in the containment suite |
| A new snapshot re-shows every tour | Users who already know the type see it again | That is ADR-0012's intended behaviour for a genuinely new revision; the copy is edited deliberately and `ARTIFACT_TOUR_CONTENT_VERSION` exists for the code path, with a comment saying raising it is a product decision |
| The empty state and the tour disagree | The product describes one thing two ways | One source with a fallback and a drift test |
| The tour's copy is fetched on every panel open | A request per open for something shown once | The seen state is read in the same request; the client caches the kind's result for the session and the panel does not re-request on an artifact switch within the same kind |
| The illustration collides with the Lucide-only icon rule | A reviewer reads a bespoke SVG as a violation | Declared as an illustration, one per kind, with the AGENTS.md exception named in a comment; no control ever uses a bespoke SVG |
| The `summary` layout breaks the existing admin editor | A layout value the editor does not know about renders as a blank slide | The editor gains the `summary` case in the same commit, and the publish rule refuses a tour that does not have exactly one |

## Verification checklist

- [ ] Every task's tests were seen failing first, then green.
- [ ] `npm run check:migrations` — clean, with the new table in both the migration and the journal.
- [ ] `npm run check` — 0 errors, 0 warnings.
- [ ] `npx biome check src scripts tests` — clean.
- [ ] `npm test` — green, including the i18n key parity test, the drift test and the containment suite.
- [ ] `npm run build` — 0 warnings.
- [ ] `npx fallow --no-cache --format json --quiet --score` — no new findings, no new ignores.
- [ ] `npx playwright test tests/e2e/artifact-tours.spec.ts tests/e2e/settings-admin.spec.ts tests/e2e/artifacts-panel.spec.ts tests/e2e/incognito-indicator.spec.ts` — green.
- [ ] **Real-app visual check** against `claude-at-home-2-artifact-surfaces-mockups.html` §7 at **1440×900 and 390×844, light and dark**: three dots, the illustration, the `h3`, the body paragraph, the `.tourfoot` line and `Skip` / `Next` are all present and legible; the card sits inside the panel without pushing the artifact off screen; nothing overflows on the phone.
- [ ] **Staging, real model:** open a Canvas artifact for the first time → the tour appears; close the panel mid-tour → it appears again next open, on the slide it was left on; finish it → it does not appear again; open a Document → its own tour appears.
- [ ] **Staging:** the version badge menu's replay row shows the tour again and does **not** change the seen state (a reload after a replay does not re-show it automatically).
- [ ] **Staging:** make an empty Canvas → the empty state shows the same sentence the tour showed.
- [ ] **Staging, admin:** seed the four drafts, edit the Canvas summary, publish, reload the panel → the empty state and the tour show the new copy; re-publish again → the tour appears once more.
- [ ] **Staging:** the sidebar App Version Badge does not open a tour; the first-run onboarding campaign still shows exactly as before.
- [ ] **Staging:** open an artifact in an **incognito** chat → the tour appears, and the only row written names the kind.
- [ ] Read the staging service journal for new warnings.

## Open questions for the owner

1. **Four tours or five?** The mockup's legend says "three slides per kind", and the family has five types.
   This slice ships four (Document, App, Canvas, Slides) and leaves File out, because File is what
   `produce_file` already makes and its card explains itself. Say so if File should have one.
2. **The `summary` layout.** The tour's one-line summary is carried as a fourth slide with
   `layout_type: "summary"`, so the admin edits it in the same editor as the rest of the tour's copy and no
   schema changes. The alternative is a per-kind summary column on the campaign, which is a real migration
   for one string. This slice takes the layout value; say so if the column is preferred.
3. **Slices 3 and 4 already ship empty-state strings** (`artifacts.canvas.emptyBoard`,
   `artifacts.slides.emptyDeck`). This slice makes the tour's summary the source of truth for that line and
   those keys the fallback. If the tour is meant to be *only* an explainer and never the empty state's
   source, that inverts, and the drift test becomes a duplicate-text test instead.
4. **Whether a tour should appear inside an incognito chat at all.** This slice says yes (it is product
   content, not the user's content) and proves the row it writes cannot identify the chat. The stricter
   reading — incognito shows nothing the app would otherwise "remember" — is defensible and would be a
   three-line gate; it is asked rather than assumed.
