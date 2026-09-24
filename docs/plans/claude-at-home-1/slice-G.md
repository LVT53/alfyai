# Slice G — Home: the suggestion chips go, the projects row arrives

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking. Read `plan.md` first. **This slice needs Slice D** (the `HomeSurface` component and the project
> page) **and Slice E** (`project_knowledge_links`, for the card's file count). It also needs Slice D's
> `listRecentlyActiveProjects`.

**Goal:** Delete the conversation suggestion chips **including their backend and their event log**, and put a
row of up to three project cards where they were.

**Architecture:** A net deletion plus one new presentational component. The home read model stops computing
suggestions and starts returning project cards, derived from `listRecentlyActiveProjects` in `projects.ts` —
**no new endpoint**, one cache, one payload. The `home_suggestion_events` table is dropped with a migration,
because nothing else writes to it.

**Tech Stack:** SvelteKit + Svelte 5 runes, Drizzle on better-sqlite3, Vitest, Playwright, Tailwind tokens.

**Spec:** `docs/plans/claude-at-home-1-workspaces-spec.md` §"Slice G" (lines 331–351); mockups §M6
(`…-workspaces-mockups.html`, section 6).

## Global Constraints

Same as `plan.md` §Global Constraints. In addition, for this slice:

- **The removal is total.** Chips, backend, event log, pruning, rate limit, i18n keys, tests and the table.
  No flags, no dead exports, no `if (false)`.
- **No new endpoint.** The cards come from the existing `GET /api/home/summary`.
- **Hidden entirely when there is nothing to show** — no empty heading, no placeholder rule.
- Svelte 5 runes only; Lucide icons only; tokens only; EN + HU in the same commit.

## Gates

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run check && npx biome check src scripts tests && npm test && npm run build
npm run check:migrations
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json
npx playwright test tests/e2e/home-compact.spec.ts tests/e2e/home-memory-review-notice.spec.ts \
  tests/e2e/conversation.spec.ts tests/e2e/mobile-design.spec.ts
```

## Review Focus

1. **A stale reference to the removed rail.** `composeIntoComposer` in the landing page existed only for the
   rail; the `/api/home/summary` POST handler existed only for its event log. Both must go, and the
   dead-code sweep must show no orphans (Task G1).
2. **Dropping the event table with data still in it.** The migration must be a plain `DROP TABLE`, must also
   leave `prepare-db.ts`'s required-table list and the erasure registry consistent, and `npm run check:migrations`
   must pass afterwards (Task G1).
3. **The cards row when the user has projects but no chats in them.** "No projects" and "no projects with
   activity" must both render nothing — not a heading over an empty grid (Task G2).
4. **The phone layout.** Cards are 150px wide and the row scrolls sideways at 390×844 — not a squashed
   three-column grid (Task G2).
5. **A card whose project has instructions but no files, or files but no instructions** — the indicator line
   shows only what exists, and never a bare separator (Task G2).

---

## Verified removal map

| File / symbol | Why it can go |
|---|---|
| `src/lib/components/home/HomeSuggestionRail.svelte` | the chips (`data-testid="home-suggestion-rail"` `:119`, `home-suggestion-chip` `:135`, `home-suggestion-another` `:157`) |
| `src/lib/server/services/home-suggestions.ts` + `.test.ts` | the whole engine (`getHomeSuggestions` `:738`, `recordHomeSuggestionEvent` `:758-776`, `recordHomeSuggestionsShown` `:782-824`, `purgeExpiredHomeSuggestionEvents` `:826-838`, seed builders, ranking) |
| `src/lib/server/services/home-suggestion-rate-limit.ts` + `.test.ts` | rate-limits the POST that goes away |
| `src/routes/api/home/summary/+server.ts` — the `POST` export, `EVENT_KINDS`, `isHomeSuggestionCandidateKey`, the rate-limit import | only the chips' event log used it; **`GET` and the `dismissMemoryReviewNotice` action stay** |
| `src/routes/api/home/summary/summary.test.ts` | trim to what `GET` still serves |
| `src/lib/server/services/home-summary.ts` — `suggestions` field (`:85`), the `getHomeSuggestions` import and call (`:743`), `recordHomeSuggestionsShown` (`:786-790`) | nothing else reads them |
| `home_suggestion_events` table (`schema.ts:2524-2549`, comment `:2514`), its two indexes, its migration `drizzle/1777140000095_home_suggestion_events.sql` entry, its `prepare-db.ts:82` listing, its `USER_SCOPED_TABLES` entry | the rail's event log is the table's only writer |
| `src/lib/client/api/home.ts` — suggestions normalization, `EMPTY_HOME_SUMMARY.suggestions`, `recordHomeSuggestionEvent`, the `HomeSuggestion` re-export | no consumer left |
| `src/lib/components/home/HomeSurface.svelte` — the rail import, `handleSuggestionPick`, the `recordHomeSuggestionEvent` import, the rail element, and `composeIntoComposer` if nothing else calls it | the rail was its only caller |
| i18n `chat.ts` — `home.suggestionsLabel`, `home.another`, `home.anotherLabel`, `home.suggestionSource` and the 27 `home.suggest.*` keys (EN `:1096-1127`, HU `:2263-2294`) | keep `home.weekly*` (`:1084-1095`) and `home.memoryReview.*` (`:1128+`) |
| `tests/e2e/home-compact.spec.ts` — the chip tests (`:319-500`) and the `homeSuggestionEvents` seeding (`:47-51`, `:178-181`) | keep the rest of the file |
| `zz-capture-chips.spec.ts` | it captures the removed chips; delete it, and check `zz-capture-composer.spec.ts` is a *composer* capture before touching it |
| `tests/cross-cutting/incognito-conversation-containment.test.ts:542-543` — the `"services/home-suggestions.ts"` allow-list entry | the file no longer exists, and the guard's honesty test (`:615-623`) fails on a stale key |

**Keep, they only look related:** `routes/api/knowledge/memory/actions/+server.ts` (`invalidateHomeSummary`),
`AtlasActivityRow.stored-rows.test.ts:7` (imports `resolveRunningJobPhase` from `home-summary`),
`home-memory-review-notice.spec.ts`, `tests/e2e/composer-chips.spec.ts` (composer commands, not suggestions).

---

## Contracts

### `HomeProjectCard` and the home summary

```ts
// src/lib/server/services/home-summary.ts
export interface HomeProjectCard {
	id: string;
	name: string;
	color: string | null;
	chatCount: number;
	/** Unix seconds. */
	lastActivityAt: number;
	hasInstructions: boolean;
	fileCount: number;
}
```

`HomeSummary` (`:80-102`) drops `suggestions: HomeSuggestion[]` and gains
`projects: HomeProjectCard[]`. `computeHomeSummary` (`:722-760`) calls `listRecentlyActiveProjects`
(`projects.ts`, Slice D) for the eligible ids and `listProjectKnowledge` (Slice E) for the file counts, and
returns at most `HOME_PROJECTS_LIMIT = 3`. **Do not re-derive the "has messages" rule here.**

### `HomeProjects.svelte` (create)

`src/lib/components/home/HomeProjects.svelte`:

```ts
interface Props {
	projects: HomeProjectCard[];
	/** Same formatter the project page and recent list use. */
	formatRelative: (unixSeconds: number) => string;
}
```

Renders nothing at all when `projects.length === 0` — no rule, no heading, no whitespace block.

Markup, matching §M6: a heading rule (`home.projectsHeading` — "Projects"/"Projektek") whose left line is the
existing `.home-rule` treatment, then one card per project:

- folder icon (Lucide `Folder`, `--accent` token) and the project name
- `instructions.projectStats` / `instructions.projectStatsOne` — reuse Slice D's keys, do not add a second
  relative-time vocabulary
- an indicator line: a pencil icon + `instructions.instructionsLabel` when `hasInstructions`, and a paperclip
  icon + `instructions.filesLabel`/`filesLabelOne` when `fileCount > 0`; each rendered only when it is true, and
  the middot separator only between two present indicators

Each card is a link to `/projects/[projectId]` with `aria-label={$t('instructions.openProjectA11y', { name })}`.
Desktop: `display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px`. Below 640px:
`display: flex; overflow-x: auto; gap: 10px` with cards at `min-width: 150px; flex: 0 0 150px`.

### i18n

| Key | Namespace | EN | HU |
|---|---|---|---|
| `home.projectsHeading` | `chat.ts` | `Projects` | `Projektek` |

No other new keys: every other string is reused from Slice D's namespace.

---

## File ownership

Exclusive to Slice G.

| File | Change |
|---|---|
| `src/lib/components/home/HomeProjects.svelte` | create |
| `src/lib/components/home/HomeProjects.test.ts` | create |
| `src/lib/components/home/HomeSurface.svelte` | rail out, cards in |
| `src/lib/server/services/home-summary.ts` + its four test files | suggestions out, projects in |
| `src/lib/client/api/home.ts` | suggestions out |
| `src/routes/api/home/summary/+server.ts` + `summary.test.ts` | POST out |
| `home-suggestions*.ts`, `home-suggestion-rate-limit*.ts`, `HomeSuggestionRail.svelte` | delete |
| `src/lib/server/db/schema.ts`, `drizzle/**`, `scripts/prepare-db.ts`, `user-scoped-tables.ts` | drop the table |
| `src/lib/i18n/chat.ts` | keys out, one key in |
| `tests/e2e/home-compact.spec.ts`, `zz-capture-chips.spec.ts`, `tests/cross-cutting/incognito-conversation-containment.test.ts` | trim |
| `tests/e2e/home-projects.spec.ts` | create |

**Serialisation:** the only shared file with Slice F is `src/lib/i18n/chat.ts` — **land G's deletions first**.

---

## Tasks

### Task G1: Delete the chips, the engine and the table

**Files:** the removal map above
**Test:** trimmed `home-compact.spec.ts`, `summary.test.ts`, and a new orphan sweep

**Interfaces:**
- Consumes: nothing.
- Produces: `HomeSummary` without `suggestions`.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/components/home/home-sources-removal.test.ts` (create):

```ts
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const GONE = [
	"src/lib/components/home/HomeSuggestionRail.svelte",
	"src/lib/server/services/home-suggestions.ts",
	"src/lib/server/services/home-suggestion-rate-limit.ts",
	"tests/e2e/zz-capture-chips.spec.ts",
];

describe("home suggestion chips are gone", () => {
	it.each(GONE)("deletes %s", (file) => {
		expect(existsSync(file)).toBe(false);
	});

	it("keeps no reference to the removed symbols", () => {
		const surface = readFileSync("src/lib/components/home/HomeSurface.svelte", "utf8");
		for (const symbol of ["HomeSuggestionRail", "recordHomeSuggestionEvent", "handleSuggestionPick"]) {
			expect(surface).not.toContain(symbol);
		}
	});

	it("does not expose suggestions on the home summary payload", async () => {
		const summary = await getHomeSummary({ userId: "user-1" });
		expect(summary).not.toHaveProperty("suggestions");
	});

	it("no longer accepts a suggestion event on the home summary route", async () => {
		// POST /api/home/summary must no longer exist; the dismissMemoryReviewNotice action must.
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run src/lib/components/home/home-sources-removal.test.ts`
Expected: FAIL — the files exist.

- [ ] **Step 3: Delete, then trim**

Delete in this order so the tree stays coherent: the rail component → the server engine and rate limit → the
route's POST and its helpers → the summary field and its two call sites → the client normalisation → the
surface's wiring (including `composeIntoComposer` if nothing else uses it) → the i18n keys → the tests.

Then the table: write
`drizzle/1777140000108_drop_home_suggestion_events.sql` containing
`DROP TABLE \`home_suggestion_events\`;` with the matching journal entry, remove the `sqliteTable` export and
its two indexes from `schema.ts`, remove the name from `prepare-db.ts`'s required-table list, and remove its
`USER_SCOPED_TABLES` entry. **Leave `usage_events_user_created_idx` alone** — it was added by the same
migration but belongs to `usage_events`.

Then remove the stale `"services/home-suggestions.ts"` entry from the incognito containment allow-list.

- [ ] **Step 4: Run the tests and the migration checks**

Run:
```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run src/lib/components/home src/lib/server/services/home-summary src/routes/api/home tests/cross-cutting
npm run check:migrations && npm run db:prepare
npm test
```
Expected: PASS. `npm test` is included here because the summary change touches four test files that assert the
old shape.

- [ ] **Step 5: Commit**

```bash
git add -A src/lib/components/home src/lib/server/services src/routes/api/home src/lib/client/api/home.ts \
  src/lib/server/db/schema.ts drizzle scripts/prepare-db.ts \
  src/lib/server/services/account-lifecycle/user-scoped-tables.ts \
  src/lib/i18n/chat.ts tests
git commit -m "Remove the home suggestion chips and their event log

The owner asked for the whole path to go, not just the rail: the engine, the
rate limit, the shown/dismissed bookkeeping, the pruning sweep and the table it
all wrote into. Nothing else read that table, so it is dropped rather than left
behind as an empty curiosity."
```

### Task G2: The projects row

**Files:** `src/lib/components/home/HomeProjects.svelte` + test, `HomeSurface.svelte`,
`src/lib/server/services/home-summary.ts` + tests, `tests/e2e/home-projects.spec.ts` (create)

**Interfaces:**
- Consumes: `listRecentlyActiveProjects` (Slice D), `listProjectKnowledge` (Slice E),
  `instructions.*` keys (Slices C/D).
- Produces: `HomeSummary.projects`.

- [ ] **Step 1: Write the failing tests**

Unit (`HomeProjects.test.ts`):

```ts
it("renders nothing when there are no projects", ...);
it("renders at most three cards", ...);
it("shows the instructions indicator only when the project has instructions", ...);
it("shows the files indicator only when the project has files", ...);
it("shows both indicators with a separator between them", ...);
it("shows no separator when only one indicator is present", ...);
it("links each card to its project page", ...);
```

Server (`home-summary.test.ts`):

```ts
it("returns the three most recently active projects", ...);
it("excludes projects without any conversation that has messages", ...);
it("returns an empty list for a user with no projects", ...);
it("counts only the user's own linked files", ...);
it("does not leak another user's project name into the payload", ...);
```

E2E (`tests/e2e/home-projects.spec.ts`): with seeded projects, the row appears between the composer and the
recent list with the heading rule and the expected card contents; a card click opens the project page; with no
projects the row is absent from the DOM (not merely invisible).

- [ ] **Step 2: Run them to verify they fail**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run src/lib/components/home/HomeProjects.test.ts src/lib/server/services/home-summary.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add `HomeProjectCard`, `HOME_PROJECTS_LIMIT = 3`, and the assembly in `computeHomeSummary`; build
`HomeProjects.svelte` per Contracts; and render it in `HomeSurface.svelte` as the **first child of
`div.home-board`**, where the rail was — between the composer and the recent list.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command, then
`npx playwright test tests/e2e/home-projects.spec.ts tests/e2e/home-compact.spec.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/home src/lib/server/services/home-summary* src/lib/i18n/chat.ts \
  tests/e2e/home-projects.spec.ts
git commit -m "Show the recently active projects on the home screen

Projects only become workspaces people return to if they can see them, and a
card carries the two things worth knowing — whether it has instructions, and
how many files it knows. The row is absent rather than empty when there is
nothing to show."
```

### Task G3: The final sweep

**Files:** none new

- [ ] **Step 1: Orphan sweep**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && rg -n "home-suggestion|HomeSuggestionRail|recordHomeSuggestionEvent|homeSuggestionEvents|home\.suggest" --glob '!docs/plans/**' .`
Expected: no hits. Every hit is either a missed removal (fix it) or a plan document (fine).

- [ ] **Step 2: Full gate run**

Run:
```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run check && npx biome check src scripts tests && npm test && npm run build
npm run check:migrations
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json
npx playwright test tests/e2e/home-compact.spec.ts tests/e2e/home-memory-review-notice.spec.ts \
  tests/e2e/home-projects.spec.ts tests/e2e/conversation.spec.ts tests/e2e/mobile-design.spec.ts
```
Expected: all green; Fallow **smaller** than before this slice (this is a net deletion).

- [ ] **Step 3: Commit** (only if step 1 or 2 required changes)

```bash
git add -A
git commit -m "Finish the home chips removal sweep"
```

---

## Non-goals

- **No replacement suggestion mechanism** of any kind.
- **No project creation or renaming from the home row.** The cards are links.
- **No new endpoint**, no new cache key, no second payload.
- **No change to the weekly bars, the memory-review notice, the recent list or the degraded-capabilities strip.**
- **No change to the dismiss-memory-review action** on the home summary route.
- **No change to composer suggestions** (`composer-chips.spec.ts` covers a different feature — leave it).

## Risks

| Risk | Why it bites | Mitigation |
|---|---|---|
| The `DROP TABLE` migration and the schema drift apart | `check:migrations` fails and `db:prepare` warns forever | Task G1 step 3 lists all four places the table is named; step 4 runs both checks |
| A stale allow-list entry in the incognito guard | The guard's honesty test fails, or worse, a real offender is masked | Remove the entry in the same commit |
| Four `home-summary` test files assert the old shape | A red suite that looks like a regression in this slice | Task G1 step 4 runs `npm test` deliberately, and the slice owns those files |
| An empty projects row renders a heading over nothing | Looks broken on a fresh account | The component returns nothing when the list is empty, and the E2E test asserts absence from the DOM |
| Card counts differ from the project page | Two surfaces disagree about the same project | Both read `listRecentlyActiveProjects` and the same file-count function |
| The phone row squashes instead of scrolling | Long project names become unreadable at 390px | Explicit 150px fixed basis + `overflow-x: auto`, checked against §M6 |

## Verification checklist

- [ ] Every task's tests were seen failing first, then green.
- [ ] `npm run check` — 0 errors, 0 warnings.
- [ ] `npx biome check src scripts tests` — clean.
- [ ] `npm test` — green.
- [ ] `npm run build` — 0 warnings.
- [ ] `npm run check:migrations` passes; `npm run db:prepare` clean with no warning about the dropped table.
- [ ] `npx fallow --no-cache --format json --quiet --score` — **fewer** findings; no new ignores.
- [ ] `npx playwright test tests/e2e/home-*.spec.ts tests/e2e/mobile-design.spec.ts tests/e2e/conversation.spec.ts`
      — green.
- [ ] Orphan sweep (Task G3 step 1) returns no hits outside plan docs.
- [ ] **Real-app visual check** against mockup §M6 at **1440×900 and 390×844, light and dark**: the heading rule
      reads "Projects", three cards with folder icon, name, `N chats · <relative>` and the indicator line; on the
      phone the cards are 150px and the row scrolls sideways. With no projects, the row is absent.
- [ ] **Staging:** the home screen no longer shows any suggestion chip; a project with instructions and files
      shows both indicators; clicking a card opens the project page.

## Owner decisions (ratified 2026-09-24)

All three questions raised here were answered. `decisions.md` is the master record.

1. **A project with no chats shows no card**, so every card carries a true "N chats · active …" line and the row
   matches §M6. Known consequence: a project created minutes ago is reachable only from the sidebar until its
   first chat. Revisit only if the owner asks — it would need one extra key (`No chats yet`) and one ordering
   rule.
2. **No per-project colour on the cards** — accent folder, following the mockup. Projects keep their colour in
   the sidebar, which is where distinguishing rows matters.
3. **The `home.suggest.*` block is deleted outright** — 27 keys per locale, plus `home.suggestionsLabel`,
   `home.another`, `home.anotherLabel` and `home.suggestionSource`.
