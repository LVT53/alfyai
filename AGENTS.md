# AGENTS.md

**Generated:** 2026-04-06 15:20 UTC  
**Commit:** 2322eed  
**Branch:** main  

This file is the canonical engineering map for AlfyAI. Read it before changing code. Public setup, deployment, and environment documentation live in [README.md](./README.md). Product and design notes in other docs are supplemental, not the source of truth for code placement.

## Mandatory Docs Check

- Before touching code, check current documentation through Context7 and the Svelte/SvelteKit MCP docs tools for the relevant framework or library surface.
- This is especially required for Svelte, SvelteKit, Tailwind, Vitest, Playwright, Drizzle, and any fast-moving integration used by this app.
- Do not write framework code purely from memory when an MCP-backed docs check can confirm the current API or recommended pattern.
- The goal is to avoid stale code, deprecated patterns, and implementations that drift away from the real versions used in this repo.
- If the Svelte MCP/docs tool is unavailable in the current session, use the best available official docs path before coding and call out that fallback explicitly.

## Fallow Audit Gate

- Fallow is pinned in `package.json` to one exact release (`fallow`, 3.33.1 today), and the gate runs that release whether or not `node_modules` has it: `npx -y fallow@<that version>`. A bare `npx fallow` runs whatever is installed, or the latest release where nothing is, and releases report differently. Bumping the pin and making the baseline again (below) are one change: `scripts/gates.test.ts` fails when the baseline was made by another release.
- Before calling a patch finished, run the Fallow step against the current worktree. It is one of the steps of `scripts/gates.sh agent <out-dir> ...` (see Mandatory Verification), and it runs alone with `scripts/gates.sh agent "$TMPDIR/alfyai-gates" --skip check,biome,migrations,vitest,build,chunks,playwright`. The raw report: `npx -y fallow@3.33.1 --no-cache --format json --quiet --score > "$TMPDIR/alfyai-fallow.json"`. The report is stdout: Fallow 3 refuses `--output-file` anywhere but inside the project root or the system temp dir, so never hand it a path of the caller's.
- The step compares the report's `check` section with the baseline committed in `.fallow/baseline.json`. A finding is its kind, path and name: its position, `finding_id`, `actions`, `effective_severity` and `reachability_caveats` are not part of it, so a finding that only moved is not new. A finding the baseline lacks fails the step, and so does a fifth circular dependency. The health score, duplication and lines of code on the step's summary line are information only; nothing reads them back.
- The baseline holds known architectural debt and nothing else (today: the four circular dependencies). Make it again only with a recorded reason, from a report made as above: `node -e 'const [f]=process.argv.slice(1),r=JSON.parse(require("fs").readFileSync(f));delete r.check.elapsed_ms;require("fs").writeFileSync(".fallow/baseline.json",JSON.stringify({check:r.check},null,"\t")+"\n")' "$TMPDIR/alfyai-fallow.json"`. `.fallow/` also holds Fallow's cache when it runs without `--no-cache`; Fallow ignores that with a `.gitignore` of its own, and the baseline is the one tracked file there.
- Treat new Fallow findings as regressions unless they are intentional public API, dynamic entry points, or known architectural debt documented in `.fallowrc.json`.
- Do not add broad `ignoreExports`, `ignorePatterns`, or rule suppressions just to make the report green. Every new ignore must describe a real public boundary, dynamic loader, standalone script, or false positive.
- If a change intentionally affects the remaining circular-dependency debt, rerun Fallow and report whether the four known cycle findings changed.

## Typecheck Gate

- Before calling a patch finished, run `npm run check` and keep it fully clean: 0 errors and 0 warnings.
- Treat new `svelte-check` diagnostics as regressions. Fix them in the same patch unless the user explicitly asks to defer them.
- If `npm run check` fails because of pre-existing diagnostics unrelated to the patch, report the exact current count and files, and do not introduce any new diagnostics.

## Svelte 5 Migration Rules

- Prefer Svelte 5 callback props over `createEventDispatcher` for component-to-parent communication.
- Prefer `$props()` and typed `PageProps` / `LayoutProps` in SvelteKit route components.
- Prefer modern event attributes like `onclick` and `onsubmit` over legacy `on:` directives in touched files.
- In rune components, declare `bind:this` refs with `$state(...)` when the ref is later read by effects or handlers.
- Touch event attributes are passive by default in Svelte 5. If a handler truly needs `preventDefault()` (for example custom touch dragging), attach a non-passive listener via an action or explicit `addEventListener`, not legacy event modifiers.
- Prefer `{@render children()}` in layouts over legacy route `<slot />` usage.
- Do not introduce new `afterUpdate` or `beforeUpdate` calls; use a modern effect- or action-based approach instead.
- Do not introduce new legacy `<slot>` usage in app components; prefer explicit props or snippets when composition is needed.
- Legacy syntax that still exists in untouched files is migration debt, not a pattern to copy forward.

## Purpose

- Use the existing boundaries in this file before inventing new ones.
- Optimize for reliability, low duplication, and clear ownership.
- Keep behavior stable at the route, SSE, DB, and component-contract layers unless the change is explicitly intended to alter those contracts.
- Prefer extending an existing subsystem over adding a new top-level service, store, or client helper.

## Core Rules

- Routes are adapters. Durable logic belongs in server services, client API modules, stores, or shared helpers.
- Shared behavior should exist once. Do not copy logic between `send` and `stream`, between multiple stores, or between multiple services.
- Composer command and skill work belongs in explicit app-owned boundaries: composer UI in `src/lib/components/chat/MessageInput.svelte` and related chat command components, browser fetch logic in `src/lib/client/api/skills.ts`, durable skill/session/note behavior in `src/lib/server/services/skills/`, chat-turn parsing and prompt integration in `src/lib/server/services/chat-turn/`, and Skill Note artifact behavior through the knowledge service boundary. Do not hide skill persistence, note writes, command parsing, or Skill Control Envelope handling in route-local closures.
- Runtime config flows through `src/lib/server/config-store.ts`. Do not bypass it in code that should respect admin overrides.
- New Composer Command, Skill, Skill Session, Skill Note, and Linked Source UI labels, errors, confirmations, empty states, and accessibility strings must be localized in both English and Hungarian.
- `src/lib/server/env.ts` owns environment parsing, including `getDatabasePath()` for DB bootstrap-only access. Do not read `DATABASE_PATH` directly anywhere else.
## App Map

### Artifacts

#### Tours

The first time a user opens a Document, an App or a Canvas the panel shows a three-slide card about that kind (rulings 4, 8, 32, 33, 69, 71; Slides is shelved, so no Slides tour and no Slides chip on the Knowledge tab (`DOCUMENT_TYPE_FILTER_ORDER`), and File never has one).

- **Server.** `src/lib/server/services/artifact-tours.ts` resolves a kind's tour (the newest published `artifact_tour` campaign snapshot, else the code copy in `src/lib/server/artifact-tour-defaults.ts`; archiving a published tour gives the kind its code copy back, never "no tour", ruling 71: the text is editable and the trigger is not), records "seen" (`markArtifactTourSeen`, insert-if-absent on `(user, kind, content key)`, so the first answer stands) and seeds the admin drafts. `src/routes/api/artifact-tours/[type]` (GET) and `.../seen` (POST) are thin (`requireApiUser`); the browser reaches them only through `src/lib/client/api/artifact-tours.ts`. `SHIPPED_ARTIFACT_TOUR_TYPES` in `src/lib/shared/artifacts/tours.ts` is the one list of kinds whose tour ships: routes, resolver, seeding, the archive and the panel all read it, so never walk `ARTIFACT_TOUR_DEFAULTS`' keys to serve or list a kind. The seen row (`artifact_tour_states`) holds a user, a kind, a content key, a status and slide counters, never a conversation or an artifact; no tour code path reads an artifact table, and there is deliberately no `ALLOWED_WITHOUT_SCOPE` entry for any of it. `getLatestPublishedAnnouncement()` is the one reader for the sidebar version badge: the newest published release update, else (none published) the newest first-run onboarding (ADR-0012), never a tour, with no type argument for a caller to get wrong. **A kind has one live tour**: `publishCampaign` archives any older published `artifact_tour` of the same kind in the same transaction, so archiving the newest gives the kind its code copy back and not the revision before it (a release note keeps its older published revisions). **A tour's summary slide is one bare line**: its title is what an empty Document, App or Canvas shows, so neither the publish rule nor its checklist mirror asks it for a body and the seed leaves the body empty. **A tour's kind is its campaign's release text**, and the resolver finds a tour by exactly that, so `announcement-campaigns.ts`'s `validatePublishInput` refuses to publish an `artifact_tour` whose `releaseVersion` is not on the shipped list (`tourKind`, mirrored by `campaign-checklist.ts`, so Publish is dead before a click); the admin pane's lines say "Tour · Canvas", the kind in its `artifacts.type.*` word (`campaigns/campaign-labels.ts`), never "Release · canvas".
- **The admin's editor knows a tour is not an announcement.** In `src/routes/(app)/settings/_components/campaigns/` a tour's slides have words only (no screenshot, alt text or button), the summary slide says what its title is and has no body field (`SlideEditor`'s `tour` prop), the details dialog shows the type read-only, Summary is offered to a tour alone and Setup not to it (`SlideOptionsDialog`), the rail and the header count steps and the empty-state line (`tourCountLabel`, `tourStepNumbers` in `campaign-labels.ts`), no performance card is drawn for a tour, publishing one refreshes the rail (the revision it replaced is archived behind it), and the preview is `TourPreview.svelte`: the reader's own card, loaded lazily from `artifacts/tour/`, `inert`, fed the draft's words in the language being edited (the summary slide previews as the shared `EmptyState`). Drafts the seed makes are named in the seeding admin's language (`TOUR_DRAFT_NAMES` in `artifact-tours.ts`), and `seedArtifactTours` lives in `client/api/campaigns.ts` with the other admin calls, not in `client/api/artifact-tours.ts`, which the chat loads. The account archive lists the introductions a user has seen on the Profile page.
- **The panel decides, the card reports.** `DocumentWorkspace.svelte` asks once when an item of a shipped kind becomes the open one (`tourItemKind`/`presentTour`), and shows `tour/ArtifactTour.svelte` as a row of the item's stage, ahead of the body (`.workspace-tour-slot`: in the panel's flow and in the tab order, so the item starts under it and nothing of the item is covered) when the answer is an unseen tour. It writes "completed" or "dismissed" when the reader finishes or Skips, never when the card renders (closing the panel mid-tour writes nothing and the card is met again), reads a 409 as "the copy changed" (ask again, start the new one at slide one), and treats any failure as a console warning with the panel working as before. **An incognito chat makes no tour request at all** (the panel's `incognito` prop, from the chat page): a tour's seen state is a write, and incognito promises none. The card and its three drawings (`tour/illustrations/`) are one lazy chunk, imported only when a tour is about to show; nothing static in the chat shell may import them. **How the card arrives** (RC-T I-1): the answer is kept per page load in `client/api/artifact-tours.ts` (one request per kind, shared while on the wire; a failed read is not kept; a finished or skipped tour is seen at once, before the write lands; a refused or failed write forgets the kind, so a 409 re-asks the server; a replay uses `refreshArtifactTour`; login and logout are client-side navigations, so the panel names the reader with `keepArtifactToursFor(currentUser?.id)` before it asks and a different reader starts clean), so a second item of a kind costs no request and shows its line from the first frame. The card **enters (when its answer is late) and leaves (when the reader leaves it) as a height that grows and shrinks** (the panel passes `animate`: a `slide` on a wrapper with a *global* transition, because the panel removes the card and not the wrapper's own block; `MOTION_DURATION.emphasis`, instant under reduced motion; the admin's preview does not animate), and it hands focus back the moment the reader leaves, not when the exit has played. A card is revealed, never re-laid out: the wrapper animates, the card inside keeps its size. **The card has its room from the item's first frame and covers nothing** (FX-2, RC-A #4, ruling 77; FB-3 had laid it over the item, which moved nothing but hid the Document's toolbar and first lines, the App's status row and the board's top, 214 of 844 px on a phone). **On a phone the card is compact** (FX-4, ruling 77): a 48 px picture at the corner, the words under it, and the step line and the buttons in ONE row (`.tour-bar`: it dissolves on a wide panel, where the step line is back above the words by `order`), 160 px instead of 214, so the Document's text starts above the middle of the screen while the first slide is up; `artifact-panel-motion.spec.ts` holds it at 390 px in English and 360 px in Hungarian, and a card dismissed gives its room back as the short height glide, not a cut. Its answer is asked for as soon as the chat has an item of that kind (`warmTours`, keyed on the kinds in `list.items`, never in an incognito chat; `peekArtifactTour` reads what has settled without waiting; `tour/tour-card.ts` is the card's one lazy door: `loadTourCard` brings the chunk in when the reader owes a tour, `loadedTourCard` says whether it is in hand). `presentTour` runs in a `$effect.pre`, so when the answer and the card are in hand the card is in the page in the flush that opens the item, before the body mounts (`entrance: "none"`: nothing grows in and nothing moves); an answer that is late (the first ask still on the wire, a replay, the new copy after a 409) grows in as a height (`entrance: "reveal"`), and the board follows its pane (TR-D1). The card shrinks away only when the reader leaves it (Skip, "Got it", Escape); a card that goes because its item did, or the panel closed, goes at once. It takes focus a task after it mounts, once the panel has put focus on the item's title. The empty state's replay link is handed to the body (`bodyReplayTour`) only while no card is up. Next and Back announce the new step's position and title through a live region of the card's own (`artifact-tour-live`); the visible step line is plain text.
- **The empty states say what the tour says** (T6). A Document, an App and a Canvas with nothing in them draw one shared `EmptyState.svelte`: the kind's line and, beneath it, a quiet "Show it again" button that calls `ArtifactBodyProps.onReplayTour`. The line is `emptyStateLine(...)` (`artifacts/empty-state.ts`): the tour's summary in the reader's language when one answered, else the dictionary's fallback (`EMPTY_STATE_FALLBACK_KEYS`: `artifacts.document.emptyState`, `artifacts.app.emptyState`, `artifacts.canvas.emptyBoard`), and `empty-state.test.ts` fails when a shipped summary and its fallback disagree, so a copy edit has one place to go. The panel keeps `tour.summary` from the one request it already makes per open (seen or not) and hands it down as `ArtifactBodyProps.tourSummary`; a body never asks for it itself, and an incognito chat, which asks for none, shows the dictionary's line and **no link**. Where each kind's empty state is: the Canvas's centred over the empty board (`CanvasBoard`'s `canvas-empty`), the Document's laid just under the page's first line while the editor reports itself empty (`createDocumentEditor`'s `onEmptyChange`, asked of every transaction, because Alfy's landing content and a restored version are silent; the Tiptap placeholder has no style and is not the empty state), the App's in the Preview where a blank frame would be (an App with no source; the tools never save one, so it is rare). Do not add a fourth copy of the line or a per-kind link.
- **Replay lives in the panel** (ruling 32): the list row menu's "How this kind works" (`ArtifactDeletePopover`'s `onReplayTour`, quiet, above Delete; the menu is a real `role="menu"`: it opens on its first item through `AnchoredPopover`'s `initialFocus`, ArrowDown/ArrowUp wrap between the items, Home/End go to the ends, Escape closes it and gives the focus back) and `ArtifactBodyProps.onReplayTour`, the one callback a body's empty state calls (supplied only where a tour can show: never for another kind, never in an incognito chat). A replay shows the same card, labelled "Replaying", and records nothing: the card calls `onClose`, never `onSeen`/`onDismiss`.
- **The card is a region, not a dialog.** It traps no focus and makes nothing inert; it takes focus when it shows unless the reader is already typing, gives it back when it goes, and Escape is Skip only while focus is inside it. Next and "Got it" are one button so the keyboard keeps its place. The chrome is `artifacts.tour.*`; the tour's own words are content (code copy or campaign), never in the dictionary.
- **e2e.** The shared e2e admin has seen every tour (`tests/e2e/global-setup.ts` writes the rows), so no other spec meets a card; `tests/e2e/artifact-tours.spec.ts` signs in as users of its own (`artifact-tours-helpers.ts`). A published tour is taken back out the way an admin does it, by archiving (`archiveTour`; ruling 71 gives the kind its code copy back, so no later spec meets a tour nobody has seen); `publishTour` duplicates the kind's last campaign when an earlier test left no draft, and can reword the summary (the empty state's line). `artifact-tours-empty-states.spec.ts` covers the empty states with readers who have finished every tour (`markToursSeen`).

### Config And Environment

- Environment parsing:
  - [`src/lib/server/env.ts`](./src/lib/server/env.ts)
- Runtime merge and normalization:
  - [`src/lib/server/config-store.ts`](./src/lib/server/config-store.ts)
- Admin config route:
  - [`src/routes/api/admin/config/+server.ts`](./src/routes/api/admin/config/+server.ts)
- Admin user-management routes:
  - [`src/routes/api/admin/users/+server.ts`](./src/routes/api/admin/users/+server.ts)
  - [`src/routes/api/admin/users/[id]/+server.ts`](./src/routes/api/admin/users/[id]/+server.ts)
  - [`src/routes/api/admin/users/[id]/sessions/+server.ts`](./src/routes/api/admin/users/[id]/sessions/+server.ts)
- Settings loaders:
  - [`src/routes/(app)/settings/+page.server.ts`](<./src/routes/(app)/settings/+page.server.ts>)
  - [`src/routes/api/settings/+server.ts`](./src/routes/api/settings/+server.ts)
- Two-scope instruction resolution: [`src/lib/server/services/instructions.ts`](./src/lib/server/services/instructions.ts)

Notes:

- `env.ts` also owns `getDatabasePath()` for bootstrap-only DB path access.
- Title-generator prompt variants flow through `env.ts`, `config-store.ts`, and the admin system settings UI. Keep English/Hungarian base prompts and code-only appendices aligned across those layers.
- TEI endpoint/model tuning also flows through `env.ts` plus `config-store.ts`. Keep API keys env-only, and keep runtime overrides on the non-secret fields.
- `config-store.ts` remains the override-aware runtime config boundary. `getDatabasePath()` is for early DB/bootstrap code, not for general runtime settings reads.
- Context token limits are admin-configurable via `config-store.ts`:
  - `MAX_MODEL_CONTEXT` (default: 262144) - Maximum tokens the model context window supports
  - `COMPACTION_UI_THRESHOLD` (default: 209715) - UI warning threshold at 80% of max
  - `TARGET_CONSTRUCTED_CONTEXT` (default: 157286) - Target context size at 60% of max
  - Use getter functions in `config-store.ts` (e.g., `getMaxModelContext()`, `getCompactionUiThreshold()`, `getTargetConstructedContext()`) to read these values with admin overrides applied.

If you add a new runtime-configurable setting:

1. add env parsing/default handling in `env.ts` if it is environment-backed
2. add runtime normalization and override support in `config-store.ts`
3. expose it to the relevant settings/admin loaders and routes
4. update [README.md](./README.md) and [`.env.example`](./.env.example)

Do not:

- read directly from `process.env` or `env.ts` inside services that should respect admin overrides
- read `process.env.DATABASE_PATH` directly outside `env.ts`
- import override-aware runtime config into bootstrap code that only needs the DB file path
- document a config variable publicly without confirming it exists in real code paths
- add admin-configurable behavior in the UI without threading it through `config-store.ts`

### Additional Active Services

- Chat rendering components live under [`src/lib/components/chat/`](./src/lib/components/chat/).
- Layout/navigation components live under [`src/lib/components/layout/`](./src/lib/components/layout/).
- Sidebar-specific pieces live under [`src/lib/components/sidebar/`](./src/lib/components/sidebar/).

Important component boundaries:

- [`src/lib/components/layout/Sidebar.svelte`](./src/lib/components/layout/Sidebar.svelte)
  - navigation shell and store-driven sidebar state
- [`src/lib/components/layout/Header.svelte`](./src/lib/components/layout/Header.svelte)
  - top-level app shell interactions
- [`src/lib/components/sidebar/ConversationList.svelte`](./src/lib/components/sidebar/ConversationList.svelte)
  - owns sidebar drag/drop state and project-drop move orchestration through the existing conversations store path

Do not:

- bury durable business logic inside a presentational component because it is "already open"
- duplicate chat state transitions in both page files and chat components
- move project-folder drag/drop persistence into `ConversationItem.svelte` or `ProjectItem.svelte`; those components stay event emitters
- use unused legacy-looking components as templates without checking whether they are actually live

### Visual System And Layout Guardrails

- Design tokens live in:
  - [`src/app.css`](./src/app.css)
  - [`tailwind.config.ts`](./tailwind.config.ts)
- Token categories already defined:
  - semantic surface, text, icon, border, status, radius, spacing, duration, and shadow variables
- Font ownership:
  - UI chrome uses `Nimbus Sans L`
  - long-form message content uses `Libre Baskerville`
  - code uses the mono stack defined in `tailwind.config.ts`

Rules:

- prefer semantic CSS custom properties over hardcoded hex values when a token already exists
- keep spacing on the existing 4px-derived scale exposed through the spacing tokens
- preserve the reading-first visual direction: quiet UI chrome, generous spacing, and message content as the focal surface
- if you change color, spacing, radius, or typography primitives, update both `src/app.css` and the Tailwind mapping when needed
- **Icon sourcing**: all UI icons MUST come from [Lucide](https://lucide.dev) via `@lucide/svelte`. Never write inline `<svg>` elements for icons — always import the equivalent Lucide component. The only exceptions are: (a) the custom brand logo (`LogoMark.svelte`), (b) data visualization SVGs that are charts/graphs not icons (`ContextUsageRing.svelte`), and (c) icons that have no Lucide equivalent (verify before concluding none exists). When adding a new icon, import it from `@lucide/svelte` with the correct PascalCase name, set `size` and `strokeWidth` to match the design system, and always include `aria-hidden="true"` on decorative icons.

Scroll ownership contract:

- `body` should not become the scrolling surface
- the authenticated app shell contains layout overflow
- the sidebar list owns sidebar scrolling
- [`src/lib/components/chat/MessageArea.svelte`](./src/lib/components/chat/MessageArea.svelte) owns conversation scrolling

Do not:

- reintroduce body scrolling to solve a local layout bug
- hardcode one-off colors in components when the token system can express the change
- change typography choices in chat surfaces casually; those are part of the product identity
- move scroll responsibility between body, page, and message list without testing desktop and mobile behavior together

## Known Traps

- If you touch chat send/stream behavior, you are changing a multi-file contract:
  - server route
  - `chat-turn/*`
  - browser stream consumer
  - related tests
- Admin settings can override env-backed defaults. A change that looks correct in `.env` may still be superseded at runtime.
- Auxiliary services such as title generation and context summarization should degrade gracefully. Do not make them hard dependencies of the core chat path unless that behavior change is intentional.
- Do not restore deleted `project-memory.ts`-style architecture or add duplicate DB wrapper files. New persistence should stay in the owning service unless a narrow compatibility shim belongs in `db/compat.ts`.

## Change Placement Guide

- New chat request/shared turn logic:
  - `src/lib/server/services/chat-turn/`
- New Normal Chat prompt/model/tool behavior:
  - `src/lib/server/services/normal-chat-context.ts`
  - `src/lib/server/services/normal-chat-model/`
  - `src/lib/server/services/normal-chat-tools/`
  - `src/lib/server/services/normal-chat-control-model.ts`
  - `src/lib/server/services/normal-chat-failover.ts`
- New admin-managed user account behavior:
  - `src/lib/server/services/user-admin.ts`
- New knowledge artifact or context behavior:
  - `src/lib/server/services/knowledge/`
- New artifact-family (Document/App/Canvas/Slides/File) behavior:
  - `src/lib/server/services/artifacts/`
  - `src/lib/components/artifacts/`
- New chat-generated file behavior:
  - `src/lib/server/services/chat-files.ts`
  - `src/lib/server/services/sandbox-execution.ts`
- New continuity or evidence-context logic:
  - `src/lib/server/services/task-state.ts`
- New profile-memory behavior:
  - `src/lib/server/services/memory-judge/` (intake), `memory-consolidation/` (maintenance), `memory-profile/` (projection)
- New reusable browser API call:
  - `src/lib/client/api/`
- New client state transition:
  - `src/lib/stores/`
- New landing/chat handoff behavior:
  - `src/lib/client/conversation-session.ts`
- New environment-backed runtime setting:
  - `src/lib/server/env.ts` and `src/lib/server/config-store.ts`

## Commit and Push Discipline

- Commit in small, focused chunks. Each commit should contain one logical change — a single feature, a single fix, or a single refactoring — so that `git bisect` and `git revert` remain useful tools.
- Write commit messages that explain the *why*, not just the *what*.
- Never push to any remote branch without explicit user request. The local commit history is the source of truth until the user explicitly asks for a push.
- Do not batch unrelated changes into a single commit just because they happen in the same session.

## Build and Runtime Warning Discipline

- A clean build is a required invariant. `npm run build` must produce **zero warnings** from Vite, Svelte, TypeScript, or any compiler plugin.
- Every warning must be fixed or explicitly suppressed with a comment explaining why suppression is safe.
- In Svelte 5, `state_referenced_locally` warnings indicate a prop is being read inside `$state()` initialisation and will not react to future changes. When capturing an initial value is intentional, wrap the read in `untrack(() => ...)` to make the intent explicit and silence the compiler.
- Do not ignore warnings because the app "still works." Warnings are often early signals of stale data, missed reactivity, or future breaking changes.
- If a dependency upgrade introduces new warnings that cannot be immediately resolved, pin the dependency and file a tracked follow-up task. Do not leave unpinned warnings in the build output.


## Mandatory Verification

Default verification after meaningful changes (an agent runs the whole of it **once, at the end**: the owner's speed rule):

```bash
scripts/gates.sh agent <out-dir> --port <base> [--workers N] <the e2e specs you changed or added>
```

It runs the static gates (`npm run check`, `npx biome check src scripts tests`, `npm run check:migrations`, `npm test`, `npm run build`, `npm run check:artifact-chunks`, Fallow against its baseline) side by side, then your specs in full plus the `@smoke` tests of every other file, and prints one screen with each step's exit code, numbers and duration (about 4 minutes; vitest is most of it). While iterating, run the single commands: `npm run check`, `npm test`, `npm run build`. In a worktree use `npx biome check src scripts tests`, not `npm run lint` (it stops at the nested worktrees' biome roots).

Name the specs that cover what you changed (they run in full; the `@smoke` set covers the rest of the app):

- chat send/stream behavior: `tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts tests/e2e/conversation.spec.ts`
- landing/chat draft handoff or composer behavior: `tests/e2e/chat.spec.ts tests/e2e/conversation.spec.ts`
- settings/admin/config behavior: `tests/e2e/settings-admin.spec.ts tests/e2e/login.test.ts`
- login/search/shell regressions: `tests/e2e/login.test.ts tests/e2e/search-modal.spec.ts`
- an artifact kind: its `tests/e2e/artifact*.spec.ts` files (the Document, App and Canvas ones are named by kind)

Playwright runs against the **production build** (`npm run build` first, about 15 s alone; a build older than `src/` is refused before any server starts, and a build that does not hydrate stops the run in two seconds), with one server and one SQLite file per worker slot: slot N is Playwright's `TEST_PARALLEL_INDEX` N, served on `E2E_PORT + N` with `data/playwright-e2e-chat-wN.db` and its own seeded admin, so spec files run side by side without meeting each other's rows. `tests/e2e/e2e-env.ts` says what a slot is, `tests/e2e/global-setup.ts` makes the databases and starts the servers, `playwright.config.ts` points each worker at its slot. **Never run `npm run check` or `npm test` while `npm run build` runs** (both run `svelte-kit sync`, which rewrites `.svelte-kit/` under the build: it still exits 0 and the app it made does not hydrate); `scripts/gates.sh` orders them for you.

- **Iterating on UI code** (a rebuild per change would be slower): `E2E_SERVER=dev E2E_PORT=<port> npx playwright test <spec>`: `vite dev`, one worker by default, one optimizer cache per server.
- **One or two specs on the build:** `E2E_PORT=<port> E2E_WORKERS=2 npx playwright test <spec> [<spec>]`. Beside one or two other agents use `E2E_WORKERS=4` at most; a run takes `E2E_WORKERS` ports from `E2E_PORT`.
- **The smoke tier** (25 tests tagged `@smoke` across sign in, chat and streaming, each artifact kind in the panel, a Document edit and its version, a Canvas block, a tour, knowledge, settings and projects; about 30 s): `E2E_PORT=<port> npm run test:e2e:smoke`.
- **The release gate:** `scripts/gates.sh release <out-dir> --port <base>` runs the same static gates, then the whole Playwright suite minus `tests/e2e/quarantine.json` (6 workers by default; `--workers 8` on a quiet machine). About 8.5 minutes on this Mac against 51 before: the e2e run starts when the build is done and vitest runs beside it on three threads (`--schedule phased` runs the static gates first and the e2e run alone: 10.7 minutes). An agent's run is phased: a few spec files finish in a minute, and vitest on three threads would be its longest step. A new spec joins the gate by existing; a spec or test leaves it only through the quarantine list, by name, with its reason (a unit test refuses an entry without one).
- A flaky test is a bug in the test or the app: find the cause (shared state, a measurement taken mid-animation: `waitForStableBoundingBox`, `waitForMotionToSettle`, `expectTopmost` in `tests/e2e/helpers.ts`). Never a blanket retry, a longer global timeout or a weaker assertion. A worker keeps its database from one spec file to the next, so state a spec sets (an admin override, a provider, the user's model, a language) is put back in that spec's own cleanup (`clearAdminConfig`, `deleteProvidersWithPrefix` in `helpers.ts`).
- A spec that makes a conversation only to put things in it uses `createEmptyConversation` (no first message, so no first turn to a model the server cannot reach racing everything after it), not `createConversation`. A block that gets a poster (map, App, photos, live web) has a hidden copy of itself in `<body>` meanwhile: address it as `liveBlock(page, testId)`, not `page.getByTestId(testId)`. Both are held by `tests/integration/e2e-conventions.test.ts`, which names the file and the fix.
- Only one e2e run per worktree at a time (they share the databases and `build/`); a second one is refused with the holder's process id.

Playwright note:
- E2E runs set `PLAYWRIGHT_TEST=1` and `HOME_SUMMARY_CACHE_TTL_MS=0` on every server.
- In that mode, [`src/routes/api/conversations/[id]/title/+server.ts`](./src/routes/api/conversations/[id]/title/+server.ts) short-circuits and returns `title: null` so browser tests do not depend on a live title-generator service.
- Each server's log is `data/e2e-servers/slot-N.log`, every line with the seconds since that server started: a failing spec's server-side story is there. `PLAYWRIGHT_REUSE_EXISTING_SERVER=true` uses a server already listening on a slot's port (its database is reset in place); without it a busy port is an error. A SIGTERM or SIGHUP to the runner stops its servers and frees the run lock.
- The spec's own process seeds rows through the app's services into the file its server also writes, so both load `tests/e2e/sqlite-immediate.cjs` (transactions take their write lock at BEGIN): a deferred read-then-write transaction that meets the other process's commit fails at once with "database is locked", and the busy timeout does not help (one whole-suite run in ten).
- A spec that matches a request for a lazily loaded module by its source path (`vite dev` serves `/src/lib/...`) must ask `moduleUrlPattern` in `tests/e2e/build-assets.ts`: the build serves hashed chunks, which its manifest names.

Run these too when relevant:

- deployment/config/docs changes:
  - `npm run db:prepare`
  - keep `scripts/deploy.sh` and `npm start` aligned with the current DB migration story; deploys through that script should always run the idempotent `db:prepare` step before serving new code, and the production start command must not skip pending migrations
  - verify [`src/routes/api/health/+server.ts`](./src/routes/api/health/+server.ts) still matches docs and deploy expectations
- knowledge upload or extraction changes:
  - verify upload size expectations remain aligned with [README.md](./README.md) and deployment docs

## What Not To Reintroduce

- No new top-level `src/lib/server/services/*.ts` public boundary just because one file is getting large.
- No parallel memory subsystem beside `task-state.ts` (continuity) and the Memory Profile / Memory Judge / Consolidation stack (profile memory).
- No duplicated route-specific chat execution logic.
- No new raw `sessionStorage` protocol outside `conversation-session.ts`.
- No direct env reads in override-aware runtime services.
- No general runtime migrations in app bootstrap. If production safety ever requires a bounded additive compatibility shim, keep it isolated in `src/lib/server/db/compat.ts`, document it in the README, and continue treating `npm run db:prepare` as the real migration path.
- No duplicate DB repository wrappers. (Per-table wrappers stay forbidden. ONE query-execution
  seam is permitted under [ADR-0059](docs/adr/0059-db-execution-seam.md) — owning *how* a query
  runs, not *what* is queried.)
- No stores that also become API clients.
- No monolithic catch-all service file that mixes unrelated concerns again.
- No revival of deleted legacy files just because they reappear as untracked leftovers after merges or agentic runs; verify git history before restoring anything outside the tracked graph.
- No new hand-crafted inline `<svg>` icon elements. All UI icons must come from `@lucide/svelte` (see Visual System rules).

## Doc Map

- [README.md](./README.md)
  - public setup, deployment, stack, env vars, operational caveats
- [AGENTS.md](./AGENTS.md)
  - canonical engineering boundaries and placement rules
- Supplemental references
  - [deploy/README.md](./deploy/README.md)

If a supplemental doc conflicts with this file or the README, update the supplemental doc rather than copying the stale pattern back into the codebase.
