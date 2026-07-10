# Skill Packs and Variants Implementation Slices

Status: draft local issue plan, revised after multi-agent review

This breaks ADR 0013 into independently grabbable tracer-bullet slices. The plan assumes there is no current private-skill data to migrate. Implementation still needs normal structural schema migrations for new columns/tables, Drizzle metadata, and runtime DB preparation checks.

## User Stories

- US1: As an admin, I can maintain a reusable Skill Pack whose base guidance silently updates future direct pack and variant activations.
- US2: As a user, I can create a Skill Variant from a Skill Pack by writing only my personal overlay guidance.
- US3: As a user, I can discover and activate either a Skill Pack or one of my Skill Variants through the existing skill activation flow.
- US4: As a user in a durable Skill Session, I get stable effective instructions for the current session even if the underlying Skill Pack changes later.
- US5: As an admin, I can provide an AlfyAI-native spreadsheet Skill Pack adapted from OpenAI's spreadsheet guidance without exposing Codex-specific runtime promises.
- US6: As an implementer, I can verify the plan with independent scope, bug, ambiguity, and regression review before implementation begins.

## Decisions Baked Into These Slices

- Existing enabled/published System Skills become Skill Packs unless a future slice explicitly marks a system-owned skill as a different kind.
- Existing user-owned rows, if any appear before this ships, are classified as standalone User Skills. There is no private-skill-to-variant backfill.
- Skill Variants inherit pack-owned run policy, source scope, question policy, and notes policy in v1.
- Variants store user-owned display metadata, enabled state, and overlay guidance only. They do not copy pack instructions, resources, or pack-owned policies.
- Users hiding a Skill Pack suppresses direct pack discovery only. Their own variants remain discoverable unless the pack is disabled, unpublished, or otherwise unavailable.
- Skill Pack hard deletion is not introduced in v1. Disabling or unpublishing is the supported admin unavailability path. If hard deletion is added later, it must preserve user-owned variants as unavailable overlays rather than cascade-delete them.
- Repo-managed built-in pack resources are in scope. Admin-created multi-resource editing is out of scope and should be designed separately if needed.
- The spreadsheet pack ships as XLSX tables, formulas, formatting, chart-ready helper tables, and dashboard/KPI layouts only. Native Excel chart creation is out of scope until a chart-capable XLSX runtime is implemented and tested.

## Out of Scope

- Migrating existing private skills into variants.
- Generic skill sharing, copying, duplicating, import, package install, marketplace, or plugin-style export flows.
- User-visible base-version pinning, rebasing, or update prompts.
- Variant policy overrides, including broader source access, note-writing authority, file authority, or tool authority.
- Admin-created multi-resource pack editing.
- Native Google Sheets import.
- Native Excel chart authoring in generated `.xlsx` files.
- Codex `@oai/artifact-tool`, local Markdown file links, or artifact-tool render/inspect APIs.

## Proposed Breakdown

0. **Title**: Multi-Agent Plan Readiness Audit
   **Type**: HITL
   **Blocked by**: None
   **User stories covered**: US6

1. **Title**: Skill Pack Data Model And Classification
   **Type**: AFK
   **Blocked by**: SPV-00
   **User stories covered**: US1

2. **Title**: Effective Skill Prompt Context Resolver
   **Type**: AFK
   **Blocked by**: SPV-01
   **User stories covered**: US1, US3, US4

3. **Title**: Overlay-Only Skill Variant CRUD
   **Type**: AFK
   **Blocked by**: SPV-01, SPV-02
   **User stories covered**: US2

4. **Title**: Variant-Aware Composer Discovery And Selection
   **Type**: AFK
   **Blocked by**: SPV-02, SPV-03
   **User stories covered**: US3

5. **Title**: Variant-Aware Skill Session Snapshots
   **Type**: AFK
   **Blocked by**: SPV-02, SPV-03
   **User stories covered**: US4

6. **Title**: Pack Update Propagation And Stale Selection Recovery
   **Type**: AFK
   **Blocked by**: SPV-04, SPV-05
   **User stories covered**: US1, US3, US4

7. **Title**: Repo-Managed Built-In Skill Pack Resources
   **Type**: AFK
   **Blocked by**: SPV-01, SPV-02
   **User stories covered**: US1, US5

8. **Title**: XLSX File-Production Contract Smoke
   **Type**: AFK
   **Blocked by**: SPV-07
   **User stories covered**: US5

9. **Title**: AlfyAI-Native Spreadsheet Skill Pack
   **Type**: AFK
   **Blocked by**: SPV-07, SPV-08
   **User stories covered**: US5

10. **Title**: End-To-End Regression And Localization Pass
    **Type**: AFK
    **Blocked by**: SPV-03, SPV-04, SPV-05, SPV-06, SPV-09
    **User stories covered**: US1, US2, US3, US4, US5

## Issue Drafts

### SPV-00: Multi-Agent Plan Readiness Audit

## What to build

Run an independent readiness review before implementation begins. The audit should use multiple sub-agents or reviewers from non-overlapping perspectives: product/domain scope, backend and data-model risk, frontend and UX risk, testing gaps, and spreadsheet/file-production contract risk.

This slice is not a product feature. It is a readiness gate for the implementation plan and should produce concrete amendments or explicit "no finding" statements.

## Acceptance criteria

- [ ] At least three independent reviewers assess the local slice plan from non-overlapping perspectives.
- [ ] The review checks for missing vertical slices, dependency mistakes, scope creep, hidden migrations, bugs, ambiguous policies, test gaps, and file-production contract mismatches.
- [ ] Accepted findings are folded back into the local slice plan.
- [ ] Rejected or deferred findings are recorded briefly with rationale.
- [ ] The final plan clearly states whether further user clarification is needed.

## Blocked by

None - can start immediately.

### SPV-01: Skill Pack Data Model And Classification

## What to build

Introduce Skill Pack and Skill Variant representation inside the existing app-owned Skills boundary. Existing System Skill behavior should continue, but persisted definitions and public summaries must distinguish standalone User Skills, Skill Packs, and Skill Variants so later slices can attach overlays without copying base instructions.

This slice should be demoable through service/API tests: existing system-owned skills are classified as Skill Packs, existing user-owned rows are classified as standalone User Skills, and public summaries can expose kind-aware metadata without leaking instructions.

## Acceptance criteria

- [ ] The persisted skill model can represent at least `user_skill`, `skill_pack`, and `skill_variant` without introducing a parallel skill subsystem.
- [ ] The public API shape includes an instruction-free `skillKind` or equivalent kind field for summaries, discovery results, pending-skill payloads, and client-side display.
- [ ] Existing `ownership = "system"` rows classify as Skill Packs by default.
- [ ] Existing `ownership = "user"` rows classify as standalone User Skills by default; no private-skill-to-variant data backfill is implemented.
- [ ] Skill Variant rows can reference a base Skill Pack without cascade-deleting user-owned overlays if a future hard-delete path is added.
- [ ] The schema plan includes session snapshot metadata needed by later slices: pack id/version, optional variant id/version, and an effective-instructions hash or equivalent audit token.
- [ ] Drizzle schema, SQL migration files, migration journal metadata, and runtime `prepare-db` requirements are updated and tested for empty DB and existing DB paths.
- [ ] Public serialization remains privacy-safe and does not expose full instructions through summaries.

## Blocked by

- SPV-00

### SPV-02: Effective Skill Prompt Context Resolver

## What to build

Add one server-side resolver that returns effective prompt context for any activatable Skill. Direct Skill Pack activation resolves to the current pack guidance. Skill Variant activation resolves to the current pack base plus the user's overlay guidance. Standalone User Skills continue to resolve as their own instructions.

The resolver should be variant-ready before variant CRUD is activated so a variant overlay can never accidentally be treated as standalone instructions.

## Acceptance criteria

- [ ] Prompt context, send/stream preflight, session start, active-session availability checks, and discovery validation use one effective-skill resolver rather than assembling pack/variant text in route-local code.
- [ ] Effective instructions order is deterministic: pack base first, then variant overlay.
- [ ] Pack policies are authoritative in v1. Variants cannot broaden run policy, source scope, question policy, notes policy, file authority, tool authority, or note-write authority.
- [ ] The resolver returns effective instructions, instruction-free public summary data, source ids/versions, and an availability reason.
- [ ] A later pack update changes future effective resolution for variants without editing variant rows.
- [ ] Tests cover direct pack, variant, standalone User Skill, disabled pack, unpublished pack, hidden pack, missing pack, cross-user access, and instruction leakage cases.

## Blocked by

- SPV-01

### SPV-03: Overlay-Only Skill Variant CRUD

## What to build

Allow a user to create, edit, enable, disable, and delete a Skill Variant that references an existing Skill Pack and stores only user-owned metadata plus overlay guidance. The user should not edit or copy the pack's base instructions, managed resources, or pack-owned policies through the variant editor.

This slice should be demoable from the Skills Settings Surface: a user picks an available pack, writes overlay guidance, saves a variant, edits that overlay later, and can delete the variant without mutating the underlying pack.

## Acceptance criteria

- [ ] A Skill Variant stores a pack reference, user-owned display metadata, user-owned enabled state, and overlay guidance.
- [ ] Creating a variant does not copy or pin the pack's base instructions, managed resources, or pack-owned policies.
- [ ] The editable textarea is labeled as variant overlay guidance, not generic base instructions.
- [ ] The variant editor shows read-only pack identity and pack availability.
- [ ] The variant editor handles pack picker loading, no packs available, fetch failure, selected pack unavailable, duplicate variant name, save/delete in progress, and delete confirmation states.
- [ ] Variant policy controls are hidden or read-only in v1, with copy explaining that pack policies are inherited.
- [ ] Deleting or disabling a variant does not delete, disable, or edit the underlying Skill Pack.
- [ ] API and component tests cover create, edit, delete, duplicate-name warning behavior, ownership enforcement, unavailable pack handling, and overlay-only editing.
- [ ] New labels, errors, confirmations, empty/loading states, and accessibility strings are localized in English and Hungarian.

## Blocked by

- SPV-01
- SPV-02

### SPV-04: Variant-Aware Composer Discovery And Selection

## What to build

Show Skill Packs and Skill Variants in the existing `$` skill discovery and selection flow without creating a second skill picker. User-owned variants should be discoverable as user-owned skills and rank above pack matches when match quality is equal. Direct pack activation should remain available when the pack is enabled, published, and not hidden by the user.

This slice should be demoable in chat: typing `$` can select a pack or variant, the selected Pending Skill Chip identifies the chosen skill clearly, and sending the message applies the correct effective prompt context.

## Acceptance criteria

- [ ] `$` discovery returns enabled standalone User Skills, enabled user variants, and enabled published Skill Packs with clear `skillKind` metadata.
- [ ] Public labels distinguish User Skill, Skill Pack, and Skill Variant without showing full instructions.
- [ ] Variant summaries include enough pack identity, such as pack display name, for the user to understand what is being overlaid.
- [ ] When match quality is equal, user-owned variants rank above pack matches.
- [ ] User-hidden packs are suppressed from direct pack discovery, while user-owned variants remain discoverable unless the pack is disabled, unpublished, or otherwise unavailable.
- [ ] The Pending Skill Chip and Command Suggestion Row make pack vs variant clear in visible text and accessibility labels.
- [ ] Selection still preserves surrounding message text and command-token cleanup behavior.
- [ ] Tests cover discovery ranking, instruction-free serialization, selection payload shape, keyboard selection, screen-reader labels, restored draft chips, and send preflight validation for unavailable packs or variants.
- [ ] New labels, errors, empty/loading states, active-row announcements, and accessibility strings are localized in English and Hungarian.

## Blocked by

- SPV-02
- SPV-03

### SPV-05: Variant-Aware Skill Session Snapshots

## What to build

Preserve existing durable Skill Session semantics for pack-backed skills. Starting a session from a Skill Pack or Skill Variant snapshots the effective instructions, policies, source scope, display name, source ids/versions, and effective-instructions audit token at session start. Later pack or variant edits affect future sessions, not already-running sessions unless explicitly restarted or updated.

This slice should be demoable by starting a session, editing the underlying pack or variant, and verifying the active session still uses the originally captured effective instructions while availability checks remain pack-aware.

## Acceptance criteria

- [ ] Starting a durable session from a variant snapshots current pack base plus overlay guidance.
- [ ] Session snapshot metadata records pack id/version and optional variant id/version, plus an effective-instructions hash or equivalent audit token.
- [ ] Editing a Skill Pack after session start does not mutate the active session's captured instructions.
- [ ] Editing a Skill Variant after session start does not mutate the active session's captured instructions.
- [ ] Active-session availability checks are pack-aware and variant-aware, including disabled, unpublished, missing, or otherwise unavailable packs.
- [ ] Re-selecting an already-active same skill does not bypass availability revalidation.
- [ ] Session metadata remains privacy-safe and does not expose full instructions to client surfaces that should only see summaries.
- [ ] Tests cover active session prompt context, public session serialization, restart/update behavior if present, session snapshot stability, and pack/variant unavailability.

## Blocked by

- SPV-02
- SPV-03

### SPV-06: Pack Update Propagation And Stale Selection Recovery

## What to build

Make silent admin pack updates and stale pending-skill recovery explicit across API, discovery, send preflight, and composer UX. Updating a pack should update future direct pack and variant activations. Disabling or unpublishing a pack should prevent new direct and variant activations. Hard pack deletion is out of scope for v1.

This slice should be demoable by updating a pack and seeing a variant use the new base on its next activation, then disabling the pack and seeing new activation blocked while active-session behavior remains controlled by SPV-05.

## Acceptance criteria

- [ ] Admin pack updates silently affect future direct pack activations.
- [ ] Admin pack updates silently affect future variant activations without editing variant rows.
- [ ] Disabled, unpublished, hidden, or missing packs are not offered for unavailable direct pack activations according to their availability reason.
- [ ] Variants remain user-owned when a user hides the underlying pack, but become unavailable when the pack is disabled, unpublished, or missing.
- [ ] Pending pack or variant chips are revalidated before send.
- [ ] A stale pending chip blocks send, preserves message text, marks the chip unavailable, announces the recoverable error, and offers remove/select-another behavior.
- [ ] Tests cover update propagation, stale pending selection in send and stream paths, hidden-pack behavior, orphaned variant behavior, and localized error recovery.
- [ ] New labels, errors, confirmations, empty/loading states, live-region text, and accessibility strings are localized in English and Hungarian.

## Blocked by

- SPV-04
- SPV-05

### SPV-07: Repo-Managed Built-In Skill Pack Resources

## What to build

Support repo-managed resources for built-in Skill Packs so high-quality packs can be maintained as more than one giant textarea while user variants remain overlay-only. The implementation should keep this inside the Skills boundary and expose a bounded, deterministic, policy-safe base to prompt assembly.

Admin-created multi-resource editing is not part of this slice. Admin-created packs may continue to use a primary instruction body until a separate HITL-designed resource editor exists.

## Acceptance criteria

- [ ] A repo-managed built-in Skill Pack can have managed resources without exposing those resources as user-editable variant content.
- [ ] Prompt assembly receives bounded, deterministic pack guidance and does not bulk-load irrelevant resources.
- [ ] Resource inclusion rules are observable enough for tests and future debugging.
- [ ] The admin surface distinguishes pack metadata/content management from user overlay editing and does not imply that user variants edit pack resources.
- [ ] Tests cover resource assembly, omission of irrelevant resources, privacy-safe summaries, and prompt bounds.
- [ ] New admin labels, empty states, and accessibility strings are localized in English and Hungarian.
- [ ] No admin-created multi-resource editor, marketplace, import, package-install, or plugin-style distribution behavior is introduced.

## Blocked by

- SPV-01
- SPV-02

### SPV-08: XLSX File-Production Contract Smoke

## What to build

Add a focused file-production smoke path proving that the current AlfyAI runtime can generate an `.xlsx` with JavaScript `exceljs` before the spreadsheet Skill Pack depends on it. This should test the real program-mode contract as closely as practical, not only prompt wording.

This slice should be demoable by queuing a program-mode File Production Request whose JavaScript writes one workbook to `/output`, then verifying the job stores and serves that workbook as a valid generated file.

## Acceptance criteria

- [ ] A JavaScript `exceljs` program writes `/output/workbook.xlsx` with at least two sheets, formatted headers, formulas, and `workbook.calcProperties.fullCalcOnLoad = true`.
- [ ] The worker drains the queued job successfully and links exactly one produced file to the job.
- [ ] The requested output type, produced filename extension, MIME type, and stored bytes agree.
- [ ] The `.xlsx` bytes are minimally validated as an OOXML ZIP with expected workbook entries before storage or download.
- [ ] The generated file download route serves the expected XLSX MIME type and sanitized filename.
- [ ] The preview path can at least load the workbook enough to avoid a blank or hard-failing preview.
- [ ] The program does not write scratch diagnostics or extra unrequested files to `/output`.
- [ ] Tests cover oversized or invalid XLSX output failure without storing partial files.

## Blocked by

- SPV-07

### SPV-09: AlfyAI-Native Spreadsheet Skill Pack

## What to build

Add a spreadsheet-oriented Skill Pack adapted from the OpenAI spreadsheet skill contents. The pack should preserve transferable spreadsheet quality guidance: workbook structure, formulas, source/assumption separation, visual polish, chart-ready helper tables, KPI/dashboard layouts, sandbox-local validation habits, and domain-specific conventions. It must replace Codex runtime assumptions with AlfyAI file-production instructions.

This slice should be demoable by activating the spreadsheet pack and asking for an `.xlsx`: the assistant should route creation through an AlfyAI File Production Request using the full `produce_file` contract, `sourceMode: "program"`, JavaScript `exceljs`, and final files written to `/output` for File Production Card delivery.

## Acceptance criteria

- [ ] Spreadsheet guidance uses AlfyAI file-production terminology and does not promise local Markdown links, Google Drive import, `@oai/artifact-tool`, artifact-tool render/inspect APIs, native Excel charts, `sheet.charts`, npm installs, network fetches from sandbox code, Excel/LibreOffice, browser APIs, or Python spreadsheet libraries.
- [ ] The pack instructs `.xlsx` production through `produce_file`, `sourceMode: "program"`, `language: "javascript"`, JSON-encoded `requestedOutputs`, JSON-encoded `program`, `idempotencyKey`, `requestTitle`, and `documentIntent`.
- [ ] The pack instructs programs to use `exceljs`, bounded sheet/table sizes, no scratch files in `/output`, one final requested file when `program.filename` is provided, and `workbook.xlsx.writeFile("/output/<name>.xlsx")`.
- [ ] The pack instructs `workbook.calcProperties.fullCalcOnLoad = true` when formulas are included and limits verification promises to sandbox-local assertions/reload checks, not visual QA or computed formula verification after job execution.
- [ ] For XLSX, the pack converts chart guidance into chart-ready helper tables, clear dashboard/KPI layouts, and tested static visuals only. It does not promise native Excel charts until a separate chart-capable runtime exists.
- [ ] The pack keeps useful spreadsheet quality guidance and relevant domain guidance without dumping every nested source into every prompt.
- [ ] Prompt-contract checks verify that the pack text aligns with the unified file-production guard and excludes Codex-specific runtime language.
- [ ] English and Hungarian display names/descriptions are present where built-in pack metadata is localized.

## Blocked by

- SPV-07
- SPV-08

### SPV-10: End-To-End Regression And Localization Pass

## What to build

Add focused end-to-end and regression coverage for the complete Skill Pack and Skill Variant path. This should validate creation, discovery, activation, session behavior, admin update propagation, unavailable-pack handling, spreadsheet pack file-production guidance, and localization parity.

This slice should be demoable through automated tests and a manual smoke path: create a pack-backed variant, activate it in chat, update the pack, verify future activation inherits the new base, and verify an active session stays stable.

## Acceptance criteria

- [ ] API/service tests cover pack, variant, effective resolver, migration, public serialization, cross-user access, admin privacy, and session snapshot behavior.
- [ ] Component tests cover user overlay editing states, admin pack rows, command tray rows, pending chips, long names, mobile-width layout, and chip wrapping.
- [ ] A focused e2e or integration smoke covers `$` discovery, keyboard selection, screen-reader labels, type ranking, stale pending selection, and send with a variant.
- [ ] Localization parity tests cover visible strings, `aria-label`s, active-row announcements, confirmations, empty/loading states, live-region text, and recoverable error messages.
- [ ] Spreadsheet pack tests cover file-production prompt contract and XLSX smoke assumptions from SPV-08.
- [ ] Existing composer command, skill session, Skill Note, and file-production tests continue to pass.
- [ ] No unrelated skill, note, context-source, or file-production behavior regresses.

## Blocked by

- SPV-03
- SPV-04
- SPV-05
- SPV-06
- SPV-09

## Multi-Agent Review Disposition

Accepted findings:

- Moved the multi-agent review from a late SPV-10 implementation slice to SPV-00 as a readiness gate.
- Added explicit `skillKind`/kind-aware public contracts.
- Added a concrete data-model and migration contract, including Drizzle metadata and `prepare-db` updates.
- Moved the effective resolver before variant CRUD so overlay rows cannot accidentally activate as standalone instructions.
- Made pack policies authoritative in v1 and excluded variant policy overrides.
- Added pack/variant source ids, versions, and effective-instructions audit metadata to session snapshot requirements.
- Added hidden-pack, stale-chip, orphaned-variant, and recoverable send-blocking behavior.
- Constrained managed resources to repo-managed built-in packs for v1.
- Added a separate XLSX file-production contract smoke before the spreadsheet pack.
- Tightened spreadsheet guidance around ExcelJS limits, no native charts, no artifact-tool APIs, no post-job visual QA promises, and sandbox constraints.
- Expanded localization and accessibility requirements across UI slices.

Deferred or rejected findings:

- Admin-created multi-resource pack editing: deferred to a separate HITL design because it expands schema, admin UX, and resource authoring scope.
- Variant policy overrides: deferred because they can become a source, note, file, or tool authority bug.
- Hard pack deletion: deferred; v1 should use disable/unpublish as the admin unavailability path.
- Native Excel charts: deferred until a chart-capable XLSX runtime is selected and tested.
- Private-skill data migration: rejected as unnecessary for the current product state; only structural schema migration remains.

## Review Questions

No clarification is required to make the plan internally consistent. These are the remaining optional product choices before implementation:

1. Should every existing System Skill be treated as a Skill Pack by default? Current recommendation: yes.
2. Should standalone user-created skills be labeled "User Skill" in the UI after variants ship? Current recommendation: yes, matching the glossary.
3. Should native Excel charts be a separate future slice? Current recommendation: yes, only after choosing a runtime that supports them.
