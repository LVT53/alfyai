# Wave 3 adversarial review — Slice D (Project Instructions + the project page)

**Date:** 2026-09-24. **Reviewer:** one, in its own worktree, not the implementer.
**Branch under review:** `feat/workspaces-d` (seven commits, 49 files, +4 554 / −1 909).
**Review branch:** `feat/workspaces-d-review`, seven commits, merged as `3e2d6252`.

## The defect that justified the wave: a draft that followed the wrong composer

A draft typed on one project's page could be written into a **different project**. `/projects/[projectId]` is a
single route, so the sidebar reuses `HomeSurface`; navigating from the Vienna page to the Lisbon page while the
first conversation-creation POST was still in flight meant the late response won. `HomeSurface`'s guard handed the
stale conversation id back, `MessageInput.ensureDraftConversationId` adopted whatever `ensureConversation()`
resolved with, and `handleDraftChange` re-adopted that id and rewrote `landing-draft-conversation-id`. Order,
proved by instrumented console: the scope effect fires → the late `.then` correctly refuses to adopt → **the draft
emission still carries the first project's id and re-attaches it.**

The first fix closed only the settled half. The shipped fix (`21156115`) delegates to
`createPreparedConversationForScope`, which captures `{epoch, scope}` and, on resolution, deletes the stray
conversation (only when no pending message exists) and answers for the scope the composer is actually on; the
promise field is cleared by identity and `preparedConversationEpoch` is bumped by the scope effect and by "New
chat", which had the same late-adoption hazard.

**Evidence:** RED before the fix, GREEN after (`project-page.spec.ts` 15/15), and a mutation test — reverting the
fix to return the stale id reproduced the same RED, restoring it went GREEN. The test also asserts the abandoned
conversation leaves no row in the project it was wrongly created in.

A second navigation defect was fixed alongside it: the project page did not re-seed when a client-side navigation
swapped the project under it (`b128027a`).

## Other fixes

- `17dcebad` — the reply's instruction token now draws the project's **name**, not a bare icon.
- `c1314b21` — a control test proving `stripDeprecatedPromptSections` really would delete the paragraphs the
  protection tests claim it spares. A protection test that passes without protection is worthless; this is the
  non-vacuity proof, and a mutation run (replacing the stripper's alternatives with never-matching literals) failed
  the control while the protections still passed.
- `966e2c57` — import sorting to keep the lint gate clean.
- `58a252bc` — a permanent phone-layout test holding the page to the mockup's own claims (no sideways scroll, the
  greeting's computed serif/colour equal to the home greeting, ≥44px composer targets); mutating the greeting to
  sans-serif makes it fail, so it has teeth.

## Cleared, with evidence

| Target | Verdict |
|---|---|
| Precedence message → project → personal → memory/style | **Pass.** Order in `buildOutboundSystemPrompt`: base → Runtime Guidance → Response Style, then the stripper, then `Your Instructions`, then `Project Instructions` **last**. The framings name the order explicitly, and it is unit-covered for project-only, personal-only, both, move-in/move-out, shallow and incognito. |
| Ownership / leakage | **Pass.** Text leaves only through `getProjectPageData`, owner-scoped. `toProject` and `listRecentlyActiveProjects` expose `hasInstructions` only — verified across the list endpoint, project-page loader, sidebar/layout payload, conversation-detail payload, archive export and the Info popover; a log sweep found no instruction text. Another user's project id redirects home (e2e). |
| The extraction changed no behaviour | **Pass on covered paths** — the landing/chat/incognito/home specs pass unmodified. Stated as behavioural equivalence on covered paths, not a line-by-line proof of uncovered ones. |
| Instruction text cannot delete or reshape the prompt | **Pass, non-vacuity proven** (see above). |
| Quiet line ships the instructions half only | **Pass.** The three Files i18n keys are pre-staged exactly as the slice mandates and referenced by no code — no Slice E behaviour started early. |
| `listRecentlyActiveProjects` for Slice G | **Pass.** Zero-chat and draft-only projects excluded, ordered by newest chat activity, bound respected, `hasInstructions` only, counts matching the listing. G can pass `limit: 3` and render directly — no post-filtering. |
| Incognito | **Pass.** The arm stays; the armed send creates a `projectId` + `memoryIncognito` chat; the project block renders on incognito turns; nothing new is learned. |
| Wave 2's open item | **Closed.** Slice C's dialog was never exercised through a real project entry point; it now is (open from the quiet line, one scope token, no switch, fill, save, reload, reopen, value intact). |

## Reported, not fixed

- `PendingConversationMessage.projectId` (`conversation-session.ts:36`) is write-only — stored and round-tripped,
  never read. The slice's plan mandates storing it, so it was left; the observation stands for whoever consumes it.
- `AGENTS.md:22` promises "five known cycle findings"; Fallow 2.96.0 reports **4**. Pre-existing doc/tool
  mismatch — reconcile the count or pin the tool version.
- The quiet-line chip measures 126×30 at 390×844, below the app's 44px chrome-control rule but consistent with its
  small-button scale, and the mockup asks for "one quiet line" rather than a 44px control. Left alone.
- **Doc-map drift (now resolved):** `review-wave-2.md` was absent from this branch because it was committed to
  `feat/workspaces` after the slice branch was cut. It is present in the merged branch; no action needed, recorded
  so the next reader does not think it is missing.

## Could not verify

- Staging with a real model (project instructions steering an answer, project beating contradicting personal
  instructions on a short question, an incognito chat obeying project instructions) — this brief forbids deploys.
  **The orchestrator has since run exactly these on dev with a real model; all passed** (see `progress.md`).
- A live Info popover for a real project reply; component- and unit-covered only.
- One unreproduced hypothesis, deliberately not fixed: a scope change landing while `restorePreparedConversation`
  is in flight could let the restore's failure path clear a freshly adopted conversation, orphaning it as a sidebar
  draft row. Not reachable in the covered flows.

## Gates (final tree)

`npm run check`: 0 errors / 17 pre-existing warnings. Biome: 1 pre-existing. `npm test`: **11 825 passed / 2
skipped**, 783 files — identical to baseline. `npm run build`: exit 0, 34 warning-shaped lines (the pre-existing 17
× 2). Migrations pass. Fallow: 124 issues, 4 cycles, zero new items rule-by-rule against the slice baseline.
Playwright: project-page 15/15; incognito+home-compact+conversation 43/43; chat+instructions-dialog 14/14.

## Deployed

`dev` pushed `6d59195d..3e2d6252` and deployed to `ai.dev.alfydesign`.
