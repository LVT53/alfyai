# Memory product contract — proposed v1

2026-11-18. **Rejected in its current form by the owner; not implementation approval.** Based on [the agreed direction](README.md) and [native workflow tests](native-workflow-results.md). Recommendations below are ours unless identified as already agreed.

## Owner correction — supersedes the proposals below

The owner rejected the two proposed compromises: source-level removal that can discard unrelated facts, and not automatically updating curated memory when its chat source changes. This is the full replacement, not a reduced v1. A simpler adapter is desirable but does not justify weaker user outcomes.

Required outcomes for the revised contract:

- Selective memory removal preserves unrelated information, including information from the same message.
- Corrections/removals remain effective across retries and reprocessing.
- Edited chat sources remain synchronized without silently undoing manual corrections. Resolving genuine conflicts needs a demonstrated design, not a blanket freeze or blind replay.
- The earlier approved UI simplifications still stand: do not infer that rejecting these compromises restores expiry rules, a routine review inbox, nightly undo or a portrait.
- Hindsight fit is conditional. Investigate native capabilities and narrowly scoped integration options against these outcomes; disclose substantial custom machinery or an engine mismatch instead of calling reduced guarantees acceptable.

The rest of this document preserves the reviewed proposal as a record. Its source-removal and curated-source freeze recommendations are rejected, not pending approval. A revised contract and evidence are needed before UI design is finalized. No product code is authorized.

## The promise

AlfyAI remembers useful things you explicitly tell it, automatically. You can see what is remembered, inspect its evidence, correct mistakes and remove information from Memory. Asking about something does not mean you own it. Someone else's facts are not yours. Unknown does not mean “no.”

Uncertain personal assumptions must not be presented as confirmed facts. Ask for clarification only when it materially affects the current answer; do not create a routine review chore. **This is a required outcome, not a guarantee the current tested model configuration meets.**

## What the first version contains — agreed direction

A searchable view of remembered information with sources, correction/removal controls and understandable updating/error states. Keep memory on/off, incognito, isolation between users and explicit `/remember` capture. Omit the portrait and summary editor; the memory view itself must explain what is remembered. No inferred expiry/renewal, routine review inbox, permanent endorsement locks or nightly maintenance undo.

A displayed item is not automatically “current truth.” Show its scope and relevant dates; expose conflicting evidence rather than silently labeling either side confirmed. Raw facts and derived observations must not appear as duplicate independent confirmations. Exact grouping is a UI-design decision; do not add another classification/consolidation engine just to group rows.

## Controls — proposed semantics

| Control | What it means | Boundary the person must understand |
|---|---|---|
| **Correct** | Fix an incorrectly remembered statement by correcting the underlying extracted facts. Rebuild derived observations through Hindsight. | Show the affected supporting facts/sources before applying. One edited fact does not silently mean every paraphrase has been corrected. Do not offer a direct editor for a derived observation. |
| **No longer true** | Stop the selected underlying fact or reviewed set of facts from being used in normal memory recall. Keep the historical source and support native restore. | This is retirement, not deletion. It does not ban learning a new, explicit statement later. Other supporting facts must be included or shown as still remaining. |
| **Remove from Memory** | Remove selected source material from Hindsight and the memories derived from it. Prevent that same source from being automatically ingested again. | Preview all affected information, including unrelated facts in the source. Other source material may still establish the same fact. Original chats remain in chat history. |
| **Clear Memory** | Remove all of this user's profile-memory data and prevent previously processed chat material from silently rebuilding it. New eligible messages can start fresh. | Distinguish Memory from chats, library documents and account deletion. Existing combined “Clear Memory and Knowledge” must not silently change meaning during migration. |

Use one explicit confirmation for destructive source removal, showing the scope and collateral information; avoid repeated permission prompts for ordinary remembering. Evidence inspection is read-only. A source should be a small stable input unit, preferably one user message, not an entire accumulating conversation. Source granularity is an integration proposal, not yet tested with AlfyAI's real delivery path.

**Example:** one message says “My bicycle is red. I prefer decaf.” Correcting the bicycle to blue preserves decaf. Retiring the bicycle preserves decaf. Removing that source removes both. If another message also says the bicycle is red, the preview must show that remaining evidence; deleting just the first source must not claim the bicycle has been forgotten everywhere.

## Completion and failure

All four actions—Correct, No longer true, Remove from Memory and Clear Memory—must block new memory injections from the affected bank, including cached results, before mutation starts. Chat can continue without that memory. Show “Updating” or “Removing” until the action and affected derived-memory work finish. For removal/reset, completion also requires preventing the relevant old sources and queued intake from recreating the removed data. Only then show success and resume memory use. If an action partially fails, keep the affected memory unavailable until retry or an explicit recovery resolves it; show why. This temporary read gate is proposed application coordination, not a native Hindsight guarantee. Already-running replies and text already in chat history cannot be retroactively corrected.

If an action spans several facts and only some succeed, report the partial result and allow retry of the remainder. Never claim atomic success where the API performed separate mutations. A failed background operation remains visible as a failure, not an endless spinner or a false success. Restoration is explicit; general maintenance undo is not part of v1.

## Old messages, retries and edited chats

Stable source IDs, delivery acknowledgements and source-removal records belong to AlfyAI. They carry delivery/privacy state, not a second copy of personal truth. All automatic intake, retries and backfills must honor them.

Native correction and retirement survived unchanged retries and restart, but changed-source reprocessing reset them. Therefore **do not silently reprocess a source affected by manual curation**. Record that source's curation status and leave its native curated state in place. If its original chat message is edited, make that divergence visible; replacing its remembered contents requires an explicit operation that explains that native curation may be reset. Any future migration/reindex must preserve curated native state or stop for an explicit reconciliation decision. A blanket replay of chat history is not an acceptable migration strategy.

This restricted reprocessing policy is a proposal requiring owner acceptance. Automatically merging arbitrary changed source text with past corrections would require the invasive policy machinery we are trying to avoid.

## Privacy and meaning of removal

“Remove from Memory” concerns profile memory. It does not erase the original chat, make an already-exported file disappear, or remove content from backups. Deliberate chat-history search may still show the old message as historical evidence; it must not silently reinstate the removed profile memory. Chat deletion, account erasure and retention policies need their own truthful scopes.

Memory off and incognito must gate both learning and recall, including queued work. Normal answer generation must not receive old raw chunks that bypass corrections/retirement. Evidence may still be inspected deliberately. The exact answer-context representation remains unresolved: omitting chunks prevented one curation leak but the local model still misattributed a client's condition. Neither a prompt nor a reasoning switch is an accepted fix.

## What we still need to accept before implementation

- **Product choice:** source-level removal with a collateral preview, versus fine-grained semantic removal requiring substantially more integration. Recommendation: source-level removal for v1; retirement handles “stop using this one fact.”
- **Product choice:** curated sources are not automatically reprocessed after chat edits. Recommendation: preserve corrections and make any replacement explicit, rather than build automatic merging.
- **Quality gate:** a generally applicable local Flash Next answer/retrieval path must pass held-out attribution and unknown-versus-none cases together with the correction/removal cases. Current facts-only and compact variants have not passed.
- **Integration gates:** tested source mapping, cross-user access, concurrent edits and partial failures, reset/removal versus running ingestion and retries, memory-off/incognito transitions, and account erasure/export. Native API success alone does not establish these.

The next deliverable is a UI design around the accepted controls and tradeoffs. No product code, migration or deployment is authorized by this draft. Hindsight adoption remains conditional on the quality and integration gates above.

Review note: an independent contract review identified missing completion semantics for removal/reset; the completion section now covers all four actions. Other implementation details remain deliberately deferred.
