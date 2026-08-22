# Chat Experience Elevation — Design & Orchestration Plan

**Date:** 2026-08-22
**Owner:** AlfyAI
**Orchestrator:** Claude (guides sub-agents; does not hand-write feature code except where noted)
**Execution model:** Subagent-Driven Development (SDD) + Test-Driven Development (TDD), per-tier adversarial review, then commit → push → deploy to production (`ai.alfydesign.com`) via `alfydesign` ssh.

---

## 1. Goals

Elevate the Normal Chat experience along three axes, while deepening the code (turning shallow modules into deep, testable, AI-navigable ones):

1. **Correct the just-shipped `research_web` open-dropdown** (Tier 0 — fixes a live regression).
2. **Deliver the two owner ideas** — LLM-summarized jump-rail entries, and richer markdown block rendering (Tier A).
3. **Deepen the chat subsystem** — extract the god-components' domain logic into pure, tested seams (Tier B).
4. **Polish + close a privacy gap** (Tier C).

Non-negotiables inherited from the codebase:
- Durable per-turn state rides `messages.metadataJson` **additively** (same paved road as `thoughtSteps`, `depthMetadata`; projected by `projectMessageMetadata` in `messages.ts`, ADR-0022). No migrations for new metadata fields.
- New post-turn side effects enter through `chat-turn/finalize.ts` / `runPostTurnTasks` (ADR-0015).
- Honesty discipline: any LLM-derived surface degrades to a deterministic, coarser-but-never-wrong fallback (ADR-0056 pattern).
- The pure module is the test surface ("the interface is the test surface").

---

## 2. Execution model (how the orchestration runs)

For **each task**:
1. Orchestrator writes a self-contained task brief (goal, files, interface/seam, TDD test list, done-criteria) from this plan.
2. A **TDD implementation sub-agent** executes it test-first (red → green → refactor). It must not weaken existing tests to pass.
3. Orchestrator runs the gate: `npx vitest run <touched tests>`, `npm run check` (svelte-check — must be clean on touched files), `npx @biomejs/biome check` on touched files.

**MANDATORY interactive browser verification for ANYTHING visual (owner rule).** A visual task is not "ready" until it has been *driven* in the local dev server — not merely unit-tested. That means: start the dev server (`preview_start name:dev`, port 4173), seed the fixtures (`npm run seed:mock` + `scripts/ensure-visual-test-user.ts`, login `visual-test@local` / `test1234`), then actually **click, hover, open/close, resize, and inspect the rendered result** for the specific behavior the task changed (e.g. hover shows the excerpt un-clipped; the tick doesn't move on toggle; the accordion expands; a mermaid diagram renders instead of a code block). Structural unit tests are necessary but NOT sufficient. Every visual task's done-criteria include a browser-driven check.

For **each tier** (after all its tasks are green):
4. Dispatch **parallel review sub-agents**:
   - a **spec-conformance reviewer** (via the `code-review` skill lens: does the code match this plan's spec for the tier?),
   - one or more **adversarial bug-finders** (correctness, edge cases, honesty/privacy, regressions), each prompted to *refute* the implementation.
5. Orchestrator collects findings, keeps only verified ones, dispatches **fix sub-agents**, re-runs the gate.
6. **Interactive browser verification** of every user-visible change in the tier (per the owner rule above) — driven, not just asserted.
7. **Commit + push `main`** for the tier (keeps a clean per-tier history). **No production deploy yet.**

**Deploy cadence (O-1 — RESOLVED): ONE deploy at the very end.** All tiers accumulate on `main` (committed + pushed per tier for history), but production is deployed **once**, after the final tier passes review + browser verification: `scp scripts/deploy.sh alfydesign:/tmp/deploy-prod-atomic.sh && ssh alfydesign 'cd .../langflow-chat && DEPLOY_BRANCH=main /tmp/deploy-prod-atomic.sh'`, then confirm the health check passes. (Prod stays on the current release until that final deploy.)

---

## 3. Tier 0 — `research_web` open-dropdown corrections

All in `src/lib/components/chat/ThinkingBlock.svelte` (+ its test). These correct the design shipped in `875506fc`.

### 0.1 — Remove the web-search globe icon
- In `singleToolStackRow` / `singleToolItem`, the `research_web` (and only web-search) branch no longer renders `toolIdentityIcon` (the `Globe`). The summary text ("Searched the web · N sources") already names the tool. Keep the status **tick**. Read-page (`fetch_url`) rows: decide per O-2 (default: also drop the identity icon for symmetry, keeping only the tick).
- Done: no `[data-tool-icon="web-search"]` in a research_web row; tick still present.

### 0.2 — Stable header line; tick vertically centered; never moves on open/close
- **Restructure:** the pill (`.tool-call-row` / `.tool-call-item`) contains only the **header line** — `[tick] [favicon-summary button + caret]` — laid out `align-items: center`, and it **stays a single line at a stable width**. The opened result list renders as a **full-width sibling panel BELOW the pill** (not wrapped inside it).
- This removes the `flex-wrap`/`flex-basis:100%` breakout and the `align-items: flex-start`-on-open hack. The tick sits centered on the header line and does not move when the panel opens/closes.
- Done: opening/closing the panel does not change the tick's vertical position (assert `getBoundingClientRect().top` stable across toggle in a test or via browser check).

### 0.3 — Smooth open/close animation, no width snap
- Because the results panel is now a full-width sibling, the pill's width no longer jumps. The panel animates open/closed with the app's `slideTransition` (height), matching other disclosures. No rushed width snap remains.
- Done: panel enters/leaves via `slideTransition`; pill width constant across toggle.

### 0.4 — Reinstate the per-result hover excerpt popover — fixed
- Bring back the rich hover card that showed the source **title + paragraph excerpt** (the `reason`/snippet), removed in `875506fc`. Reinstate it on each `.fetched-source-result` row, **correctly sized**: `max-width: min(360px, 90%)`, `white-space: normal`, wraps freely, no fixed height, `overflow: visible`, positioned so it never clips against the thinking-block edges (prefer below-row placement, clamp horizontally). Keep the native `title` attr as the non-hover fallback and for a11y.
- Done: hovering a result shows the full untruncated excerpt with no clipped/cut text on any side; the row's whole-line hover wash still works.

**Tier 0 tests (extend `ThinkingBlock.test.ts`):** globe absent on web rows; results render as a sibling panel (structural assertion); all sources present, no `+N`; each result exposes its excerpt on hover (popover element present with full reason text); cited-first ordering + `.is-cited` marker preserved.

---

## 4. Tier A — the trifecta (owner ideas + real seams)

Sequence: **A2 → A1 → A3.**

### A2 — Shared "local-model short-text generation" seam
- **Problem:** `title-generator.ts` and `chat-turn/turn-acknowledgment.ts` each re-implement provider setup + timeout + cost tracking (`recordControlModelUsage`, ADR-0047) + output cleanup (reasoning-leak stripping, plausibility, HU/EN parity). A1's rail summary would be a third copy.
- **Deepening move:** extract a pure/deep module `src/lib/server/services/chat-turn/short-local-text.ts` (name TBD) exposing e.g. `generateShortLocalText({ prompt, maxTokens, language, cleanup }): Promise<string | null>` built on the existing control-model seam (`sendJsonControlMessage`/model2). Cleanup helpers (`cleanTitle`-style leak-strip, plausibility, language resolution) become the module's tested core.
- **Refactor callers:** `title-generator` and `turn-acknowledgment` become thin callers (behavior-preserving). Their existing tests must stay green.
- **TDD:** unit tests for the cleanup/plausibility/language core (the new test surface); caller tests unchanged.
- Effort: **M.**

### A1 — Durable, LLM-summarized jump-rail entries
- **Problem:** `jump-rail.ts` `buildJumpRailTurns` uses `truncate(message.content, 120)` — the verbatim reply start.
- **Deepening move:**
  - New durable field `railSummary?: string` on the assistant message, persisted in `messages.metadataJson`, projected in `projectMessageMetadata` (`messages.ts`) onto `ChatMessage` (`messages-types.ts`).
  - New **post-turn side effect** in `runPostTurnTasks` (`chat-turn/finalize-steps.ts`) that calls A2's `generateShortLocalText` to produce a short headline for the assistant turn, fire-and-forget, degrading silently (never blocks or fails the turn).
  - `jump-rail.ts` gains a pure `railEntryText(message) = message.railSummary ?? truncate(message.content, 120)` — the deterministic truncation is the **honest fallback** while the summary is pending/failed. `ConversationJumpRail.svelte` reads it.
- **TDD:** pure `railEntryText` (summary present → summary; absent → truncate); projection round-trip; post-turn task calls the generator and persists (with a fake generator).
- **Load note:** one extra control-model call per assistant turn on the shared vLLM — same budget class as the thought-step classifier; must respect concurrency caps and degrade on cap-miss. → *Open decision O-3 (also summarize the user turn, or assistant only?).*
- Effort: **M.**

### A3 — Typed rich-block markdown model + renderer registry
- **Problem:** rich blocks are regex-over-rendered-HTML smeared across `markdown.ts` (`transformCalloutHtml`, `wrapMarkdownTables`, `extractFrontmatter`), `MarkdownRenderer.svelte` (`splitMarkdownBlocks`), and `CodeBlock.svelte`. Accordions/interactive-checklists/diagrams fall through to grey code blocks. Adding a block type means editing a regex *and* the component splitter (two fence grammars — see B3).
- **Deepening move:**
  - A typed block model `MarkdownBlock = code | table | callout | checklist | accordion | chart | html` produced by **one** parse/split step (folds B3 in — this replaces `splitMarkdownBlocks`, does not sit beside it).
  - A **renderer registry** (block-kind → Svelte component). New block type = one registry entry + one component.
  - Initial rich renderers (O-4 RESOLVED — diagrams included in v1): **interactive checklist** (GFM task list, tick-able), **accordion** (`<details>`/`<summary>` — already survives DOMPurify), confirmed **table** rendering, and **diagrams** — `mermaid` (flowcharts/sequence/etc.), `chart`, and `csv` fences rendered as real visuals instead of grey code blocks. Diagrams add sanitizer + render surface: pick a rendering approach that stays inside the CSP/no-external-network posture (bundle the renderer, no CDN), and treat every new allowed tag as an explicit allowlist entry with its own test. Mermaid rendering can be heavy — lazy-load/def­er so it never blocks first paint of an answer.
  - **Prompt coupling (required):** the Normal Chat system prompt must teach the model the supported block syntax, or it will keep code-dumping. This is part of A3, not optional. Locate + extend the answer-formatting guidance in the prompt builder.
  - Security: widening rendered blocks must keep the DOMPurify allowlist (`html-sanitizer.ts`) tight; `<details>`/checkbox already allowed — audit any new tags.
- **TDD:** block-model parser (fixture markdown → typed blocks), registry dispatch, sanitizer allowlist tests, checklist/accordion render tests, a prompt-contains-syntax assertion.
- Effort: **M–L**, incremental.

---

## 5. Tier B — structural deepening

### B1 — Extract tool-evidence presentation out of `ThinkingBlock.svelte`
- Move the component-local domain logic (`extractHostname`/`getFaviconUrl`, `getFetchedSources`/`dedupeSourcesByUrl`/`orderCitedFirst`/`fetchedSourceSummary`/`citedCount`, `getAgendaCandidates`/`getPhotoCandidates`/`immichThumbnailUrl`, `formatToolCall`/`getToolTitle`) into a pure `src/lib/utils/tool-evidence-presentation.ts` returning view-models. `ThinkingBlock` renders them. Mirrors the existing `reasoning-spine.ts`/`thought-step-anchor.ts` extractions. Sequenced after Tier 0's restructure.
- **TDD:** unit tests for the extracted pure functions (previously only reachable via the 2k-line component test). Effort **M.**

### B2 — Shared activity/deliberation/thought-step presentation module
- One pure `src/lib/utils/activity-presentation.ts` owning `ResponseActivityEntry`/deliberation-status → `{icon, passIndex, labelKey, kind-guard}`. `ThinkingBlock` and `MessageBubble` both consume it, replacing their independent, drift-prone copies (`isDeliberationStatusSegment`/`getDeliberationStatusIconType` vs `isDeliberationActivityEntry`/`deliberationIconType`, etc.).
- **TDD:** unit tests for the classification/label mapping. Effort **M.**

### B3 — Reconcile the two markdown fence parsers
- **Folded into A3.** Scope A3 so its single parse step replaces `MarkdownRenderer.svelte`'s `splitMarkdownBlocks`; verify `markdown.ts` `renderer.code` and the component no longer double-parse fences. Listed here so it is explicitly *closed*, not left beside A3. Effort **S–M (subsumed).**

### B4 — Extract tooltip-placement geometry from `MarkdownRenderer.svelte`
- Move `getTooltipBoundary`/`updateSourceLinkTooltipPosition`/`clamp`/placement math (~180 lines) into a pure `computeTooltipPlacement(linkRect, tooltipRect, boundary)`; unit-test the geometry. Effort **S.**

---

## 6. Tier C — UX polish + privacy

- **C1 — Favicon privacy fix (CONFIRMED).** `markdown.ts` `sourceFaviconUrl` → route through the same-origin `/api/favicon?domain=<host>` proxy (strip `www.`), mirroring `ThinkingBlock`/`MessageEvidenceDetails` (ADR-0043). Removes the Google leak of cited domains. Small, high-value. **TDD:** `sourceFaviconUrl` returns a `/api/favicon` URL, never `google.com`.
- **C2 — Code-block collapse.** `CodeBlock.svelte`: auto-collapse beyond N lines and/or a collapse-all control, to cut scroll fatigue on long code answers. → *Open decision O-5 (threshold / control shape).*
- **C3 — Streaming word-animation cost.** `MarkdownRenderer.svelte` wraps each new word in a `.word-new` span on a 40ms throttle → DOM churn on long fast answers. Investigate + mitigate (batch, cap, or disable past a length) — measure first. Effort **S–M.**
- **C4 — Image loading skeleton.** Add a loading skeleton for slow (not broken) embedded images to avoid layout-shift flash. Broken-image handling already graceful.
- **C5 — Mobile jump-rail affordance.** ADR-0043 punted the rail on phones; add a compact "jump to turn" affordance for mobile. → *Open decision O-6 (in scope now, or defer?).*

---

## 7. Decisions (RESOLVED with the owner)

- **O-1 Deploy cadence:** ✅ **One deploy at the very end** (commit + push per tier for history; single production deploy after all tiers pass).
- **O-2 `fetch_url` rows:** ✅ Also drop the identity (`Link`) icon on read-page rows (symmetry with the web-search globe removal).
- **O-3 Jump-rail summary scope:** ✅ Assistant turns only.
- **O-4 A3 v1 block types:** ✅ Checklist + accordion + table **+ diagrams** (mermaid/chart/csv) in v1.
- **O-5 Code-block collapse:** ✅ Auto-collapse code blocks beyond ~30 lines + an expand/collapse control.
- **O-6 Mobile jump-rail (C5):** ✅ In scope now.
- **O-7 Tier 0 routing:** ✅ Run Tier 0 through the full SDD + TDD + review pipeline like every other tier.
- **Owner rule:** anything visual must be **interactively browser-tested** on the local dev server before it is called ready (see §2).

---

## 8. Risks & mitigations

- **Shared vLLM load (A1):** one more control-model call per turn. Mitigate with the existing concurrency cap + silent degrade; measure `usage_events` after deploy.
- **Prompt/renderer drift (A3):** rendering support without prompt teaching = no behavior change. Ship both together; add the prompt-syntax assertion test.
- **God-component refactors (B1/B2) touching live rails:** guard with the existing large component tests + the per-tier adversarial review; deploy behind the seeded browser check.
- **Sanitizer widening (A3):** every new allowed tag is a potential XSS surface — explicit allowlist tests, no wildcard.
- **Regression on the just-shipped rail:** Tier 0 has the highest blast radius on a live surface → it ships first, with browser verification.

---

## 9. Tier sequence summary

`Tier 0 (display fixes)` → `A2` → `A1` → `A3 (incl. B3, + diagrams)` → `B1` → `B2` → `B4` → `Tier D (map/route tool — ORS, see §10)` → `C1` → `C2..C5 (incl. mobile jump-rail)`.

Each tier: TDD implement → gate (vitest + svelte-check + biome) → adversarial review sub-agents → fix → **interactive** browser-verify → commit + push `main`. Production is deployed **once at the end**, after the final tier, with a health check.

## 10. Tier D — Map / route-calculation tool

Gives the model a tool to reason about real-world geography: geocoding, routes (drive/walk/bike/transit) with distance + ETA, distance/ETA matrices, and reachability (isochrones).

### Provider decision (from research; O-8 RESOLVED)
- **OpenRouteService (ORS), self-hosted from the start** — one service covers directions **+ matrix + geocoding + isochrones** on OpenStreetMap data, entirely on-box. Nothing leaves the server. **Ops step (orchestrator does this on the prod box during Tier D):** via `ssh alfydesign` (or `alfyroot` for privileged bits), stand up an ORS Docker container under the `alfydesign` user's **opt folder** (`/home/alfydesign/opt/openrouteservice`), built from an OSM extract (start with a regional extract, e.g. the relevant country, not planet — RAM/disk sane), and point the app at it via config (`ORS_BASE_URL` → the local container). No hosted-tier phase.
- **Commercial APIs (Google / HERE) are opt-in, consented fallback only — never the default.** Rationale (verified Aug 2026): Google's ToS **prohibits using Content to train ML or feed a non-Google service** (a direct concern when routes feed the LLM) + a 30-day lat/lng cache cap; **Mapbox is a non-starter** (geocoding responses may only be used "in conjunction with a Mapbox map"). All three send the user's coordinates off-box. **Never send OwnTracks coordinates to a third party by default.**
- **Adapter seam:** `RoutingProvider { geocode, route, matrix, isochrone }`, provider chosen by config — the same swap pattern the web-search mode switch already uses (ORS ↔ Valhalla+Photon ↔ Google, config-only).

### Integration point
- New tool file `src/lib/server/services/normal-chat-tools/routing.ts` (tool name TBD, e.g. `map_route`), registered in `normal-chat-tools/index.ts` alongside `research-web.ts` / `fetch-url.ts` / `location.ts`. Same OpenAI-compatible function-tool shape.
- **Independent of OwnTracks (owner decision).** The routing tool does NOT read the user's location. It takes explicit coordinates or place-name strings only. If the model needs the user's current position, it calls the existing `location.ts` tool *separately* and passes the coordinates into `route`/`isochrone` — the two tools **compose via distinct tool calls**, they are not coupled. This keeps routing a general geography tool, not a personal-location one.
- Talks only to the on-box ORS container (config `ORS_BASE_URL`); nothing leaves the server.

### Tool schema (v1)
```
geocode({ query, near?, limit? })                 → { results: [{ name, lat, lng, type, confidence }] }
route({ origin, destination, waypoints?, mode })  → { distance_m, duration_s, legs:[{distance_m,duration_s,steps?}], polyline? }
matrix({ origins[], destinations[], mode })       → { durations_s[][], distances_m[][] }
isochrone({ origin, mode, ranges_s[] })           → { polygons:[{ range_s, geojson }] }
```
`origin`/`destination` accept `{lat,lng}` **or** a place-name string (auto-geocoded). `mode ∈ drive|walk|bike|transit`. No implicit "current location" — the caller passes coordinates (optionally sourced from a separate `location` tool call).

### v1 scope + constraints
- **Output is structured/textual** — the model narrates the route (distance, ETA, turn summary) in markdown. **No interactive map widget in v1** (the app runs a strict CSP / no external tiles; an inline static-map or polyline render is a *separate, later, visual* add). So Tier D is **mostly non-visual** — but if any map/polyline rendering is added, it falls under the interactive-browser-test rule.
- **OSM attribution required:** user-facing routing output must carry **"© OpenStreetMap contributors."** (ODbL's share-alike binds derivative *databases*, not individual answers, so normal tool output is fine.)
- **Ops note (owner action):** self-hosting ORS is a Docker + OSM-extract step on the box — an infra task, done after the code ships against the hosted tier. Code delivery is **not** blocked on the container (base URL is config).

### TDD
- Provider adapter with a **fake `RoutingProvider`** (no network): schema validation, `route`/`geocode`/`matrix`/`isochrone` mapping, string-place auto-geocode, attribution present in output, and the **degrade path** (provider down → tool returns a clear "routing unavailable" result, matching the `ln`-unavailable pattern in `research-web.ts`, never a fabricated answer).
- Manual end-to-end sanity check against the on-box ORS container before calling it ready.

Effort: **M–L** (+ the one-time ORS self-host ops step on the box). **O-8 RESOLVED:** self-hosted ORS on `alfyws`, no hosted phase; routing tool independent of OwnTracks.
