# Memory UI design study

Date: 2026-11-18. Status: **visual directions rejected; retained for exploration history only**. Follow [accepted scope boundary](scope-boundary.md) over the scope suggestions below. **Design only**. No application implementation, migration or deployment is authorized by this document.

## Recommended direction

**Quiet list**: a searchable list of remembered statements, with a focused detail screen for evidence, correction and removal. Warm AlfyAI surfaces, Nimbus Sans controls, Libre Baskerville only for the Knowledge page title, existing Memory/Documents switcher and Lucide icons. No portrait, confidence scores, dashboard metrics or maintenance chores. Ordinary users need never visit this page.

Interactive study: `/Users/lvt53/.codex/visualizations/2026/11/17/01a1ebf0-5321-7190-a198-41c2994a41ea/alfyai-memory-design.html`.

The study also compares **Open notes**, exposing sources/actions on each row (faster frequent editing, busier), and **Search first**, showing a small recent set until searched (quieter, worse for understanding the complete memory). Quiet list best serves the owner's primary concern: seeing exactly what is remembered without learning a management system.

All content is synthetic. Preview controls, variant captions, language/device switches and failure selectors belong to the study, not the product. Navigation outside Memory is context only. Open chat shows a relevant excerpt in the study; the real product must navigate to the authorized original message. All actions modify disposable browser data only.

## Screens and actions

| Screen | Visible information and actions |
|---|---|
| Browse | Current statements, context and latest explicit assertion date; search, context filters, Add a memory and Manage. Row opens detail. |
| Detail | Statement, evidence excerpt, source title/date, Correct and Remove. Earlier statements are collapsed and explicitly labelled as superseded evidence. |
| Correct | Editable statement, previous statement and explanation that this becomes the latest explicit assertion. Cancel or Save changes. |
| Remove | Exact selected statement, scope/consequence copy, Cancel, Remove and Keep part instead. |
| Keep part | Existing statement editable as plain text. Preserve ownership or unrelated clauses while removing a detail such as colour. Save remaining information. |
| Add | Explicit manual statement; no category ontology or confidence selector. The originating event is “Added by you”, not a fabricated chat source. |
| Manage | Memory on/off, incognito explanation, Clear all memories. |
| Clear | Separate confirmation with acknowledgement; chats and documents remain. Old queues/history cannot silently repopulate memory. |

Detail is a focused page within Knowledge, on desktop and mobile. Return preserves query, filter, list position and focus. This avoids cramped drawers on phones. A future implementation may use the existing route/navigation conventions rather than introducing a separate navigation subsystem.

Default ordering is newest explicit assertion first, with deterministic tie-breaking. Sample ordering in the study is editorial to exercise the scenarios. Date means latest relevant assertion/edit, **never background processing time**. Production dates include the year where ambiguous. Context chips denote actual isolation/retrieval scope, not an LLM-assigned topic: Personal and accessible project contexts. If project attribution is unavailable, show the actual personal bank scope; never infer a project boundary from a name in the text. A manual addition uses the selected scope (All requires an explicit scope choice, default Personal). Corrections retain the existing scope.

## Interaction and failure rules

- Save shows an in-progress state. Success appears only after the accepted revision is verified. Duplicate submits are disabled and retries use the same operation identity. The mockup simulates success locally.
- Failed background refresh preserves the last accepted list and offers Retry. No alarming permanent status dashboard; show status only when relevant.
- A failed correction retains the draft, states that it was not saved, and shows the previously accepted statement. No success toast or silent overwrite.
- A stale editor retains the draft and blocks Save until the latest accepted statement has been reviewed. Production review shows latest versus draft together; subsequent Save is a new explicit assertion against that revision, with another concurrency check.
- Removal revokes admission promptly. If cleanup fails after revocation, show that the memory is excluded while removal finishes, with Retry. **This is a required integration behaviour, not a proven UI/API guarantee.** If revocation itself fails, say “Couldn’t remove this memory. It may still be used.” Keep the exact statement and Retry; never display the exclusion promise before acknowledgement.
- Partial removal previews the entire retained wording. Native processing must preserve unrelated information. If that cannot be verified, keep the requested removal excluded, report the incomplete operation, and offer Retry; never silently discard unrelated facts or publish a fabricated retained statement.
- Empty, loading, no matches, off, updating, update failed, correction failed, removal failed and stale editing have distinct states. Loading is not an empty-memory claim. Search failure in production retains the query and offers Retry rather than claiming no matches.
- Memory off means no automatic learning from chats and no recall. Saved data remains inspectable, correctable, removable and explicitly addable. Incognito neither recalls nor learns. These gates apply outside this page too.
- Clear requires acknowledgement, shows progress, and reports success only after reset/admission acknowledgement. If cleanup remains, distinguish “memory cleared; cleanup pending” from reset failure. The mockup demonstrates the confirmation/success path; these failure semantics remain required for implementation.

## Truth, evidence and Hindsight fit

Use the tested native extraction, dated change events and verified publication described in [correction-recovery-results.md](correction-recovery-results.md). A later deliberate source edit supersedes previous corrections and conflicting older claims across chats. Replaying or making an unrelated edit does not renew old assertions.

The list must be grounded in admitted raw facts and their provenance. Native `/memories/list` valid records alone are **not** a ready-made “current truth” projection. The implementation must supply a bounded read view of the accepted revision, precedence and source attribution without adding a second extraction engine or semantic ontology. This is an integration dependency to resolve and verify before promising a production current-memory list. Do not treat generated observations or summaries as verified historical transitions. “Earlier statements” shows actual earlier wording, not “your kayak changed colour”.

Each displayed row needs stable identity, actual scope, accepted statement, assertion date, relevant sources, supersession linkage and operation state. Duplicated evidence must not create independently current copies of the same corrected claim. Ambiguous attribution must not become a user fact. Ordinary users do not get a review inbox for uncertain guesses: omit unsupported assumptions from accepted memory; request clarification in chat only when it materially helps the current task.

Remove means this selected memory and its known earlier versions/linked lineage stop being used. It is not a global topic ban or physical deletion from original chats/backups. A genuinely new explicit statement may be remembered later. The correction/removal layer owns this boundary; source excerpts and answer context must obey it rather than leaking removed text through raw chunks. Full account erasure/export remain separate account features and require their own verification.

## Copy and accessibility

English and Hungarian are included in the interactive study. Key actions: Correct / Javítás; Remove / Eltávolítás; Keep part instead / Egy részét megtartom; Manage / Kezelés. Removal says original chats remain and a later new explicit statement can be remembered. Never “Delete permanently”, “protected forever” or “100% confident”.

Mobile retains every essential action with a single column and reflowing controls. No hover-only controls. Keyboard users can open a row, edit, cancel and return; focus must return to the invoking row or a meaningful successor after removal. Native labels, visible focus, live save/error announcements and about 44px touch targets. Localized text must fit at 320px, zoom and long statements. Project/source names are untrusted plain text. Full source access must check ownership and project access; missing/deleted sources show “Source unavailable”, not a broken link or another user's content.

## Approved simplifications and retained boundaries

Retain search/browse, evidence, manual add/correct/remove, selective removal, source-edit sync, status/retry, off, incognito, reset and isolation. Drop portrait/summary editing, expiry/renewal, routine review inbox, permanent endorsement and nightly undo. These are deliberate product decisions, not temporary v1 gaps.

Documents, uploads, artifact history, task/project continuity, account export/erasure and administrator controls are not replaced by this screen. The earlier [feature matrix](replacement-readiness.md) remains the broader inventory. A product implementation must update the Feature Guide in English/Hungarian and any pictured controls in the same change.

## What remains before implementation

Owner chooses/adjusts the visual direction. Then specify the bounded current-memory read view and operation contracts using the existing tested correction boundary; explicitly cost any expansion beyond it. Real acceptance must exercise the actual UI/API with native extraction, local model, two-user isolation, partial correction/removal, stale editor races, failure/retry, source edits, replay/restart, off/incognito and reset. Mock interactions are design validation, not proof of Hindsight integration or production feature parity.

## Design verification

Standalone browser checks passed: correction save, partial removal save, stale-save blocking, reset acknowledgement and success; all 15 preview states in English and Hungarian at 320px reported no horizontal overflow or JavaScript errors. Desktop, phone detail and dark correction screens were visually inspected. A fresh builder-check review found no important unanswered product questions beyond the explicitly deferred integration work. These checks apply only to the design study, not the application.
