# Slice 6 — First-open tours: three slides per kind, once per user, editable by the admin

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking. Read `plan.md` first. **This slice needs Slice 0** (the artifact panel) and each type's slice for
> the panel it hangs in: Document (Slice 1), App (Slice 2), Canvas (Slice 3), Slides (Slice 4). It does not
> need Slice 5.

**Goal:** The first time a user opens an artifact of a kind, show a three-slide tour that says what it is,
what you can do with it, and how to ask Alfy for something — once per user per kind, replayable from the
panel's version affordance or its empty state, with the text living as **content** a deployment can edit in admin Settings (the
Announcement Campaign machinery of [ADR-0012](../../adr/0012-announcement-campaigns-and-first-run-onboarding.md))
rather than as strings frozen in a component.

**Architecture:** One panel-local component, `ArtifactTour.svelte`, shown inside the artifact panel — not the
app-level campaign modal. Its content is resolved through one new server service,
`src/lib/server/services/artifact-tours.ts`, which prefers a **published** tour campaign snapshot for the
kind and falls back to a **code-owned default** when no campaign has been published. **Four** kinds get a
tour — Document, App, Canvas, Slides; File does not (`decisions.md` ruling 8) — so the copy is
shippable out of the box (the defaults, in code, the `prompts.ts` `SYSTEM_PROMPTS` precedent) and
editable without a deploy (a published campaign, the campaign machinery). Seen-tracking is a small new
per-user table keyed `(user_id, artifact_type, content_key)` — **not** the campaign's user-state table,
because a code-owned default has no snapshot to key on, and because
[ADR-0012](../../adr/0012-announcement-campaigns-and-first-run-onboarding.md) says a seeded template is not
auto-published. The tour's one-line summary is the canonical copy for the kind's **empty state**, with the
i18n key as the fallback.

**Tech Stack:** the existing campaign service (`announcement-campaigns.ts`), the campaign admin pane and its
`SlideEditor.svelte` + `SlideOptionsDialog.svelte` + `campaign-checklist.ts`, a new `artifact_tour` campaign
type, Svelte 5 runes, one new table plus a migration, Vitest and Playwright.

**Spec:** `docs/plans/claude-at-home-2-artifacts-spec.md` §2 (decision 2: one panel), §5 (the panel),
§6 (cross-cutting: EN + HU, archive and erasure, migrations, telemetry without content).
ADRs: [ADR-0012](../../adr/0012-announcement-campaigns-and-first-run-onboarding.md) (campaigns, versioned and
localized, published snapshots immutable, seeded templates not auto-published, the version badge replays
without resetting completion state), [ADR-0066](../../adr/0066-artifacts-are-a-family-of-five-types.md) (each
type shows a three-slide tour the first time it is opened — read with `decisions.md` ruling 8: the four new
types, not File; "Artifact" is never shown in the UI),
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
  survives a cleared browser. (The only `localStorage` in the design set is the App artifact's own row storage in
  the App mockup — `claude-at-home-2-artifacts-mockups.html:216,230` — and the prototype findings
  (`-prototype-findings.md`) contain no tour at all. There is no prototype seen-state pattern to copy or reject;
  the table below is the design.)
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

`npm run lint` is the repo's script but it dies on the nested biome roots under `.claude/worktrees`; in a
worktree run `npx biome check src scripts tests` instead (this is the same substitution the other slices use).
`npm run check:migrations` **fails** a `sqliteTable` with no `CREATE TABLE` anywhere in `drizzle/`, but it
only **warns** — `console.warn`, exit 0, success line still printed — when the table is missing from
`prepare-db`'s `requiredExistingTables` (`scripts/verify-migrations.ts:67-85`). A clean exit carrying a
warning line is a fail for this slice, so read the output, not just the status:

## Review Focus

1. **The tour is not the campaign modal (Task T3, step T3.0).** It is a card inside the artifact panel, for
   the kind that is open. `getEligibleCampaignForUser` cannot reach it (`announcement-campaigns.ts:1115-1135`
   filters by type), but the **sidebar App Version Badge can**, because `getLatestPublishedCampaign`
   (`:1137-1151`) does not — so publishing a tour would put a kind tour behind the version badge and record
   `replay_opened` against it. T3.0 narrows that function to an explicit `campaignType` and passes
   `"release_update"` at the route. A reviewer who finds the badge still opening a tour has found the one
   defect this slice exists to prevent twice.
2. **A code-owned default exists, so the feature works before anyone publishes anything (Tasks T2, T5).**
   ADR-0012 says seeded templates are not auto-published; a design that needs an admin to press publish
   before a single tour appears would ship a feature that looks broken.
3. **Seen-tracking is a new table, and it is small on purpose (Task T4).** It keys on
   `(user_id, artifact_type, content_key)` and holds **no conversation id and no artifact id**, so the row can
   never become a trace of a chat. An incognito chat shows no tour at all (ruling 33 — a tour is a write, and
   incognito promises none), and the containment suite asserts the row's columns for the ordinary path.
4. **The empty state and the tour say the same thing (Task T6).** The summary line the tour shows is the
   empty state's text. A test asserts the shipped default and the slice-3/4 fallback i18n string agree, so
   editing one and not the other fails rather than drifts.
5. **The admin can change the words without a deploy, and publishing is a snapshot (Task T5).** The
   published revision is immutable; a re-publish re-shows the tour once (a new `content_key`), which is
   ADR-0012's existing behaviour and the reason the copy must be edited deliberately.

---

## Contracts

### The machinery this slice extends — verified, with line numbers

Read these before writing anything. Every claim in this slice about the campaign code was checked against the
tree; the ones that turned out **wrong** are called out here and corrected in place below, because they are the
things a dev agent would otherwise build on.

**What is true, and load-bearing for this slice.**

| Fact | Where |
|---|---|
| The type set is a `Set` plus a hand-written union, not an array | `announcement-campaigns.ts:17-19` (union), `:87-90` (`CAMPAIGN_TYPES`), `:188-198` (`assertType`) |
| `assertType`'s field error names the two types in prose and must be updated | `announcement-campaigns.ts:195-197` |
| Layout types are the same shape — a `Set` and a prose error | `announcement-campaigns.ts:91-94`, error text at `:734` |
| `layout_type` is a plain `text` column on both the draft and the snapshot table | `schema.ts:2127` (draft), `schema.ts:2214` (snapshot) |
| **The `summary` layout needs no migration and no schema change.** Only `artifact_tour_states` needs the migration | cited above; the migration in Task T1 is the table's |
| A published snapshot's slides are read back with `layoutType`, `title: {en,hu}`, `body: {en,hu}` already mapped | `announcement-campaigns.ts:223-241` (`mapSnapshotSlide`), `:1058-1074` (`getPublishedCampaignFromRow`) |
| Published snapshots are immutable: editing the draft touches `announcement_campaign_slides`, never the snapshot rows | `announcement-campaigns.ts:819-936` (`publishCampaign` copies draft rows into `announcement_campaign_snapshot_slides`) |
| A completion row is insert-if-absent, and a second write returns the existing row | `announcement-campaigns.ts:1159-1232` (`completeCampaignForUser`) — the pattern `markArtifactTourSeen` mirrors |
| **`getEligibleCampaignForUser` already filters by type**, so a tour can never enter the auto-show queue | `announcement-campaigns.ts:1115-1135` (calls `latestPublishedByType("first_run_onboarding")` then `"release_update"`, `:1076-1094`) |
| The campaign event ledger cannot carry tour copy: `sanitizeMetadata` stores metadata **only** for `setup_preference_changed` | `announcement-campaigns.ts:1234-1248` |
| Campaign user state and campaign events are registered `erasure: "cascade"`, `resets: []` — they survive Clear Memory and Clear Workspace | `account-lifecycle/user-scoped-tables.ts:389-404` |
| The Admin pane's publish button is gated by a **client-side** checklist, which is where a `summary` slide and an `artifact_tour` type must first become legal | `SettingsAdminCampaignsPane.svelte:183-206` (`clientValidationErrors`, `canPublish`), `campaign-checklist.ts:175-186` (type gate), `:225-234` (slide-kind gate) |
| Both the campaign type and the slide layout are enumerated **in prose** in two more places besides the `Set`s: the service's thrown field errors and the i18n validation messages | `announcement-campaigns.ts:195-197` (type) and `:730-737` (layout); `src/lib/i18n/settings.ts:170-171`, `:164-165` (EN) and `:2094-2095`, `:2089-2090` (HU) |
| The slide-kind picker is a hard-coded pair | `SlideOptionsDialog.svelte:81` (`['standard','setup']`), `:33` (`onChangeKind: (kind: "setup" \| "standard") => void`) |
| `SlideEditor.svelte` has **no** layout/kind field at all — it edits one locale's text and assets | `SlideEditor.svelte:2-17` (`EditorSlide`), `:43` (`BODY_GUIDE_LENGTH = 600`) |
| The seed route convention is a sibling under the campaigns admin root, and the service returns `{ campaign, created }` | `src/routes/api/admin/campaigns/seed-first-run/+server.ts:1-20`, `announcement-campaigns.ts:1404`, `:1496` |
| Campaign admin strings live in the **settings** dictionary, not in the new artifacts module, and the `admin.campaigns.*` rows are sorted alphabetically inside it | `src/lib/i18n/settings.ts` — EN block `:43-1085`, HU `:1967-3032` (`messages.*` `:88-95`, `slideKind.*` `:120-121`, `validation.typeInvalid` `:170-171`) |
| `t()` interpolates `{name}` and supports ICU plurals | `src/lib/i18n/index.ts:75-87` |
| The migration convention is `<when>_<slug>.sql` + a journal entry with a monotonically increasing `idx`; slice 0 takes `idx 124 / when 1777140000111` | `drizzle/1777140000109_project_knowledge_links.sql`, `drizzle/meta/_journal.json` (`idx 123 / when 1777140000110` is the last), `slice-0.md §The migration` |
| `check:migrations` errors (exit 1) on a `sqliteTable` with no `CREATE TABLE` anywhere in `drizzle/`, and **only warns** when the table is missing from `prepare-db`'s `requiredExistingTables` | `scripts/verify-migrations.ts:58-85` (error path `:67-74`, `:83-85`; warning `:76-81`) |
| The containment guard's PART B fires only on files that read `artifacts` / `artifactChunks` / `chatGeneratedFiles` / `projectKnowledgeLinks` — a table named `artifact_tour_states` never trips it, and an exemption for it would fail the guard's second test | `tests/cross-cutting/incognito-artifact-containment.test.ts:561-568`, `:498-508`, `:628-661` |
| The existing seen-once precedent is a single user column, not a table — and it is not enough for four kinds × N content keys | `schema.ts:64` (`users.home_memory_review_dismissed_at`) |
| The panel's version affordance today is a **chip strip**, rendered only when the family has more than one document, and it exists **twice** (docked and expanded headers) | `document-workspace/DocumentWorkspace.svelte:960-988` and `:1210+`, testids `document-version-control` / `document-version-badge` |

**What the slice previously got wrong.**

1. **`CAMPAIGN_TYPES` is not an `as const` array** and `CampaignType` on the client is **not** a closed union —
   it is already open (`"first_run_onboarding" | "release_update" | (string & {})`,
   `src/lib/client/api/campaigns.ts:6-9`, same for `CampaignSlideKind` at `:10`). Only the server asserts.
2. **The sidebar App Version Badge will open a published tour.** `getLatestPublishedCampaign`
   (`announcement-campaigns.ts:1137-1151`) filters on `status = "published"` **and nothing else**, and
   `/api/campaigns/latest/+server.ts:5-8` → `fetchLatestCampaign` → `(app)/+layout.svelte:524-535`
   (`handleAppVersionClick` → `openCampaign(campaign, "replay")`) shows whatever it returns in the app-level
   modal. With a Canvas tour published after the last release note, clicking `v…` opens **the tour**. This is a
   real defect this slice must fix, not assert away (see Task T3, step T3.0).
3. **There is no panel version *menu* anywhere in the slice set.** `slice-0.md` contracts a version *pill* on the
   card (`slice-0.md §The card`) and `slice-1.md` a per-type `VersionsSheet.svelte` (`slice-1.md §Task T6`); no
   slice defines a header badge that opens a menu. Task T3 must therefore be written against the host it finds —
   and ruling 32 has since ruled which host that is (see below).
4. `seedFirstRunOnboardingTemplate` returns `{ campaign, created: boolean }`, not counts (see below).
5. The migration is not named `drizzle/0NNN_<slug>.sql`.

### The new campaign type

The server-side type surface is a union, a `Set` and `assertType`; adding a value touches all three, plus the
prose error a person reads in the admin form. This is the exact shape to end up with:

```ts
// announcement-campaigns.ts
export type AnnouncementCampaignType =
	| "first_run_onboarding"
	| "release_update"
	| "artifact_tour";

const CAMPAIGN_TYPES = new Set<AnnouncementCampaignType>([
	"first_run_onboarding",
	"release_update",
	"artifact_tour",
]);
```

and `assertType`'s field error becomes
`"Campaign type must be first_run_onboarding, release_update or artifact_tour."` (`:196`), with a test asserting
that string for an unknown type.

Slide layout values gain one, in the same three places:

```ts
export type AnnouncementCampaignSlideLayout = "setup" | "standard" | "summary";

const LAYOUT_TYPES = new Set<AnnouncementCampaignSlideLayout>(["setup", "standard", "summary"]);
```

and the layout error at `:734` becomes `"Slide layout must be setup, standard or summary."` — it is the message
the admin sees when a `summary` slide is rejected by an older build, so it must not lie.

`layout_type` is a `text` column on both tables (`schema.ts:2127`, `:2214`), so **the `summary` layout is a union
value plus a publish rule and needs no migration and no schema change.** The only schema work in this slice is the
new `artifact_tour_states` table (Task T1). The client unions
(`src/lib/client/api/campaigns.ts:6-10`) are open already; widening them is a readability change, not a
requirement — but do it, so the editor's own label lookups are type-checked.

**Type-specific publish rules** (`validatePublishInput`, which already enforces
`first_run_onboarding` = exactly one `setup` slide + at least one `data_disclosure` slide):

- `artifact_tour` requires **exactly one `summary` slide** and **exactly three `standard` slides**, in that
  `sortOrder` order (summary first). Concretely: four slides with `sortOrder` **1 (summary), 2, 3, 4**, because
  `announcement_campaign_slides` carries a unique index on `(campaign_id, sort_order)`
  (`schema.ts:2163-2165`) and negative or duplicate orders are rejected at `:746-757`. The publish rule reads the
  slides ordered by `sortOrder` (`announcement-campaigns.ts:846-851`) and must assert `slides[0].layoutType ===
  "summary"` and `slides.slice(1).every(s => s.layoutType === "standard")`, not merely the counts.
- EN + HU `title` and `body` remain required on every slide (the existing rule) — the summary slide's `title`
  is the empty state's one-line text and its `body` is the smaller second line, so no rule is relaxed.
- **No crop assets are required.** The existing rule requires EN + HU alt text only when a crop is attached,
  and a tour attaches none; its illustration is app-drawn per kind (see below). A `summary` or `standard`
  slide in an `artifact_tour` with a crop attached **is** allowed and gets the existing alt-text requirement.
- `semanticRole` is not constrained for this type (the `data_disclosure` requirement stays
  `first_run_onboarding`'s).

**The four-value type is derived, not re-declared.** `ArtifactKind` already is
`"document" | "app" | "canvas" | "slides" | "file"` in the shared module Slice 0 creates
(`slice-0.md §The boundary`), so the tour union is `Exclude<ArtifactKind, "file">` — ruling 8 expressed as a type
rather than as four string literals that can drift. The shared, client-safe types go in a new file in that
same directory (no runtime imports, like `kinds.ts`):

```ts
// src/lib/shared/artifacts/tours.ts — client-safe, type-only, no runtime imports
import type { ArtifactKind } from "./kinds";

/** Ruling 8: File gets no tour, because produce_file is not a new kind. */
export type ArtifactTourType = Exclude<ArtifactKind, "file">;

export type LocalizedText = { en: string; hu: string };
export type ArtifactTourSlideContent = { title: LocalizedText; body: LocalizedText };

export type ResolvedArtifactTour = {
	artifactType: ArtifactTourType;
	/** `snapshot:<id>` for a published campaign, `default:<version>` for the code copy. */
	contentKey: string;
	source: "published" | "default";
	/** Always three, in order. A published tour with any other count is not publishable. */
	slides: ArtifactTourSlideContent[];
	/** The kind's empty-state line, from the summary slide (or the code default). */
	summary: LocalizedText;
};

export type ArtifactTourState = { seen: boolean; lastSlide: number };
```

`Exclude` plus an exhaustive `Record` is what makes a sixth kind safe: adding one to `ArtifactKind` widens
`ArtifactTourType`, and `ARTIFACT_TOUR_DEFAULTS` below then fails to compile until the new kind has copy —
which is the desired direction of failure (a missing tour is loud, a silently-untoured kind is not). A test
asserts `ARTIFACT_TOUR_DEFAULTS` has exactly the four keys and that `"file"` is not among them.

**The default tour content** is code-owned, one entry per kind, in
`src/lib/server/artifact-tour-defaults.ts` — the same shape as `prompts.ts`'s `SYSTEM_PROMPTS` registry:

```ts
// src/lib/server/artifact-tour-defaults.ts
import type { ArtifactTourContent, ArtifactTourType } from "$lib/shared/artifacts/tours";

export type ArtifactTourContent = {
	artifactType: ArtifactTourType;
	summary: LocalizedText;
	slides: ArtifactTourSlideContent[]; // exactly three, checked in the test
};

/** Bumping this re-shows every default tour once, deliberately. It is a
 *  product decision, not a cache key: raise it only when the shipped copy
 *  changed in a way a user should see again. */
export const ARTIFACT_TOUR_CONTENT_VERSION = 1;

export const ARTIFACT_TOUR_DEFAULTS: Record<ArtifactTourType, ArtifactTourContent>;

/** Narrowing helper shared by the routes; the only place the four strings
 *  are enumerated at runtime. */
export function isArtifactTourType(value: string): value is ArtifactTourType;
```

**The service** — `src/lib/server/services/artifact-tours.ts`, two public reads/writes plus the seed:

```ts
// src/lib/server/services/artifact-tours.ts
import type { ArtifactTourType, ResolvedArtifactTour } from "$lib/shared/artifacts/tours";

export type ArtifactTourLookup = {
	tour: ResolvedArtifactTour;
	seen: boolean;
	lastSlide: number;
};

export async function getArtifactTour(params: {
	userId: string;
	artifactType: ArtifactTourType;
	options?: CampaignServiceOptions; // the existing { db?, ids? } seam, for tests
}): Promise<ArtifactTourLookup | null>;

export async function markArtifactTourSeen(params: {
	userId: string;
	artifactType: ArtifactTourType;
	contentKey: string;
	status: "completed" | "dismissed";
	lastSlide: number;
	options?: CampaignServiceOptions;
}): Promise<{ ok: true; alreadyRecorded: boolean }>;

export async function seedArtifactTourDrafts(
	createdByUserId: string,
	options?: CampaignServiceOptions,
): Promise<{ created: number; existing: number }>;
```

`markArtifactTourSeen` returns a value rather than `void` so the route can answer `alreadyRecorded` without a
second read, and so the idempotence is a returned fact the test can assert.

**The identity rule for four drafts** — the trap the seed walks into if this is left implicit.
`identityFor(type, version, revision)` is `` `${type}:${version}:r${revision}` ``
(`announcement-campaigns.ts:170-176`), it is `UNIQUE` (`schema.ts:2082`), and
`announcement_campaigns_version_revision_unique_idx` is unique on `(type, campaign_version, revision)`
(`schema.ts:2111-2112`). `defaultVersionFor` returns `"v1"` for every type that is not `release_update`
(`:178-186`), and `nextRevision` counts rows by `(type, campaignVersion)` (`:349-368`). So four
`createCampaignDraft({ type: "artifact_tour" })` calls would produce `artifact_tour:v1:r1 … r4` — four distinct
keys, but four *revisions of one version string*, which makes the admin rail read as one campaign's history and
makes "publish the Canvas tour without touching the Document tour" indistinguishable in the UI. **Set
`releaseVersion` to the kind** (`"document" | "app" | "canvas" | "slides"`), which `defaultVersionFor` uses as the
campaign version for that type, giving `artifact_tour:document:r1`, `artifact_tour:app:r1`,
`artifact_tour:canvas:r1`, `artifact_tour:slides:r1` — unique, per-kind, and stable across re-seeds. A test
asserts the four keys are distinct **and** that the second call creates nothing (the same do-nothing-on-second-call
behaviour as `seedFirstRunOnboardingTemplate`, `:1389-1405`). Note the seed must not depend on the first-run
service's return shape: that one returns `{ campaign, created }` (`:1496`), which cannot describe four campaigns;
this seed returns counts, and the route maps `created > 0` to 201.

`getArtifactTour` returns `null` only when the kind has neither a published campaign nor a code default —
which cannot happen for the four kinds, and is a `null` rather than a throw so a broken campaign table cannot
break the panel. A **published** tour wins over the default; a **draft or archived** one does not (a draft is
not live, and an archived campaign is a deliberate retirement — if an admin archives the Canvas tour, the
default does **not** silently reappear; the kind simply has no tour). That last rule is the one worth a
comment in the module, because "fall back to the default" is the tempting thing to do and it would make
archiving meaningless.

### The routes, literally

Three routes, all `RequestHandler`s. Two rules apply to all of them: the user id is **only** ever
`event.locals.user.id`, never a query parameter, body field or path segment; and they use
`requireApiUser` (`src/lib/server/api/auth.ts:10-21`), **not** `requireAuth` — the latter 302-redirects a
`fetch` to the HTML login page (`src/lib/server/auth/hooks.ts:9-15`), and the panel would then parse a login
page as JSON. The campaign routes made the other choice (`src/routes/api/campaigns/eligible/+server.ts:6`);
these are fetched by the panel, so they follow the API seam and answer `401 {"message":"Unauthorized"}`
(SvelteKit renders a thrown `error()` from a `+server` endpoint as JSON). This is a deliberate deviation from
the sibling route — say so in the review.

**1. `src/routes/api/artifact-tours/[type]/+server.ts` — GET, session auth**

```ts
// GET /api/artifact-tours/document
import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { getArtifactTour } from "$lib/server/services/artifact-tours";
import { isArtifactTourType } from "$lib/shared/artifacts/tours";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	if (!isArtifactTourType(event.params.type)) {
		return json({ ok: false, reason: "unknown_type" }, { status: 404 });
	}
	const result = await getArtifactTour({
		userId: user.id,
		artifactType: event.params.type,
	});
	if (!result) return json({ tour: null, seen: false, lastSlide: 0 });
	return json(result); // { tour, seen, lastSlide }
};
```

- **200** `{ tour: ResolvedArtifactTour | null, seen: boolean, lastSlide: number }`. A missing tour is a
  200 with `tour: null`, never a 404 — the panel renders the type's i18n fallback line and must not treat a
  missing tour as a failed request (that would paint an error over a working panel).
- **404** `{ ok: false, reason: "unknown_type" }` for a `[type]` that is not one of the four. The path is a
  resource address, so 404 is right and 400 would be wrong. Every failure of this route family carries the
  family's `{ ok: false, reason, … }` body — the same shape Slice 3's ops route answers with — and not
  `createJsonErrorResponse`'s `{ error }`, which the panel would have to parse twice. `file` is **not** a tour type (ruling 8), so
  `/api/artifact-tours/file` is a 404 like any other unknown segment.
- **401** `{ message: "Unauthorized" }` — no session.
- The route never throws for a campaign-table problem: `getArtifactTour` catches its own read failure and
  returns the default (see failure modes).

**2. `src/routes/api/artifact-tours/[type]/seen/+server.ts` — POST, session auth**

Request body (Zod-free, hand-validated like the rest of these routes):

```ts
{ contentKey: string;          // "snapshot:<id>" | "default:<version>"
  status: "completed" | "dismissed";
  lastSlide: number }          // 0-based, 0..2
```

Responses:

- **200** `{ ok: true, alreadyRecorded: boolean }`. Idempotent: a second identical POST returns
  `alreadyRecorded: true` and writes nothing, exactly as `completeCampaignForUser` is insert-if-absent
  (`announcement-campaigns.ts:1159-1232`). The panel may fire and forget; a retry after a dropped connection
  must not create a second row (the unique index would refuse it —
  `artifact_tour_states_user_type_content_unique_idx` in T1's DDL — and the route would 500 where it should
  say `ok`).
- **400** `{ ok: false, reason: "invalid_state", fieldErrors: { <field>: "invalid" } }` — a `status` outside the two
  values, a `lastSlide` that is not an integer in range, or a missing `contentKey`.
- **401** as above; **404** unknown `[type]`.
- **409** `{ ok: false, reason: "content_changed", contentKey: <the current key> }` when `contentKey` names
  something other than the tour that currently resolves for that kind. This is the real race: an admin
  publishes a new snapshot while a user is mid-tour. Losing that race silently would record "seen" against
  the old copy while the user is looking at the new one; the panel answers a 409 by re-fetching the tour and
  rendering the new copy from slide 0. The key is *not* trusted for anything but this comparison.

**3. `src/routes/api/admin/campaigns/seed-artifact-tours/+server.ts` — POST, admin**

A literal sibling of `seed-first-run/+server.ts`, with one deliberate difference in the return shape:

```ts
export const POST: RequestHandler = async (event) => {
	requireAdmin(event); // 302 to /login, then error(403, "Forbidden") — auth/hooks.ts:149-160
	try {
		const result = await seedArtifactTourDrafts(event.locals.user.id);
		return json(result, { status: result.created > 0 ? 201 : 200 });
	} catch (error) {
		return campaignErrorResponse(error, "Failed to seed artifact tour drafts.");
	}
};
```

- **200/201** `{ created: number; existing: number }` — counts, not a single campaign: the first-run seed
  returns `{ campaign, created }` (`announcement-campaigns.ts:1496`) because it seeds one campaign, and this
  one seeds four.
- **403** empty body with SvelteKit's `Forbidden` for a non-admin, **302** to `/login` unauthenticated —
  `requireAdmin` is outside the `try` on purpose, so a thrown redirect or `error()` is not swallowed by
  `campaignErrorResponse`.
- **400** `{ error, fieldErrors }` if a draft fails validation, via the campaign error mapper
  (`src/routes/api/admin/campaigns/_shared.ts:4-13`); **500** `{ error: "Failed to seed artifact tour drafts." }`
  otherwise. Because each draft is created in its own insert, a partial failure leaves the created drafts in
  place and reports the count — the endpoint is re-runnable and does not need a transaction.

**Client API** (`src/lib/client/api/artifact-tours.ts`, the only browser entry point; the panel and the admin
pane never call `fetch` themselves — AGENTS.md's rule):

```ts
import { type FetchLike, requestJson } from "./http"; // requestJson: http.ts:318-323
import type {
	ArtifactTourState,
	ArtifactTourType,
	ResolvedArtifactTour,
} from "$lib/shared/artifacts/tours";

/** The wire shape, defined once in the shared module so the browser and the
 *  server cannot drift (client code may not import $lib/server). */
export type ArtifactTourResponse = ArtifactTourState & {
	tour: ResolvedArtifactTour | null;
};

export async function fetchArtifactTour(
	artifactType: ArtifactTourType,
	fetchImpl: FetchLike = fetch,
): Promise<ArtifactTourResponse>   // { tour, seen, lastSlide }

export async function markArtifactTourSeen(
	artifactType: ArtifactTourType,
	payload: { contentKey: string; status: "completed" | "dismissed"; lastSlide: number },
	fetchImpl: FetchLike = fetch,
): Promise<{ ok: true; alreadyRecorded: boolean }>

export async function seedArtifactTours(
	fetchImpl: FetchLike = fetch,
): Promise<{ created: number; existing: number }>  // "/api/admin/campaigns/seed-artifact-tours"
```

They follow `seedFirstRunCampaign` (`src/lib/client/api/campaigns.ts:262-271`) exactly: `requestJson` with a
fallback message (`"Failed to load the introduction"`, `"Failed to record the introduction"`,
`"Failed to seed artifact tours"`), and the 409 is surfaced as an `ApiError` with `status: 409` rather than
being special-cased in the client module — the panel's own catch reads `.status`.

### The shipped copy — twelve slides, four summaries

This is the default that ships, written out so the implementer is not inventing product voice. Each kind's
three slides answer the same three questions in the same order: **what it is**, **what you can do with it**,
**how to ask Alfy for it**. The third slide is the one that earns the tour its keep — a user who finishes it
knows the sentence that gets them a Document instead of a paragraph of prose. Ruling 8's File has no entry.
No string says "artifact" (ADR-0066: the word is never user-visible), and the Hungarian reads as Hungarian,
not as a gloss.

**`document` — Document / Dokumentum**

| # | EN | HU |
|---|---|---|
| summary | `Empty document. Start writing, or ask Alfy to draft it.` | `Üres dokumentum. Kezdj el írni, vagy kérd meg Alfyt, hogy megírja.` |
| 1 title | `A page you both write on` | `Egy lap, amit ketten írtok` |
| 1 body | `A document is a real file you keep, not a message that scrolls away. Alfy edits it with you, and every version is kept.` | `A dokumentum igazi fájl, ami megmarad — nem üzenet, ami elgörög. Alfy együtt szerkeszti veled, és minden verzió megmarad.` |
| 2 title | `What you can do in it` | `Mit tudsz benne csinálni` |
| 2 body | `Type directly, tick off checklists, and add tables or tabs. Alfy's changes arrive highlighted, with Keep and Undo beside them.` | `Írhatsz közvetlenül, kipipálhatod a listákat, és táblázatokat vagy füleket adhatsz hozzá. Alfy módosításai kiemelve érkeznek, mellettük a Megtartás és a Visszavonás.` |
| 3 title | `How to ask for one` | `Hogyan kérj ilyet` |
| 3 body | `Say what you need — "write up the meeting notes", "draft the letter" — and Alfy opens it here. Any answer can also be opened as a document.` | `Mondd el, mire van szükséged — „írd meg a megbeszélés jegyzőkönyvét”, „fogalmazd meg a levelet” —, és Alfy itt nyitja meg. Bármelyik válasz megnyitható dokumentumként is.` |

**`app` — App / Alkalmazás**

| # | EN | HU |
|---|---|---|
| summary | `Nothing here yet. Ask Alfy to build a small tool.` | `Itt még nincs semmi. Kérd meg Alfyt, hogy építsen egy kis eszközt.` |
| 1 title | `A small tool that runs here` | `Egy kis eszköz, ami itt fut` |
| 1 body | `A self-contained program built for one job: a calculator, a quiz, a tracker. It runs here, in this panel, beside the chat that made it.` | `Önálló program, egyetlen feladatra: egy kalkulátor, egy kvíz, egy nyilvántartó. Itt fut, ebben a panelben, a chat mellett, amiben készült.` |
| 2 title | `It remembers what you put in it` | `Megjegyzi, amit beírtál` |
| 2 body | `Your answers are stored with the app, so they are still there tomorrow. They stay in your account, and nothing is shared.` | `A válaszaid az alkalmazásnál maradnak, így holnap is ott lesznek. A fiókodban maradnak, és semmi nem kerül megosztásra.` |
| 3 title | `How to ask for one` | `Hogyan kérj ilyet` |
| 3 body | `Describe the tool and the job: "a tip calculator", "a quiz on the French Revolution". Alfy builds it, checks the numbers, then shows it.` | `Írd le az eszközt és a feladatát: „borravaló-kalkulátor”, „kvíz a francia forradalomról”. Alfy megépíti, ellenőrzi a számokat, aztán megmutatja.` |

**`canvas` — Canvas / Tábla**

| # | EN | HU |
|---|---|---|
| summary | `Empty board. Insert a block or draw on it.` | `Üres tábla. Szúrj be egy blokkot, vagy rajzolj rá.` |
| 1 title | `A board for anything` | `Egy tábla, bármire` |
| 1 body | `A free surface: sticky notes, frames, arrows and live blocks, arranged however you think. It is for arranging, not for writing.` | `Szabad felület: cetlik, keretek, nyilak és élő blokkok, úgy elrendezve, ahogy gondolkodsz. Rendezésre való, nem írásra.` |
| 2 title | `Draw on it, and place things` | `Rajzolj rá, és helyezz el dolgokat` |
| 2 body | `Sketch with pen and highlighter, drop in a chart, a checklist, a map or a file, then pan and zoom without losing the thread.` | `Firkálhatsz tollal és kiemelővel, behúzhatsz diagramot, listát, térképet vagy fájlt, aztán görgethetsz és nagyíthatsz anélkül, hogy elveszítenéd a fonalat.` |
| 3 title | `How to ask for one` | `Hogyan kérj ilyet` |
| 3 body | `Ask for a board when the shape of the problem matters: "put the trip options on a board". Alfy can also rearrange a board you already have.` | `Akkor kérj táblát, amikor a probléma elrendezése számít: „tedd a táblára az útiterveket”. Egy meglévő táblát is át tud rendezni.` |

**`slides` — Slides / Diasor**

| # | EN | HU |
|---|---|---|
| summary | `Empty deck. Add a slide to start.` | `Üres diasor. Adj hozzá egy diát a kezdéshez.` |
| 1 title | `A deck you can present` | `Egy diasor, amit bemutathatsz` |
| 1 body | `A real deck: a fixed set of layouts, speaker notes, and a present mode that fills the screen.` | `Igazi diasor: rögzített elrendezések, előadói jegyzetek, és egy vetítő mód, ami kitölti a képernyőt.` |
| 2 title | `Built for export` | `Exportra készült` |
| 2 body | `Because the layouts are fixed, the deck exports to PowerPoint cleanly. The file is a real .pptx, not a picture of one.` | `Mivel az elrendezések rögzítettek, a diasor tisztán exportálható PowerPointba. A fájl igazi .pptx, nem annak a képe.` |
| 3 title | `How to ask for one` | `Hogyan kérj ilyet` |
| 3 body | `Ask for a deck and say who it is for: "a six-slide intro to the project for Monday". You can also ask about one slide at a time.` | `Kérj diasort, és mondd meg, kinek szól: „hat diás bemutató a projektről hétfőre”. Egyetlen diáról is kérdezhetsz.` |

Two mechanical consequences of this table. First, **the four summaries are the empty-state fallbacks' twins** —
the `summary` row here must equal the corresponding `artifacts.*.emptyState` / `artifacts.{canvas,slides}.*`
value in the i18n table below, character for character, and T6's test is what keeps them equal. Second,
**the copy lives in one place per kind**: a published campaign's slides replace the whole three-slide set and
the summary together (the snapshot is atomic), so an admin editing one doesn't leave the other half stale.

### The seen table

**Migration: generate it, do not hand-name it.** The convention in this tree is
`drizzle/<when>_<slug>.sql` plus one `_journal.json` entry (`drizzle/1777140000109_project_knowledge_links.sql`
with `{"idx": 122, "version": "7", "when": 1777140000109, "tag": "1777140000109_project_knowledge_links",
"breakpoints": true}`; the last entry today is `idx 123 / when 1777140000110`). Slice 0 claims `idx 124 /
when 1777140000111` (`slice-0.md §The migration`). **Take the next free number from the tree at the moment you branch** —
if slice 0 has landed, that is `idx 125 / when ~1777140000112`, and the file is
`drizzle/1777140000112_artifact_tour_states.sql`. Never reuse a number printed in a document, and never rename an
existing file. Run `npx drizzle-kit generate` after adding the `sqliteTable` and commit what it writes; the shape
below is what it should produce, in the repo's own DDL style (`--> statement-breakpoint` between statements,
backticked identifiers — compare `drizzle/1777140000109_project_knowledge_links.sql`):

```sql
CREATE TABLE `artifact_tour_states` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`artifact_type` text NOT NULL,
	`content_key` text NOT NULL,
	`status` text NOT NULL,
	`slide_count` integer NOT NULL,
	`last_slide` integer DEFAULT 0 NOT NULL,
	`completed_at` integer,
	`dismissed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_tour_states_user_type_content_unique_idx` ON `artifact_tour_states` (`user_id`,`artifact_type`,`content_key`);
--> statement-breakpoint
CREATE INDEX `artifact_tour_states_user_type_idx` ON `artifact_tour_states` (`user_id`,`artifact_type`);
```

Column meanings are fixed: `artifact_type` is the four-value tour union, `content_key` is
`'snapshot:<id>' | 'default:<version>'`, `status` is `'completed' | 'dismissed'`, `slide_count` is what the tour
had when it was seen (so a later three-slide rule change cannot make an old row read as short), `last_slide` is
0-based. `completed_at`/`dismissed_at` are set on the write that sets `status` and never both.
`scripts/prepare-db.ts` gains `"artifact_tour_states"` in `requiredExistingTables` (`scripts/prepare-db.ts:32-…`;
`check:migrations` only warns about a missing entry — `scripts/verify-migrations.ts:76-81` — so the warning is
the only thing that catches an omission, and it must not be left in the output).

Deliberate properties, each of which a test asserts:

- **No `conversation_id`, no `artifact_id`.** The row records that a kind of thing was explained, not what
  the user was working on, so it can never become a trace of a chat. Incognito goes further and shows no tour
  at all (`decisions.md` ruling 33: a tour is a write, and incognito promises none), so there is no row to
  trace in the first place.
- **`content_key` in the unique key**, so publishing a new revision re-shows the tour once (new snapshot →
  new key) while an ordinary open does not.
- **`last_slide` so a tour can resume** where it was left if it was dismissed mid-way — with `status:
  "dismissed"` meaning "do not auto-show again" regardless of `last_slide`.
- One row per (user, kind, content). Insert-if-absent, like `completeCampaignForUser`.

### The panel's contract

```ts
// src/lib/components/artifacts/tour/ArtifactTour.svelte
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
| The panel's artifact-list menu → `How this kind works` | **yes, replay** | ADR-0012's replay path, offered in the panel (ruling 32); no state written |
| The sidebar App Version Badge | **no, and it must be made not to** | `/api/campaigns/latest` has no type filter today, so publishing a tour would hijack the app-level modal — see below |
| `getEligibleCampaignForUser`'s auto-show | **no** | already type-filtered — `announcement-campaigns.ts:1115-1135` |
| The Knowledge library | no | a tour is not an artifact |
| A brand-new empty artifact the user just created | **yes** | "created or reopened" — the first open of the kind is the first open, however it came to exist |

**The sidebar badge is a defect this slice must fix, not a property it can rely on.** The App Version Badge
harness in the app shell calls `getLatestPublishedCampaign` through `/api/campaigns/latest`
(`src/routes/api/campaigns/latest/+server.ts`) and opens whatever comes back with mode `"replay"`
(`src/routes/(app)/+layout.svelte:524-535`, `:481-491`). `getLatestPublishedCampaign`
(`src/lib/server/services/announcement-campaigns.ts:1137-1151`) selects the newest published campaign with
**no `campaignType` predicate at all** — unlike `getEligibleCampaignForUser`, which filters on
`campaignType` before returning (`:1115-1135`). So the moment a tour is published, the badge would open a
three-slide kind tour instead of the release note it exists for, and `replay_opened` telemetry would be
recorded against the tour. `getEligibleCampaignForUser` tolerates this only because tours are never in its
queue; the badge path has no such protection.

The fix reuses the filter that already exists. `latestPublishedByType(type, db)`
(`announcement-campaigns.ts:1076-1094`) is exactly the query with the type predicate; the exported function
just does not use it:

```ts
// src/lib/server/services/announcement-campaigns.ts — replaces :1137-1151
export async function getLatestPublishedCampaign(
	campaignType: AnnouncementCampaignType,
	options: CampaignServiceOptions = {},
) {
	return latestPublishedByType(campaignType, database(options));
}
```

and the route passes the badge's type (`src/routes/api/campaigns/latest/+server.ts:8`):

```ts
return json({ campaign: await getLatestPublishedCampaign("release_update") });
```

The parameter is **required** — an optional one leaves the next caller free to reintroduce the bug, and the
compiler then finds every call site for us. There are exactly four: the route above, and three tests that
need the argument (`src/lib/server/services/announcement-campaigns.test.ts:17,183`,
`src/routes/api/campaigns/campaigns.test.ts:21,30,42`). New test: a published `artifact_tour` newer than a
published `release_update` must not be returned by `getLatestPublishedCampaign("release_update")` while
`getEligibleCampaignForUser` still ignores it — this is T3, step T3.0, and it is the only edit this slice
makes outside its own new files.

This is not a workaround for the tour; it closes a hole Feature 1's campaigns already had (an
`artifact_tour` is the first third campaign type, so nothing could previously collide with the badge).

### The replay entry point, which is not a menu

There is **no version badge menu in any slice**, including this one: no slice defines one, and the panel's
version control today is a **chip strip**, rendered in two places — docked and expanded — at
`src/lib/components/document-workspace/DocumentWorkspace.svelte:960-988` (`document-version-control`) and
`:1210`+ (`document-version-badge`), and only when `familyDocuments.length > 1`. `VersionsSheet.svelte` is
Slice 1's (`slice-1.md §Task T6`). **Ruling 32 settles where the replay lives: in the panel — the artifact
list's menu and the type's empty state — so no slice rewrites the header for it and the sidebar badge stays
campaigns only.** Two hosts, both Slice 0's panel, and this slice adds no control of its own:

1. **The panel's artifact-list menu.** One `How this kind works` row in the list's per-item menu
   (`data-testid="artifact-panel-list"`), styled as the quiet row (tokens below): it opens the tour in replay
   mode and writes no state. If the list has no menu when this slice lands, say so in the report and ship the
   empty-state link alone rather than inventing a control.
2. **Always present — the panel's empty state.** The empty state renders the kind's summary line and, beneath
   it, a quiet `artifacts.tour.replay` link to the same replay. This host exists in every slice, so the
   replay entry point is reachable even before Slice 1 lands `VersionsSheet.svelte`.
3. **Never a second control.** If the menu row exists, do not add a badge, button, or chip beside it.

The version affordance is deliberately **not** a host: a chip on the version strip would make a tours slice
the owner of a control four other slices also touch, which is the serialisation problem `decisions.md`
ruling 10 was written to avoid — and ruling 32 chose the artifact list's menu instead for exactly that
reason.

### The empty state

The empty state's one-line text comes from the resolved tour's `summary`, with the type slice's i18n key as
the fallback:

```ts
// src/lib/components/artifacts/empty-state.ts
/** The kind's empty-state line: the tour's summary when it resolves, the i18n
 *  key when it does not. Both are shipped, and a test asserts they agree. */
export function emptyStateLine(tour: ResolvedArtifactTour | null, t: (key: string) => string, kind: ArtifactTourType): string;
```

Fallbacks and the shipped defaults that must match them. **The Canvas and Slides values below are copied
verbatim from the type slices and must not be re-typed** — `slice-3.md §i18n` has no comma in the Canvas line
and `slice-4.md §i18n` says `Add a slide to start`; an earlier draft of this file had a comma, which is exactly
the drift the test in T6 exists to catch:

| Kind | Fallback key | Default summary (EN) | Default summary (HU) |
|---|---|---|---|
| Document | `artifacts.document.emptyState` | `Empty document. Start writing, or ask Alfy to draft it.` | `Üres dokumentum. Kezdj el írni, vagy kérd meg Alfyt, hogy megírja.` |
| App | `artifacts.app.emptyState` | `Nothing here yet. Ask Alfy to build a small tool.` | `Itt még nincs semmi. Kérd meg Alfyt, hogy építsen egy kis eszközt.` |
| Canvas | `artifacts.canvas.emptyBoard` | `Empty board. Insert a block or draw on it.` | `Üres tábla. Szúrj be egy blokkot, vagy rajzolj rá.` |
| Slides | `artifacts.slides.emptyDeck` | `Empty deck. Add a slide to start.` | `Üres diasor. Adj hozzá egy diát a kezdéshez.` |

`artifacts.document.emptyState` and `artifacts.app.emptyState` are **new in this slice** — no slice defines
them (grep across `docs/plans/claude-at-home-2/` finds zero occurrences; slices 1 and 2 do not list an
empty-state key in their i18n tables). They are added to `src/lib/i18n/artifacts.ts` in T6, both locales, or
`t()` will fall through to echoing the key (`src/lib/i18n/index.ts:74-77` returns `lang[key] ?? en[key] ??
key`), and `I18nKey` is `keyof typeof dictionary.en` (`:71`), so a missing row is a type error at the call
site rather than a silent blank.

The Canvas and Slides keys are the ones slices 3 and 4 already ship. This slice makes the tour the source of
truth and those keys the fallback, and its test makes disagreement a failure rather than a copy-edit
accident. `emptyStateLine` never renders a bare key: when the tour does not resolve *and* the fallback key is
absent it returns the kind's `artifacts.type.*` name, which **Slice 0** ships (ruling 22) and every type has
(`slice-0.md §i18n`) — this is what the `artifacts.tour.emptyStateFallback` row in the old draft was
gesturing at, and it is deleted (see the i18n table).

### i18n (chrome only)

All keys are appended to `src/lib/i18n/artifacts.ts` (created by Slice 0, `slice-0.md §i18n`) and the
`artifacts.` prefix is already in `AUDITED_PREFIXES` (`src/lib/i18n.test-helpers.ts:16`) by then, so the
parity test picks these up with no registration work:

| Key | EN | HU |
|---|---|---|
| `artifacts.tour.region` | `How this kind works` | `Így működik ez a típus` |
| `artifacts.tour.stepOf` | `Step {n} of {m}` | `{n}. lépés, összesen {m}` |
| `artifacts.tour.dots` | `{count} step{count, plural, one {} other {s}}` | `{count} lépés` |
| `artifacts.tour.next` | `Next` | `Tovább` |
| `artifacts.tour.back` | `Back` | `Vissza` |
| `artifacts.tour.done` | `Got it` | `Értem` |
| `artifacts.tour.skip` | `Skip` | `Kihagyás` |
| `artifacts.tour.close` | `Close` | `Bezárás` |
| `artifacts.tour.replayHint` | `You'll see this once. You can replay it any time.` | `Egyszer látod. Bármikor újranézheted.` |
| `artifacts.tour.replay` | `Show it again` | `Újra megnézem` |
| `artifacts.tour.replayOpened` | `Replaying` | `Újranézés` |
| `artifacts.tour.illustrationAlt` | `An illustration of a {kind}` | `Egy {kind} illusztrációja` |
| `artifacts.tour.loadFailed` | `Could not load the introduction.` | `Nem sikerült betölteni a bemutatót.` |
| `artifacts.document.emptyState` | see the empty-state table above | `Üres dokumentum. Kezdj el írni, vagy kérd meg Alfyt, hogy megírja.` |
| `artifacts.app.emptyState` | see the empty-state table above | `Itt még nincs semmi. Kérd meg Alfyt, hogy építsen egy kis eszközt.` |

Three deliberate details:

- **`artifacts.tour.dots` uses the house plural suffix form**, `{count} step{count, plural, one {} other {s}}`,
  copied from `src/lib/i18n/chat.ts:931` — not `{count, plural, one {1 step} other {{count} steps}}`, which
  the `t()` helper's regex cannot parse because its branch bodies may not contain braces
  (`src/lib/i18n/index.ts:75-87`). The Hungarian line takes no suffix at all because Hungarian does not
  pluralise after a numeral; `{count} lépés` is correct for 1 and for 3.
- **`artifacts.tour.replay` is `Újra megnézem`**, not `Újra megmutatja` — as a link the subject is the reader
  ("I'll watch it again"), and the old value was a bare third-person verb phrase that reads as a machine
  translation.
- **`artifacts.tour.replayHint` names no host.** The mockup's own string is `You'll see this once. Replay it
  any time from the version badge.` (`claude-at-home-2-artifact-surfaces-mockups.html:310`) — and the shipped
  hint deliberately drops the last clause, because the replay entry point lives on the version affordance
  *or* the empty state (see above) and no slice defines a version badge *menu* for it to promise. If the
  header ever gains a version menu of its own (ruling 32 chose the artifact list's menu instead, so it does
  not), restoring the mockup's wording is a one-string change.
- **The old `artifacts.tour.emptyStateFallback` row is deleted**, not implemented: it was never defined and
  its job is done by the `artifacts.type.*` name fallback described under the empty state.

`{kind}` resolves through the existing `artifacts.type.*` rows (**Slice 0** owns them, ruling 22;
`slice-0.md §i18n`: `Canvas` / `Tábla`, `Document` / `Dokumentum`, `App` / `Alkalmazás`, `Slides` / `Diasor`),
so the alt text cannot drift from the type name.

The **admin** keys the seed menu and the `summary` layout need go in the **settings** dictionary instead —
`src/lib/i18n/settings.ts` is a two-locale object literal (`en` `:20-1927`, `hu` `:1928-3897`) whose
`admin.campaigns.*` rows are **alphabetically sorted** (EN `:43`–`:1085`, HU `:1967`–`:3032`), so they are
inserted in sorted position, not appended. Four new rows, each in both locales, using the existing groups the
names mirror:

| Key | EN | HU | Sorted position |
|---|---|---|---|
| `admin.campaigns.slideKind.summary` | `Summary` | `Összegzés` | after `slideKind.standard` (EN `:121`, HU `:2046`) |
| `admin.campaigns.addSummarySlide` | `Add summary slide` | `Összegző dia hozzáadása` | after `addStandardSlide` (EN `:47`, HU `:1971`), before `altEn` |
| `admin.campaigns.seedArtifactTours` | `Seed artifact tours` | `Bemutatók létrehozása` | after `saveDraft`, before `seedFirstRun` |
| `admin.campaigns.messages.artifactToursSeeded` | `Seeded {created} tour drafts, {skipped} already existed.` | `{created} bemutató piszkozat létrejött, {skipped} már létezett.` | first in the `messages.*` group, before `messages.archived` (EN `:88`, HU `:2013`) |

The layout label belongs to `slideKind.*` because that is the group `SlideOptionsDialog.svelte` already reads
(`:89-91`: `admin.campaigns.slideKind.setup` / `.standard`), and the seed message belongs to `messages.*`
because `seedFirstRun`'s handler shows `messages.seeded` / `messages.seedExists`
(`SettingsAdminCampaignsPane.svelte:552-558`). Sorting is enforced by eye only (no dictionary-order test), so
**the reviewer checks placement**, and these keys are not `artifacts.*` — they must not go in the artifacts
dictionary.

**Two existing keys enumerate the legal values in prose and become wrong the moment the unions widen.** They
are edited in place (same keys, both locales, new text) in T5, and a reviewer who finds either still naming
two values has found a shipped contradiction between the picker and its own error message:

| Existing key | Now | Becomes |
|---|---|---|
| `admin.campaigns.validation.typeInvalid` (EN `:170-171`, HU `:2094-2095`) | `Campaign type must be first-run onboarding or release update.` / `A kampány típusa csak első indítási vagy kiadási kampány lehet.` | EN: `Campaign type must be first-run onboarding, release update or artifact tour.` HU: `A kampány típusa első indítási, kiadási vagy bemutató kampány lehet.` |
| `admin.campaigns.validation.slideLayoutInvalid` (EN `:164-165`, HU `:2089-2090`) | `Slide layout must be setup or standard.` / `A dia elrendezése csak beállítás vagy általános lehet.` | EN: `Slide layout must be setup, standard or summary.` HU: `A dia elrendezése beállítás, általános vagy összegzés lehet.` |

The server mirrors both messages in its own thrown prose — `assertType`'s field error
(`announcement-campaigns.ts:195-197`) and the layout error at `:734` — so those two strings change in the same
commit, and the service test asserts the new wording rather than a substring.

### The illustrations

`src/lib/components/artifacts/tour/illustrations/` — one component per kind, `TourArtDocument.svelte`,
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

`shared` means another slice also edits the file; the order column says who lands first. Everything not
marked shared is this slice's alone.

| File | Change | Shared with | Order |
|---|---|---|---|
| `src/lib/server/db/schema.ts` | extend — `artifactTourStates` | 0 (every table) | 0 first |
| `drizzle/<next-free-when>_artifact_tour_states.sql` + `drizzle/meta/_journal.json` | create — the table and its two indexes | 0 (takes `idx 124`) | 0 first |
| `scripts/prepare-db.ts` | extend — `requiredExistingTables` | 0 | 0 first |
| `src/lib/shared/artifacts/tours.ts` | create — `ArtifactTourType = Exclude<ArtifactKind, "file">`, `LocalizedText`, `ResolvedArtifactTour`, `ArtifactTourState`; type-only, no runtime imports | 0 creates `kinds.ts` in the same directory | 0 first |
| `src/lib/server/services/artifact-tours.ts` + `artifact-tours.test.ts` | create — resolve (default vs published campaign), mark seen, seed | — | — |
| `src/lib/server/artifact-tour-defaults.ts` + `artifact-tour-defaults.test.ts` | create — the code-owned copy, its `version`, the four default summaries. Sits beside `env.ts`/`prompts.ts` as a leaf data module, **not** under `services/`: AGENTS.md forbids a new top-level service boundary for what is one file of content | — | — |
| `src/lib/server/services/announcement-campaigns.ts` + `.test.ts` | extend — the `artifact_tour` type, the `summary` layout, the ordered-slides publish rule, and the `getLatestPublishedCampaign(campaignType, options)` narrowing | — | — |
| `src/routes/api/campaigns/latest/+server.ts` | extend — pass `"release_update"` (the badge must never resolve a tour) | — | — |
| `src/routes/api/campaigns/campaigns.test.ts` | extend — the new argument in the existing mock | — | — |
| `src/lib/client/api/campaigns.ts` + `.test.ts` | extend — the two open unions (types at `:6-10`, layouts nearby); `seedFirstRunCampaign` gains a sibling | — | — |
| `src/lib/client/api/artifact-tours.ts` + test | create — the browser calls (`getArtifactTour`, `markArtifactTourSeen`, `seedArtifactTours`) | — | — |
| `src/routes/api/artifact-tours/[type]/+server.ts` + test | create — GET the resolved tour + seen state | — | — |
| `src/routes/api/artifact-tours/[type]/seen/+server.ts` + test | create — POST the state | — | — |
| `src/routes/api/admin/campaigns/seed-artifact-tours/+server.ts` + test | create — seed the four drafts, sibling of `seed-first-run/+server.ts` | — | — |
| `src/lib/components/artifacts/tour/ArtifactTour.svelte` + test | create — the panel card | — | — |
| `src/lib/components/artifacts/tour/illustrations/TourArt{Document,App,Canvas,Slides}.svelte` | create — four illustrations | — | — |
| `src/lib/components/artifacts/empty-state.ts` + test | create — `emptyStateLine` | — | — |
| `src/lib/components/document-workspace/DocumentWorkspace.svelte` | extend — the first-open trigger, the replay row in the panel's artifact list, the empty-state line | 0, 1, 3, 4 (all render the panel) | **after all four** |
| `src/routes/(app)/settings/_components/SettingsAdminCampaignsPane.svelte` | extend — the `Seed artifact tours` item in **both** seed affordances (`:792-795` and `:1131-1139`) with its handler modelled on `:549-563` | — | — |
| `src/routes/(app)/settings/_components/campaigns/SlideOptionsDialog.svelte` | extend — the layout picker offers `Summary` (the prop type at `:33` and the array at `:81`) | — | — |
| `src/routes/(app)/settings/_components/campaigns/SlideEditor.svelte` | likely **no change** — it already edits title/body per locale from `EditorSlide` (`:2-17`) and has no layout branch. Only touch it for an optional hint; never for a per-layout special case | — | — |
| `src/routes/(app)/settings/_components/campaigns/campaign-checklist.ts` + `.test.ts` | extend — the type gate (`:175-186`) accepts `artifact_tour`, the layout gate (`:225-234`) accepts `summary`, and the new per-type slide rules | — | — |
| `src/lib/i18n/artifacts.ts` + `artifacts.test.ts` | extend — `artifacts.tour.*`, `artifacts.{document,app}.emptyState` | 0 (creates it) | 0 first |
| `src/lib/i18n/settings.ts` | extend — the four `admin.campaigns.*` rows | — | — |
| `src/lib/server/services/account-lifecycle/user-scoped-tables.ts` | extend — `artifact_tour_states` as `cascade`, `resets: []` | — | — |
| `src/lib/server/services/account-data-archive/` (+ its test) | extend — the states in the archive and in erasure | — | — |
| `tests/e2e/artifact-tours.spec.ts` | create | — | — |
| `tests/cross-cutting/incognito-artifact-containment.test.ts` | extend — **only if** the tour path touches an artifact table; the guard fires on four tables (`:561-568`) and `artifact_tour_states` is not one, so the expected answer is *no edit* (see Risks) | 0 creates it, later slices append (ruling 31) | coordinate |
| `src/lib/components/artifacts/{document,app,canvas,slides}/…` | extend — the type editors render their empty state through `emptyStateLine` | 1, 2, 3, 4 | after those |

**Serialisation.** `document-workspace/DocumentWorkspace.svelte`, `src/lib/i18n/artifacts.ts`, `schema.ts` and
`drizzle/` are hot files for every slice in the feature; this slice lands **after** slices 0–5 (the tree is
built last for this reason) and appends rather than restructures. Inside this slice the order is
T1 → T2 → T3 → T4 → T5 → T6 → T7, and the only cross-slice ordering constraint beyond "after 0–5" is that
T1's migration takes the next free journal `idx` **at branch time**, not the number written here.
`announcement-campaigns.ts`, the campaign admin pane and the client API are touched by this slice only.

---

## UI states

The tour is one component in one host, so the states are few. Measured at **1440 px** and **390 px** with the
panel open; the panel itself is the host and is not restyled here.

| State | At 1440 px | At 390 px | Tokens |
|---|---|---|---|
| **Loading** | Nothing. The tour is not a skeleton: the panel renders the artifact normally and the card appears when the GET resolves. A spinner over the artifact for a request that usually loses the race to the artifact's own load is worse than a late card | same | — |
| **Empty (tour has no slides)** | Cannot happen for the shipped four (the test in T2 fails first), but if a published snapshot somehow resolved with zero slides the card is not rendered at all and `seen` is not written; the type's empty state shows its fallback line | same | `--text-secondary` |
| **Default (three slides)** | Card sits in the panel's content area **above** the artifact, full content width, illustration on the left at 96 px, text column to its right; `Next` / `Skip` in a footer row right-aligned; `Step 1 of 3` above the title | Illustration moves **above** the text at 64 px and the text wraps under it; footer buttons become full-width side by side (`Back` hidden on slide 1, so `Next` alone spans the row); the card never exceeds the panel's own scroll area and is not fixed or sticky | `--surface-raised`, `--border-subtle`, `--radius-lg`, `--shadow-sm`, `--text-primary`/`--text-secondary` |
| **Long content** | Slide bodies are 1–2 sentences by design; a published slide with a 400-character body wraps and the card scrolls internally (`max-height: 40vh; overflow-y: auto`) rather than pushing the artifact off screen | same, `max-height: 30vh` | as above |
| **Error (GET failed, including a 409-on-write)** | No card, no error toast: the tour is decoration and its absence must not read as breakage. One `console.warn` with the status; the panel is untouched | same | — |
| **Replay (from the panel's replay entry)** | Identical card, plus a quiet `Replaying` label in the header and **no** footer write path: `Got it` and `Skip` both just close | same | `--text-tertiary` for the label |

**Focus and keyboard order.** The card is a `<section aria-label={t("artifacts.tour.region")}>` placed **after**
the artifact's own content in DOM order only if the panel scrolls the artifact to it; otherwise the card is
first in the content area and receives focus on show. Inside it, one tab stop per control, in visual order:
`Skip` (left in RTL-agnostic layout: it is the *first* focusable so a keyboard user can leave immediately),
then the illustration (not focusable), then `Next`/`Back`. Arrow keys are **not** bound — the mockup's dots are
decoration, and binding arrows would fight a panel that already owns arrow keys for other things. `Escape`
closes (same as `Skip`). The card does not trap focus and does not use `inert` on the artifact: a user may keep
working beside it. Focus returns to the panel's previously focused element on close, and the card is a single
`role="region"` so a screen reader announces "How this kind works, region, Step 2 of 3".

**Reduced motion.** If `prefers-reduced-motion: reduce`, slide changes are instant (`--duration-0`) — the
motion is a slide transition and nothing else.

## Failure modes

Every message here is EN + HU and every one is read through `t()` — the tour's *content* is campaign data, but
its *failures* are chrome, so they live in `src/lib/i18n/artifacts.ts` with the keys above.

| Failure | Server | User sees (EN) | User sees (HU) | Where it is handled |
|---|---|---|---|---|
| Session expired while the panel is open | `401 {"message":"Unauthorized"}` | nothing — the panel's existing session-expiry handling takes over and the tour card is not rendered | ugyanaz | `src/lib/client/api/http.ts` (`isSessionExpiredResponse`) — the tour adds no new path |
| The tour GET fails (500, offline, aborted) | any non-2xx | nothing; no card. One `console.warn` | ugyanaz | panel catch; the artifact still renders |
| The GET returns `tour: null` | 200 | the kind's empty-state fallback line, no card | ugyanaz | `emptyStateLine` |
| The seen POST fails after the user finished | 500/offline | the card closes anyway; the tour shows again next open. **Never** a blocking error dialog | ugyanaz | panel catch; the write is fire-and-forget by design |
| The seen POST races a publish | `409` | the panel re-fetches and shows the new copy from slide 1 | ugyanaz | client reads `ApiError.status === 409`, re-runs the GET |
| An unknown `[type]` is requested | `404 {"ok":false,"reason":"unknown_type"}` | nothing (only reachable from a hand-typed URL) | ugyanaz | route; there is no UI that can produce it |
| The seed finds all four drafts present | `200 {created: 0, existing: 4}` | the admin pane says `Seeded 0 tour drafts, 4 already existed.` | `0 bemutató piszkozat létrejött, 4 már létezett.` | `admin.campaigns.messages.artifactToursSeeded` |
| A published tour is archived mid-session | next GET returns the default tour | the tour the user was reading is replaced by the default on their next open. No message: an archive is an admin action, not an error | ugyanaz | resolver rule in T2 |
| `ARTIFACT_TOUR_DEFAULTS` is missing a kind | build error | n/a | n/a | the exhaustive `Record<ArtifactTourType, …>` |

## Limits and configuration

| Value | Where | Default | Why |
|---|---|---|---|
| Slides per tour | **code**, `validatePublishInput` | exactly 3 `standard` + 1 `summary` | §6 / this slice; a tour is three questions |
| Summary slide's `sortOrder` | **code** | `1`, then `2, 3, 4` | the unique `(campaign_id, sort_order)` index |
| Slide body length | **not enforced** | — | the campaign editor has no length cap today; adding one is out of scope and the UI caps it visually (see long content) |
| `ARTIFACT_TOUR_CONTENT_VERSION` | **code** | `1` | bumping it re-shows every default tour once; it is the one deliberate re-show switch |
| Resumption | **code** | `lastSlide` is stored, and a `dismissed` row never auto-shows again | the user asked not to see it |
| Tour fetch timeout | **none added** | the browser's own | the request is small and same-origin; a timeout here would need a config knob nobody asked for |
| Retention | **the account lifecycle** | erased with the user (`cascade`), archived with the account export | ADR-0029–0032 |
| Telemetry | **none new** | — | the slice records no analytics of its own; `replay_opened`/`auto_shown` stay the campaign events, and a tour never emits them (that is the point of T3.0) |

**No new environment variable and no new `config-store.ts` entry.** There is nothing an admin should tune at
runtime: the copy is the campaign, the structure is code, and the seen state is per user. A slice that adds a
`TOUR_ENABLED` flag would be adding a switch with no consumer.

## Prototype pointers

**There is no prototype for the tour, and this is the slice where that matters least.** Stated plainly so
nobody goes looking:

- `claude-at-home-2-prototype-findings.md` contains **no** tour, no first-open card and no seen-state
  mechanism (grep: zero hits for "tour"). The three throwaway branches (`proto/artifact-apps-quality`,
  `proto/artifact-document-editor-r2`, `proto/artifact-canvas-agent`) are about the artifact types.
- The design reference is **section 7 of `docs/plans/claude-at-home-2-artifact-surfaces-mockups.html`**
  (`<!-- 7 -->` at `:296`, caption at `:298`), not section 6 — the assignment's "section 6" is the App/File
  section; the tour mockup is the `.tour` block with `.dots`, `.tourart`, `.tourfoot`, the `A board for
  anything` heading, `.bs` = Skip and `.bp` = Next. Read that markup for the proportions and the dot count.
- The **working reference for the machinery** is the shipped campaign stack, not a prototype: read
  `src/routes/(app)/settings/_components/campaigns/campaign-checklist.ts` for what a publish gate looks like,
  `announcement-campaigns.ts:819-936` for the immutable publish and `:1159-1232` for insert-if-absent
  completion, and `src/routes/(app)/+layout.svelte:481-535` for how a campaign is opened and how
  `auto`/`replay` differ. Those four readings are the whole implementation vocabulary of this slice.

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

The row has no conversation id and no artifact id on purpose: it says what was
taught, never where. An incognito chat shows no tour at all (ruling 33), so the
row cannot even come into existence as a trace of one."
```

### Task T2: The shared types, the code-owned defaults, and the resolver

**Files:** `src/lib/shared/artifacts/tours.ts` (**shared**: Slice 0 creates `kinds.ts` in this directory first
— this file is additive and imports `ArtifactKind` from it), `src/lib/server/artifact-tour-defaults.ts` +
`artifact-tour-defaults.test.ts`, `src/lib/server/services/artifact-tours.ts` + `artifact-tours.test.ts`
**Test:** unit

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/server/artifact-tour-defaults.test.ts
it("has a default for every tour type, and file is not one of them", ...);
it("keeps the derived union honest: ArtifactTourType has exactly four members", ...);
it("gives every default exactly three slides", ...);
it("gives every default both en and hu for every title, body and summary", ...);
it("keeps en and hu at paragraph parity for every slide", ...);
it("never says the word artifact in any default string", ...);
it("uses the shipped copy verbatim, per kind and language", ...);   // the Contracts table, asserted
it("names the type the way the UI does, per language", ...);        // artifacts.type.* parity
it("narrows only the four kinds at runtime", ...);                  // isArtifactTourType

// src/lib/server/services/artifact-tours.test.ts
it("prefers a published campaign snapshot over the default", ...);
it("ignores a draft campaign", ...);
it("ignores an archived campaign and does not fall back to the default", ...);
it("keys a published tour as snapshot:<id> and a default as default:<version>", ...);
it("returns null for a kind with neither, without throwing", ...);
it("returns the default when the campaign read throws", ...);
it("reports the seen state and the last slide for this user", ...);
it("reports seen: false for a different user", ...);
it("is unaffected by another kind's seen state", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

Write the four defaults' copy **from the Contracts table verbatim** — every string is specified there, so
this task is transcription plus the resolver. Then the resolver, with the archived-is-a-retirement rule
commented, and `isArtifactTourType` as the single runtime enumeration of the four values.

- [ ] **Step 4: Run them to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/server/artifact-tour-defaults.ts src/lib/server/services/artifact-tours.ts
git commit -m "Ship the tours in code, so the feature works before anyone publishes a campaign

A seeded campaign is a draft by ADR-0012, and a tour nobody has published yet is
not a tour. The code copy is the shipped default and a published campaign is the
override, which is the same shape the admin system prompts already use."
```

### Task T3: The panel card, its trigger, and the replay affordance

**Files:** `src/lib/components/artifacts/tour/ArtifactTour.svelte` +
`src/lib/components/artifacts/tour/ArtifactTour.test.ts`, `illustrations/*.svelte`,
`src/lib/components/document-workspace/DocumentWorkspace.svelte`,
`src/lib/client/api/artifact-tours.ts` + `.test.ts`, and — step T3.0 only —
`src/lib/server/services/announcement-campaigns.ts` + `.test.ts`,
`src/routes/api/campaigns/latest/+server.ts`, `src/routes/api/campaigns/campaigns.test.ts`
**Test:** component + e2e

- [ ] **Step 0 (T3.0): Close the sidebar badge first, on its own commit**

```ts
// src/lib/server/services/announcement-campaigns.test.ts
it("never returns an artifact_tour as the latest published campaign", ...);
it("still returns the newest published release_update", ...);
it("keeps returning first_run_onboarding for the eligible path", ...);  // unchanged behaviour, pinned
```

Implement the narrow signature from the contracts, pass `"release_update"` in the route, fix the three test
call sites, then commit **before** any tour file exists:

```
git add src/lib/server/services/announcement-campaigns.ts src/lib/server/services/announcement-campaigns.test.ts \
  src/routes/api/campaigns/latest/+server.ts src/routes/api/campaigns/campaigns.test.ts
git commit -m "A version badge has one job, and a kind tour is not it

The badge asks for the newest published campaign with no type predicate, so the
first published tour would replace the release note behind it — and the tour
would be counted as a replay that a user opened. The filter already existed as
latestPublishedByType; the exported function just did not use it. The parameter
is required so the next caller cannot drop it again."
```

- [ ] **Step 1: Write the failing tests**

```ts
// ArtifactTour.test.ts
it("renders the first of three slides with its dots, and advances on Next", ...);
it("goes back, and never past the first or last slide", ...);
it("calls onSeen once, with the last slide index, when the user finishes", ...);
it("calls onDismiss with the current index when the user skips", ...);
it("shows the replay hint on the last slide", ...);
it("announces the step to assistive tech", ...);
it("is one region, traps no focus, and puts Skip first in tab order", ...);
it("closes on Escape, as Skip does", ...);
it("calls neither callback when replaying", ...);
it("renders the current language's copy and switches languages live", ...);
it("survives a tour whose copy is missing a language by falling back to en", ...);
it("stays instant under prefers-reduced-motion", ...);

// src/lib/client/api/artifact-tours.test.ts — URL and error mapping, following campaigns.test.ts:249
it("requests /api/artifact-tours/:type", ...);
it("posts the state to /api/artifact-tours/:type/seen and surfaces a 409 as ApiError.status", ...);
it("posts to /api/admin/campaigns/seed-artifact-tours", ...);

// e2e (tests/e2e/artifact-tours.spec.ts)
it("shows the tour on the first open of a kind", ...);
it("does not show it on the second open", ...);
it("shows it again for a different kind", ...);
it("does not show for the file kind", ...);
it("is never opened by the sidebar version badge, even with a published tour", ...);
it("replays from the panel's artifact-list menu and writes no new state", ...);
it("replays from the empty state", ...);
it("does not show it when the tour request fails, and does not break the panel", ...);
it("shows the same tour to a second user", ...);
it("renders at 390 px without overflowing the panel", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

Write the illustrations, then the card, then the trigger in `document-workspace/DocumentWorkspace.svelte`: on
open, one request for the kind; if it resolves and is unseen, render the card **in the panel's content area**
above the artifact. Fire the seen write on finish or skip, not on render — a user who closes the panel
mid-tour has not seen it and should meet it again next time (`lastSlide` is what makes that resumption sane).
Add the replay entry point per ruling 32: one `How this kind works` row in the panel's artifact-list menu,
plus the empty-state link, which is the host this slice guarantees. Append to the panel's existing render
paths; do not restructure them and do not add a second control. `VersionsSheet.svelte` and the version chip
strip are **not** hosts.

- [ ] **Step 4: Run them to verify they pass**

```bash
npx vitest run src/lib/components/artifacts src/lib/client/api/artifact-tours.test.ts
npx playwright test tests/e2e/artifact-tours.spec.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/components/artifacts src/lib/client/api/artifact-tours.ts src/lib/client/api/artifact-tours.test.ts \
  src/lib/components/document-workspace/DocumentWorkspace.svelte
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
it("shows no tour inside an incognito chat, and writes no state row for it", ...);
it("erases the user's states on erasure, so a recreated user sees the tours again", ...);
it("does not carry the seen state into telemetry with any content", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

The route validates the type against the tour union, compares `contentKey` against the currently resolved
tour (409 on a mismatch), then insert-if-absent.

**On the containment suite: the expected edit is none, and adding an exemption would be a bug.** The suite's
PART B reads only the tables in `readsGuardedTables` (`tests/cross-cutting/incognito-artifact-containment.test.ts:561-568`),
four artifact tables; `artifact_tour_states` is not one and never will be — it has no `conversation_id` and no
`artifact_id` to guard. The suite also fails an `ALLOWED_WITHOUT_SCOPE` entry that the guard can never consult
(`:529-546`, checked by `keeps the allow-list honest` at `:621-668`), so an exemption added "to be safe" turns
the suite red and teaches the next reader that the guard is decorative. The cross-cutting coverage this slice
wants is a **new,
separate case in the existing suite file** (or a small sibling test) that asserts the invariant directly: an
incognito chat shows no tour and writes no row, while the row an ordinary chat writes has columns that are
only `(user_id, artifact_type, content_key, status, slide_count, last_slide, timestamps)` — and no tour code
path reads an artifact row. Slice 0 creates the suite file and later slices append (ruling 31), so append
after slice 0 and keep the diff to one new `describe`.

- [ ] **Step 4: Run them to verify they pass**

```bash
npx vitest run tests/cross-cutting src/lib/server/services/artifact-tours.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/routes/api/artifact-tours src/lib/server/services/artifact-tours.ts tests/cross-cutting
git commit -m "Record what was taught, not where it was taught

The state a finished tour writes names the kind and nothing else, so the row
cannot become a trace of a chat. An incognito chat shows no tour at all
(ruling 33), and the containment suite says both out loud instead of leaving the
next reader to guess whether it was an oversight."
```

### Task T5: The admin side — seeding, editing, publishing

**Files:** `announcement-campaigns.ts` + `announcement-campaigns.test.ts`, `src/lib/client/api/campaigns.ts` +
`campaigns.test.ts`, `src/routes/api/admin/campaigns/seed-artifact-tours/+server.ts` + test,
`SettingsAdminCampaignsPane.svelte`, `campaigns/campaign-checklist.ts`, `campaigns/SlideEditor.svelte`,
`campaigns/SlideOptionsDialog.svelte`, `src/lib/i18n/settings.ts`
**Test:** unit + integration + e2e

- [ ] **Step 1: Write the failing tests**

```ts
// announcement-campaigns.test.ts
it("accepts artifact_tour as a campaign type and refuses an unknown one", ...);
it("publishes a tour with exactly one summary and three standard slides", ...);
it("refuses a tour with two summary slides", ...);
it("refuses a tour with two standard slides", ...);
it("refuses a tour whose first slide is not the summary", ...);        // ordered, not just counted
it("requires en and hu title and body on every slide", ...);
it("does not require a crop or alt text", ...);
it("accepts a crop on a tour slide and then requires its alt text", ...);
it("keeps a published tour immutable when the draft is edited", ...);
it("seeds four drafts, one per kind, and seeds nothing on a second call", ...);
it("gives each seeded draft a distinct identity key", ...);            // artifact_tour:<kind>:r1
it("leaves a seeded draft unpublished", ...);
it("records the tour's events in the campaign event ledger", ...);
it("still refuses a summary slide on a first_run_onboarding campaign", ...);  // the rule is per type
it("names all three types in the thrown type error", ...);                    // announcement-campaigns.ts:195-197
it("names all three layouts in the thrown layout error", ...);                // :730-737
it("keeps both validation messages in step with the unions, both locales", ...); // settings.ts:170,164,2094,2089

// campaigns/campaign-checklist.test.ts (the admin pane's own gate — :175-186, :225-234)
it("lets the client check a tour with one summary and three standard slides", ...);
it("blocks publishing a tour whose summary slide is missing", ...);
it("offers Summary in the slide layout picker", ...);                   // SlideOptionsDialog.svelte:33,81

// SettingsAdminCampaignsPane / seed route
it("seeds the four tour drafts and reports the counts", ...);
it("is a no-op with 200 on a second run", ...);

// e2e (tests/e2e/settings-admin.spec.ts)
it("seeds the four tour drafts from the Campaigns pane and shows them in the rail", ...);
it("edits the summary slide's text and publishes, and the panel shows the new copy", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

Extend the type set and the layout set in `announcement-campaigns.ts`, add the two publish rules (the counts
and the order), write `seedArtifactTourDrafts` with the per-kind `releaseVersion` identity rule from the
contracts, and register the route as a sibling of `seed-first-run/+server.ts`.

In the admin UI the layout picker, not the field editor, is where the work is: `SlideOptionsDialog.svelte`
hard-codes the two layouts twice — the prop type at `:33` (`onChangeKind: (kind: "setup" | "standard") => void`)
and the rendered array at `:81` (`{#each ['standard', 'setup'] as const as option}`) — so both are widened to
include `"summary"` and the new label key renders there. `SlideEditor.svelte` already renders a title and a
body per locale from `EditorSlide` (`:2-17`) and has **no layout-specific branch**, so it needs no change
beyond an optional hint line under the body on a summary slide; do not add one if it makes the editor's
layout conditional, because that is how a slide editor grows a per-kind special case nobody maintains.

The seed affordance appears twice in the pane — the overflow menu item at
`SettingsAdminCampaignsPane.svelte:792-795` and the note-plus-button pair at `:1131-1139` — and the handler
to model is `seedFirstRun` at `:549-563` (records success through `admin.campaigns.messages.*`, then reloads
the rail). Add the new item to both affordances or neither; a seed reachable from one of the two is a bug the
e2e will not see.

The publish gate in the pane (`SettingsAdminCampaignsPane.svelte:183-206`) reads `clientValidationErrors`
from the checklist, so a tour that fails the new rules must not reach `publish`.

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
npx vitest run src/lib/components/artifacts
npx playwright test tests/e2e/artifact-tours.spec.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/components/artifacts src/lib/i18n
git commit -m "Say the same sentence when the thing is empty and when it is explained

Two copies of one line is how a product starts describing itself two ways. The
tour's summary is the source and the i18n string is the fallback, and a test
fails when they disagree, so the next copy edit has one place to go."
```

### Task T7: i18n, lanes and the archive

**Files:** `src/lib/i18n/artifacts.ts` + `src/lib/i18n/artifacts.test.ts`, `src/lib/i18n/settings.ts`,
`src/lib/server/services/account-data-archive/` + its test
**Test:** unit + cross-cutting

- [ ] **Step 1: Write the failing tests**

```ts
it("has both en and hu for every artifacts.tour key", ...);
it("has artifacts.document.emptyState and artifacts.app.emptyState in both locales", ...);
it("never shows the word artifact in either locale, in chrome or in default content", ...);
it("uses the ratified Hungarian type names in every default string that names a kind", ...);
it("keeps the illustration alt text built from artifacts.type.* in both languages", ...);
it("keeps the admin.campaigns.* additions sorted into their groups", ...);
it("includes the tour states in the account archive", ...);
it("erases the tour states on account deletion", ...);
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

Fill both dictionaries (the two new empty-state keys, the thirteen `artifacts.tour.*` rows, the four
`admin.campaigns.*` rows, and the two reworded validation messages) and finish the archive and erasure
coverage T1 opened. The i18n parity helper already covers anything prefixed `artifacts.`
(`src/lib/i18n.test-helpers.ts:16` `AUDITED_PREFIXES`), so the artifacts half is automatic once the module
is registered by Slice 0; the settings half is checked by the test above.

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
- **No change to `getEligibleCampaignForUser`'s behaviour, and no change to the sidebar App Version Badge's
  UI.** The one service change this slice makes is narrowing `getLatestPublishedCampaign` to an explicit
  campaign type (T3.0) so the badge keeps showing a release note instead of a kind tour; the badge's markup,
  position, and click behaviour are untouched. (An earlier draft of this file listed that function as
  untouchable, which would have shipped the bug.)
- **No "don't show tours again" master switch.** A user who wants no more tours has already seen the four.
  (If a setting is wanted later, it is one preference row and this slice does not invent it.)
- **No admin view of who has seen a tour** beyond the campaign analytics that already exist.
- **No tour for an artifact type added later by anything other than this list** — a fifth kind gets its tour
  and its empty state in the slice that adds the kind.
- **No telemetry carrying tour text.** Event types and the kind are fine; the copy is not.

## Risks

| Risk | Why it bites | Mitigation |
|---|---|---|
| The tour joins the auto-show campaign queue | It fights the first-run onboarding and the release announcements for the one app-level modal | `getEligibleCampaignForUser` cannot return one (type-filtered at `announcement-campaigns.ts:1115-1135`); the **badge** path can, so T3.0 narrows `getLatestPublishedCampaign`, with a service test and an e2e asserting the badge never opens a tour |
| Nothing shows until an admin publishes | The feature looks broken out of the box | Code-owned defaults with a published campaign as the override |
| Archiving a tour resurrects the default | An admin's deliberate retirement is silently undone | The resolver does not fall back when an archived campaign exists for the kind; a test names that rule |
| The seen row becomes a trace of an incognito chat | The containment promise is broken by a row nobody thought of as content | An incognito chat shows no tour and writes no row (ruling 33); on the ordinary path the row has no conversation id and no artifact id, and a new case inside the containment suite asserts its columns. **No** exemption is added to a guard that cannot reach this table |
| A new snapshot re-shows every tour | Users who already know the type see it again | That is ADR-0012's intended behaviour for a genuinely new revision; the copy is edited deliberately and `ARTIFACT_TOUR_CONTENT_VERSION` exists for the code path, with a comment saying raising it is a product decision |
| The empty state and the tour disagree | The product describes one thing two ways | One source with a fallback and a drift test |
| The tour's copy is fetched on every panel open | A request per open for something shown once | The seen state is read in the same request; the client caches the kind's result for the session and the panel does not re-request on an artifact switch within the same kind |
| The illustration collides with the Lucide-only icon rule | A reviewer reads a bespoke SVG as a violation | Declared as an illustration, one per kind, with the AGENTS.md exception named in a comment; no control ever uses a bespoke SVG |
| A `summary` slide reaches the editor and renders blank | The client layout gate and the picker are two more places the new value must be known, not just the DB's text column | `campaign-checklist.ts:225-234` and `SlideOptionsDialog.svelte:33,81` are widened in T5 with their own tests; the server publish rule refuses a tour without exactly one summary, so the editor can never *save* one it does not understand |
| The migration number collides with a slice that lands first | Two `_journal.json` entries with one `idx` fails every later `db:prepare` | T1 takes the next free number at branch time and `npm run check:migrations` (whose warning-only output must be read, not just its exit code) is part of the gate |

## Verification checklist

Reviewer's gate list, in order. Every command runs with `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`,
from the slice's worktree.

- [ ] **1. Tests were seen failing first.** Per task: `npx vitest run <the task's files>` red before the
  implementation, green after. Spot-check the two traps by name — a `default:<version>` key vs a
  `snapshot:<id>` key, and the second `markArtifactTourSeen` returning `alreadyRecorded: true`.
- [ ] **2. `npm run check:migrations`** — exits 0 **with no warning line**, and the new table name appears in
  both `drizzle/<when>_artifact_tour_states.sql` and `_journal.json`. The warning is the only thing that
  catches a missing `prepare-db` entry, so an exit-status-only pass is not a pass.
- [ ] **3. `npm run check`** — **0 errors, 0 warnings**. A new `svelte-check` diagnostic is a regression in
  this patch, not a follow-up.
- [ ] **4. `npx biome check src scripts tests`** — clean. (`npm run lint` is broken by nested worktree roots;
  do not "fix" it in this slice.)
- [ ] **5. `npm test`** — green. Specifically green: the i18n key parity test, the new
  `artifacts.tour.*` / `artifacts.{document,app}.emptyState` rows, the summary-vs-fallback drift test, the
  four-tour default-record test, the campaign service tests including `getLatestPublishedCampaign`, and the
  containment suite with its new incognito-tour case.
- [ ] **6. `npm run build`** — **0 warnings** from Vite, Svelte, TypeScript or any plugin. Watch for a
  `state_referenced_locally` warning in the tour card (the counter example: a prop read inside `$state()`
  needs `untrack`).
- [ ] **7. `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json`** — no
  new findings and **no new ignores**. The four `TourArt*.svelte` files are exported components (public
  boundary), so an "unused export" finding on them is a false positive to explain in the report, not to
  suppress.
- [ ] **8. Lazy chunks.** `scripts/check-artifact-chunks.mjs` does **not exist yet** — Slice 3 creates it,
  parameterised for reuse (`slice-3.md §File ownership`). Run it if Slice 3 has landed and quote the numbers;
  if it has not, say so in the report rather than skipping in silence. Either way, the rule this slice must
  not break: the tour card is rendered by `DocumentWorkspace.svelte`, which is itself behind the panel's lazy
  import, so nothing here may pull the tour, its illustrations, or the campaign client into the idle chat
  shell. `TourArt*.svelte` are imported only by `ArtifactTour.svelte`, and the client API only by the panel.
- [ ] **9. `npx playwright test tests/e2e/artifact-tours.spec.ts tests/e2e/settings-admin.spec.ts
  tests/e2e/artifacts-panel.spec.ts tests/e2e/incognito-indicator.spec.ts`** — green. `artifacts-panel.spec.ts`
  is Slice 0's file (ruling 26); if it does not exist yet, this slice lands after Slice 0 and the command must
  not be quietly trimmed.
- [ ] **10. Visual check** against `claude-at-home-2-artifact-surfaces-mockups.html` §7 (the `.tour` block
  `:298-311`, legend `:313-315`) at **1440×900 and 390×844, light and dark**: the illustration, the title, the
  body paragraph, three dots, `Step n of 3` and the `Skip` / `Next` pair all present and legible; the card
  sits inside the panel without pushing the artifact off screen; nothing overflows at 390 px. Keyboard: Tab
  reaches Skip first, Escape closes, focus returns to where it was.
- [ ] **11. Staging, real model:** first open of a Canvas → the tour appears; close the panel mid-tour → it
  appears again on the next open, on the slide it was left on; finish it → it does not appear again; open a
  Document → its own tour appears.
- [ ] **12. Staging:** the panel's replay entry (the artifact-list menu row or the empty-state link) shows the
  tour again and does **not** change the seen state — reloading afterwards does not auto-show it.
- [ ] **13. Staging:** a brand-new empty Canvas shows the same sentence the tour showed.
- [ ] **14. Staging, admin:** seed the four drafts; all four appear in the rail with distinct versions
  (`document`, `app`, `canvas`, `slides`), none published; edit the Canvas summary, publish, reload the panel
  → empty state and tour show the new copy; publish another revision → the tour appears once more.
- [ ] **15. Staging:** the sidebar App Version Badge still opens the release note it opened before this
  slice, **with a tour published** (this is T3.0's whole point); the first-run onboarding campaign is
  unchanged.
- [ ] **16. Staging:** open an artifact in an incognito chat → no tour appears (ruling 33), and a `sqlite3`
  count of `artifact_tour_states` for that user is unchanged.
- [ ] **17. Read the staging service journal** for new warnings; `[ANNOUNCEMENT_CAMPAIGNS]` errors from the
  seed route and any 409s from the seen route are the two to look for.

## Open questions for the owner

Every question an earlier draft raised is now ruled, and is recorded here as settled so nobody re-opens it:
**four tours, not five** (`decisions.md` ruling 8), **the `summary` layout, not a column** (ruling 4), **tour
replay in the panel** (ruling 32) and **incognito, the archive and the absent switch** (ruling 33). The four,
with what the ruling changed:

1. **Where does the replay entry point live, and does it need to survive a header rewrite?** **Settled by
   ruling 32: in the panel** — the artifact list's menu and the type's empty state — so the header is not
   rewritten, the sidebar version badge stays campaigns only, and this slice owns neither. The empty state is
   the host that exists in every slice; the list's menu row is added where the menu exists.
2. **Should the seen state go into the account data archive?** **Settled by ruling 33: yes.** The seen state
   is user-scoped data, so it joins the account data archive and is removed on erasure — unlike campaign
   state, which is app-owned and stays out. The archive's exclusion list
   (`account-data-archive/index.ts:74-79`) excludes secrets, logs and derived internals, and this is neither:
   `artifact_tour_states` is simply the first campaign-family row treated as the user's own.
3. **Does an incognito chat show the tour at all?** **Settled by ruling 33: no.** An incognito chat never
   shows a tour — a tour is a write, and incognito promises none — so the panel's trigger checks the
   conversation's incognito flag before it requests anything, and the containment case asserts that no row is
   written from one. For every other chat the seen state is per user and the row names only the kind.
4. **Is a user-facing "don't show these again" needed in v1?** **Settled by ruling 33: no.** A tour already
   shows once per kind per user, so a switch would add a settings row for nothing; if one is wanted later it
   is a preference row in the Profile tab, not a new mechanism.
