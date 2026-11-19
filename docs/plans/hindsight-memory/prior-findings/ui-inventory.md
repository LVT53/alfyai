> Archived findings from /Users/lvt53/.codex/visualizations/2026/11/17/01a1ebf0-5321-7190-a198-41c2994a41ea/hindsight-ui-inventory/report.md. Associated evidence files remain in that artifact directory. New decisions and status are in ../README.md.

# Memory UI compatibility inventory — 18 November 2026

**Decision proposed: redesign around Hindsight's native strengths; do not reproduce our current Memory system inside an adapter.** The current feature inventory is mapped below. It is not an assertion that every existing UI interaction already works with Hindsight: no such integration exists. Native API probes and code review are explicitly distinguished.

## Findings that change the design

- Browsing, text search, source inspection, raw-fact correction, reversible retirement, scoped recall, background status and source/bank deletion have native primitives. Those are a sound starting point.
- Our review queue, its deadlines, protected/accepted facts, inferred expiry/renewal and general maintenance undo are application policies, not drop-in Hindsight features. Carrying them all forward would recreate much of our old system.
- The portrait is optional, not a prerequisite for automatic memory. Native auto-refresh worked, but one generated portrait invented “November 2024” from a source dated November 2026. This is a content-quality failure despite successful API completion.
- Deleting the portrait's last in-scope source did not remove its text. An explicit full refresh returned `content_preserved_no_new_facts` and left the deleted preference visible while `is_stale` became false. Clearing the model emptied current content; history/erasure still requires separate handling. Do not make a permanent summary the authority by default.
- The previous source-replacement ledger experiment is **an option, not an accepted requirement**. Durable semantic edits across all source variants would add substantial policy. First consider a simpler native curation workflow and explicit source deletion, with the limitations surfaced honestly.

## Scope and evidence

Source-based inventory covers the current Knowledge → Memory components, action routes, summary/timeline services, review/home entry point, `/remember`, settings/privacy controls, the chat memory tool and relevant admin configuration. AlfyAI checkout: `e60bb0c114c02a3063d5bf6972ddeb813cccbf6c`. Hindsight: source `9fb28dbd724dc1ce4da7cb4c49008e601db76c5f`, previously installed 1.2.1 evaluator. Current official docs were also checked; executable API/source and observed behavior take precedence when wording differs.

Tests used synthetic sources in two disposable banks, local Flash Next through its configured alias, and local embedding/reranking. No product code or production memory was changed. New tests covered native capabilities, not an integrated browser walk. Existing component tests were inspected for behavior coverage, not claimed as Hindsight tests. Previous lifecycle and six-user isolation results remain linked below; the new probes do not extend their scope to production concurrency or all endpoints.

“Not native” means no equivalent contract found in the inspected public schemas, docs and owning code. It does not mean an extension could never implement it. Burden is a qualitative design assessment, not a delivery estimate. Recommendations are proposals for the owner, not approved removals.

## Feature map

| ID | Current feature | Native fit / mismatch | Integration burden | Recommendation | Evidence status | Source |
|---|---|---|---|---|---|---|
| 01 | Memory tab, opening/retry/empty/error states | List/detail APIs; app presentation remains ours | Low | Keep; design honest loading/error states | Runtime browse; UI not integrated | UI1 |
| 02 | Four personal categories + category counts | No matching native four-category taxonomy; native types mean something else | Medium if exact parity | Prefer search and simpler grouping; do not add a classifier solely for parity | Source/API review | UI2 |
| 03 | Text filter, clear filter, category chips, five-row expansion | Substring listing and pagination are native; chips/expansion are frontend choices | Low except category assignment | Keep useful search; rethink exact grouping | Runtime substring/document/date filters | UI2 |
| 04 | Active total count | Native list totals count stored units, including separate raw and derived representations | Low | Define what a displayed memory is before exposing totals | Runtime list showed both representations | UI2 |
| 05 | Stated versus inferred dots + dated source line | Fact types world/experience/observation are not stated/inferred certainty | Medium–High for equivalent classification | Use provenance wording; do not relabel native types as certainty | Source/API review | UI3 |
| 06 | Global/project/conversation/document scope labels | Tags, documents and banks provide scoping primitives | Low–Medium | Keep scope where meaningful; enforce it in ingestion, consolidation and retrieval | Runtime strict project tag excluded global source | UI3 |
| 07 | Expiry badge on each fact | Occurred/mentioned dates are native; an enforced expiresAt/auto-renew policy was not found | High for parity | Drop automatic expiry badges unless there is a concrete need beyond time-aware recall | Schema/source review; not TTL-tested | UI3 |
| 08 | Detail dialog, statement, why remembered, expandable sources | Fact detail, source documents, observation source IDs and history are native; exact why prose differs | Low | Keep evidence; derive explanation from actual provenance | Runtime detail/source/history | UI4 |
| 09 | Edit a remembered statement | Native PATCH edits raw facts and rebuilds derived observations; observations cannot be directly edited | Medium if editing summaries/derived items | Redesign action around the underlying fact/source; explicitly flag replay limitation | Runtime raw curation prior bench; observation PATCH 400 now | UI4 |
| 10 | Remove → Forget (suppression, record kept) | Native invalidation/restoration is close; source chunks and later reprocessing remain caveats | Low for native retirement; High for permanent semantic suppression | Use one precise remove/retire meaning; do not promise permanent forgetting from invalidation | Runtime invalidate/restore; prior source/replay failure | UI1 |
| 11 | Remove → Retire (no longer current, retained history) | Native invalidation is a close match; no need for a parallel retired-state machine | Low | Merge with overlapping suppression control if we accept native semantics | Runtime invalidate/restore | UI1 |
| 12 | Remove → Delete permanently | Native source/bank deletion exists; exact one-fact erasure across sources, summaries and history needs more | High for current broad promise | Decide deletion granularity explicitly; source deletion is simpler but may remove unrelated facts | Runtime document/bank deletion; prior replay restoration | UI1 |
| 13 | Edit dialog Save/Cancel/Delete, pending/error recovery | Native mutations exist; app action contracts and conflicts differ | Low–Medium | Keep familiar controls only for genuinely supported targets | Source review; native mutations tested | UI4 |
| 14 | Persona portrait text, timestamp, built-from count | Native mental model can generate a saved portrait, with evidence and refresh metadata | Low–Medium, optional | Optional read-only overview; quality and deletion caveats must be visible in decision | Runtime creation; unsupported date appeared in one auto summary | UI5 |
| 15 | Edit entire persona summary | Current app adds new sentence facts; native mental-model PATCH exposes configuration, not free-form content replacement | High for old behavior | Drop summary editing; correct evidence or add an explicit note instead | Native PATCH name changed but content field ignored | UI5 |
| 16 | Portrait automatic refresh / pending state | Native after-consolidation refresh and throttling exist; refresh after deleting last in-scope source preserved old text | Medium cleanup if retained | Prefer no portrait initially, or accept explicit summary invalidation/removal on deletion | Runtime two automatic refreshes + deletion/full-refresh repro | UI5 |
| 17 | Needs review cards: reasons, max three, overflow | No matching end-user candidate/review queue in inspected public API | High | Do not rebuild by default; decide if a review inbox earns its cost | Source/API review | UI1 |
| 18 | Accept / edit / reject review candidate | No equivalent approval state machine for profile candidates | High | Replace routine review with occasional clarification when useful, or explicitly fund a custom gate | Source/API review | UI1 |
| 19 | Accepted/manual facts protected from all automatic rewrite | Native curation records edits but reprocessing resets them; no equivalent immutable endorsement guarantee found | High | Do not promise protected facts without deciding on extra authority; native directives are not immutable profile facts | Prior replay test + source review | SR1 |
| 20 | Review candidate expires in N days | No native review queue or its expiry policy | High | Drop with review inbox unless separately justified | Source/API review | UI1 |
| 21 | Home notice: review count, open Memory anchor, dismiss | App UI tied to custom queue | Low UI, High queue dependency | Remove if queue removed; retain only useful failure/status notices | Current home component inspected | UI6 |
| 22 | Processing pill: reasons, pending count, detail tooltip | Native operation status/progress/retry API; operation names differ | Low | Keep simple updating/failed state; adapt native statuses | Runtime async operations; current page has no dedicated memory poll loop | UI1 |
| 23 | While you were away timeline of nightly changes | Native document/observation/model history and operations exist, but not identical nightly reports | Low–Medium if read-only | Use lightweight activity/history if needed; avoid nightly narrative reconstruction | Runtime source/observation/model histories | UI7 |
| 24 | Undo each merge/supersede/expiry/renewal action | Native invalidation restore is narrower; no equivalent consolidation inverse transaction found | High | Drop general maintenance undo; support only explicitly reversible native actions | Source/API review | UI7 |
| 25 | Memory settings and clear-memory links | Navigation is app-owned | Low | Keep discoverable settings and removal entry points | Current UI source inspected | UI8 |
| 26 | Memory on/off; off notice but existing memories remain viewable | AlfyAI must gate both retain and recall; this is not a Hindsight user-preference switch | Low necessary integration | Keep; test queued work, privacy transitions and re-enable policy before release | Existing control source/tests inspected; no new adapter test | SR2 |
| 27 | Incognito: no learning and no memory/project injection | Application gate; existing one-way empty-conversation rule is app-owned | Low necessary integration | Keep privacy contract; never treat a retrieval tag as incognito | Current control/route source inspected; adapter unbuilt | SR2 |
| 28 | /remember explicit note | Native retain can save an explicit source; exact text/fact identity and protected status differ | Low for source capture; High for immutable fact guarantee | Keep explicit note as a source; rethink automatic protection promises | Native retain tested; composer behavior source-reviewed | UI9 |
| 29 | Automatic background learning and explicit remember intent | Native retain/consolidate replaces engine; selecting eligible user turns and delivery stays app-owned | Low–Medium necessary integration | Keep automatic behavior with stable source IDs and honest completed/failed states | Prior synthetic benchmark + async retain now | SR1 |
| 30 | Assumptions need confirmation, without constant questioning | Missions can discourage unsupported personal claims; no proven hard admission/confirmation gate | High for deterministic guarantee | Preserve product intent; do not silently auto-approve assumptions or claim prompt configuration guarantees it | Prior attribution probes; no hard policy proof | SR1 |
| 31 | Persona injected into chat plus memory_context persona lookup | Native recall/reflect available; the summary shown is not automatically what our chat model reads | Medium normal integration | Use a bounded native retrieval contract; remove misleading every-reply portrait copy unless true | Prior recall/reflect bench; app seam inspected | SR3 |
| 32 | Project/history lookup and attachment evidence in memory_context | These also serve chat/folder/task continuity, beyond profile memory | Separate existing subsystem | Keep out of this replacement unless separately reviewed; do not scrap all memory-named APIs wholesale | Current tool schema inspected | SR3 |
| 33 | Clear Memory and Knowledge while preserving chats | Native bank deletion removes bank contents; replay prevention and knowledge/artifact deletion remain app-owned | Medium essential privacy integration | Keep; separate scopes in new UX if useful; do not promise reset before all paths complete | Native bank delete tested; app lifecycle inspected; concurrent reset untested | SR4 |
| 34 | Clear workspace / erase account / export account data | Must include external memory store; native bank deletion/export primitives do not wire themselves into app lifecycle | Medium essential integration | Keep; extend lifecycle/export rather than build a second memory authority | Bank delete runtime; export and race integration not tested | SR4 |
| 35 | Admin judge/consolidation model, dry-run, timing and maintenance controls | Native model/mission/worker configuration exists with different semantics | High if mirroring old controls | Retire old-engine controls; expose only useful supported settings | Registry/maintenance endpoint source review | SR5 |
| 36 | EN/HU labels, accessibility, keyboard/focus, mobile layout and guide links | Frontend responsibilities, not Hindsight capabilities | Low–Medium ordinary UI work | Keep quality requirements; verify after design is implemented | Existing component tests/source inspected, not rerun against a new UI | UI1 |
| 37 | Version conflict handling / retry if memory changed meanwhile | Current projection revision is app-specific; native edits do not expose the same expectedProjectionRevision contract | Medium if same guarantee required | Decide stale-edit behavior; avoid recreating global projection revision solely for compatibility | Action route and native request schema inspected | SR6 |

## Native API checks performed now

`results.json` and `auto-results.json` preserve each request label, path, method, response, status and duration. `verification.json` records 16 checks of the observations, including expected limitations; it is not a 16/16 product-quality score.

- List, substring search, document filter and mention-date filter returned the intended data.
- Document source, source history, fact detail and observation history returned successfully.
- Editing a derived observation returned 400; raw-fact invalidation and restoration worked.
- Strict project-tag recall returned project facts and evidence, excluding the unrelated global source.
- Mental-model creation worked. After-consolidation refresh picked up the first preference and later changed it to espresso. History returned previous generated content.
- A summary `content`-only PATCH returned 404; a supported name change plus `content` returned 200, changed the name and left text unchanged. The request schema has no free-form content-update field. This is not a working summary editor.
- Source deletion followed by full summary refresh preserved deleted information; explicit model clear emptied current content.
- Deleting each disposable bank made its memory and mental-model reads return 404. This is not proof of secure erasure from backups or an in-flight ingestion race.

## Three current UI promises worth discarding, not porting

**“Edit summary”** currently splits the submitted text into sentences, creates additional user-authored facts, then regenerates the summary. Removing a sentence from the editor does not itself remove its old underlying fact. A new design should not preserve this misleading contract.

**“Delete permanently”** currently routes to an item status of `deleted`; that action is not a physical purge of the original chat, all derived records or backups. The label is stronger than the implementation. The new UI needs one understandable removal contract with a precise scope.

**“You can still find it later” / “Retire stays in the activity log”** accompanies separate Forget/Retire controls, but the inspected Memory page browses active items and nightly reports, not a dedicated archive of all manually suppressed/retired items. Native restore could enable a clearer archive later, without keeping two nearly identical removal choices.

## Suggested decision boundary

### Keep as essential, ordinary integration

User/tenant authentication and ownership; memory on/off and incognito read/write gates; stable source IDs and delivery acknowledgements; source access checks; per-user reset/account deletion/export; bounded model context; English/Hungarian UI and accessibility. These are necessary application boundaries, not reasons to recreate a memory engine. Reset must not let queued or old messages repopulate a deleted bank.

### Prefer native behavior and simplify the product

Browse remembered information; inspect its evidence; correct an underlying extracted fact; record a new explicit statement; retire/restore where the native meaning is appropriate; delete an identified source or the whole bank; show useful operation state. Native curation is best considered alongside stable append-only source ingestion and avoiding uncurated raw chunks in normal answer context. That pairing is a **design candidate**, not an accuracy-equivalent replacement for the earlier source-grounded benchmark. It needs its own answer-quality check before adoption.

### Do not rebuild without an explicit product decision

Fixed categories with a bespoke classifier; hard expiry/renewal; an assumptions-review inbox; permanent endorsement locks; a second editable persona authority; comprehensive consolidation undo; a semantic suppression/redaction ledger that finds every paraphrase. These are the highest risks of rebuilding the system we are trying to leave behind.

Rejecting the review inbox does not authorize remembering guesses as facts. The user's requirement still stands: explicit statements can be automatic, assumptions should not become confirmed personal truth. Hindsight missions and the attribution results help but do not provide a structural confirmation guarantee. If a hard pre-storage approval gate is essential, that is an explicit integration cost and a possible reason to reconsider engine fit.

### Portrait decision

The lowest-complexity first version can omit the generated portrait and retain a searchable memory list with evidence. If a portrait is valuable, keep it read-only, treat it as derived, and define deletion/history invalidation and failure presentation explicitly. Merely calling refresh after deletion is insufficient in the reproduced empty-scope case. No visual design should promise more than that contract supports.

## Not yet verified, and why

There is no Hindsight-backed AlfyAI UI to click through. Actual end-to-end loading, forms, disabled/error states, stale edits, localization, mobile and accessibility checks belong after implementation. Native primitives do not establish those interactions automatically.

Remaining integration acceptance work includes concurrent reset versus queued ingestion, lifecycle erasure/export, source edit/retry policy, grouping of facts/observations without duplicated or contradictory “current” rows, summary deletion/history if a portrait survives, and attribution quality under the final retrieval representation. Full semantic forgetting across repeated paraphrases was not solved by the single-source ledger experiment.

No additional compatibility machinery is authorized or implemented by this inventory. The next design discussion should select which of these features we actually want, particularly the portrait, expiry, review inbox and removal granularity.

## Source map

- UI1: [KnowledgeMemoryView.svelte](</Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/src/routes/(app)/knowledge/_components/KnowledgeMemoryView.svelte>), [KnowledgeMemoryView.test.ts](</Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/src/routes/(app)/knowledge/_components/KnowledgeMemoryView.test.ts>)
- UI2: [MemoryPortraitCard.svelte](</Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/src/routes/(app)/knowledge/_components/MemoryPortraitCard.svelte>), [memory-categories.ts](</Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/src/routes/(app)/knowledge/_components/memory-categories.ts>)
- UI3: [MemoryRow.svelte](</Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/src/routes/(app)/knowledge/_components/MemoryRow.svelte>)
- UI4: [KnowledgeMemoryModal.svelte](</Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/src/routes/(app)/knowledge/_components/KnowledgeMemoryModal.svelte>)
- UI5: [PersonaSummaryCard.svelte](</Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/src/routes/(app)/knowledge/_components/PersonaSummaryCard.svelte>), [knowledge-memory-actions.ts](</Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/src/lib/server/services/knowledge-memory-actions.ts>)
- UI6: [HomeMemoryReviewNotice.svelte](</Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/src/lib/components/home/HomeMemoryReviewNotice.svelte>)
- UI7: [MemoryTimeline.svelte](</Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/src/routes/(app)/knowledge/_components/MemoryTimeline.svelte>)
- UI8: [MemoryRailCards.svelte](</Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/src/routes/(app)/knowledge/_components/MemoryRailCards.svelte>)
- UI9: [+server.ts](</Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/src/routes/api/memory/notes/+server.ts>), [MessageInput.svelte](</Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/src/lib/components/chat/MessageInput.svelte>)
- SR1: [AGENTS.md](</Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/src/lib/server/services/memory-profile/AGENTS.md>), [review.ts](</Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/src/lib/server/services/memory-profile/review.ts>), [steps.ts](</Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/src/lib/server/services/memory-consolidation/steps.ts>)
- SR2: [memory-controls.ts](</Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/src/lib/server/services/memory-controls.ts>), [+server.ts](</Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/src/routes/api/conversations/[id]/+server.ts>)
- SR3: [memory-context.ts](</Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/src/lib/server/services/normal-chat-tools/memory-context.ts>)
- SR4: [index.ts](</Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/src/lib/server/services/account-lifecycle/index.ts>), [index.ts](</Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/src/lib/server/services/account-data-archive/index.ts>)
- SR5: [admin-config-registry.ts](</Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/src/lib/config/admin-config-registry.ts>), [+server.ts](</Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/src/routes/api/admin/memory-maintenance/+server.ts>)
- SR6: [+server.ts](</Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/src/routes/api/knowledge/memory/actions/+server.ts>), [read-model.ts](</Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/src/lib/server/services/memory-profile/read-model.ts>)

Hindsight reference: [Memories and curation](https://hindsight.vectorize.io/developer/api/memories), [Mental models](https://hindsight.vectorize.io/developer/api/mental-models), plus pinned local API schema and document/operation docs. Key native source: `hindsight-api-slim/hindsight_api/api/http.py` (`MemoryItem`, `UpdateMemoryRequest`, `UpdateMentalModelRequest`). The schemas do not provide the old expiry, approval or immutable-endorsement contracts.

Prior evidence: [adoption/lifecycle report](</Users/lvt53/.codex/visualizations/2026/11/17/01a1ebf0-5321-7190-a198-41c2994a41ea/hindsight-adoption/report.md>), [larger benchmark](</Users/lvt53/.codex/visualizations/2026/11/17/01a1ebf0-5321-7190-a198-41c2994a41ea/hindsight-bench-v2/report.md>). Those source-ledger experiments are explicitly not adopted as the new architecture.
