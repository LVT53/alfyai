# Independent adversarial review: Normal Chat completion and recovery

You are Claude Fable, acting as an independent adversarial reviewer. Review the implementation against its specifications and reach your own verdict. Try to falsify the claims; previous reviewers' approval and passing test counts are evidence to examine, not conclusions to inherit. Do not implement fixes in this review.

## Checkout and authority

- Repository/worktree: `/Users/lvt53/.codex/worktrees/turn-completion/alfyai`, branch `fix/turn-completion`.
- Record `git status --short --branch` and `git rev-parse HEAD` before reviewing. The feature baseline is `24823203b`.
- Validated application/staging revision: **`29e51551f96a7a94dd6b374c276a8e90c46a03db`**. Later documentation-only commits may be present. Check for application-source drift rather than assuming current HEAD and staging are identical.
- Production remains **`40f2d74fc`**. Preserve its cost-display fix. Never deploy to production or write to its database.
- Read root and relevant folder `AGENTS.md` instructions. Check current official framework/library documentation where needed, using the repository's installed versions.

## What the owner expects

A normal turn must not be marked answered merely because it emitted a preamble, reasoned privately, called a tool, or reached an execution limit. Completion/recovery must retain completed work and avoid automatically repeating tool side effects. Ordinary working prose must remain separate from the final answer through streaming, persistence, reload, Copy and export. The owner's latest display instruction preserves the existing thinking steps/status and explicit native-reasoning opt-ins; ordinary activity prose stays hidden during live turns.

Stop, ask-user pauses, failures, reconnects, legitimate partial answers and short file captions must keep their distinct semantics. Recovery must adopt authoritative saved state without stale callbacks changing a newer turn. Accounting failures must not erase readable history or invent known costs. Keep the solution in substantive existing owners, not layers of pass-through wrappers.

## Specifications to read

Under `docs/plans/turn-completion/contract/`:

- `spec.md` and `architecture-alignment.md`: overall completion contract and ownership.
- `thinking-display-amendment.md`: latest live/terminal disclosure rules; do not infer a blanket ban on deliberately expanded native reasoning.
- `stop-terminal-reconciliation.md` and `stop-action-settlement.md`: read-only Stop observation, authoritative identities, command permits and lifecycle fences.
- `canonical-message-reconciliation.md`: atomic adoption of the complete saved row through the existing finalizer; absence clears stale durable fields while render identity survives.
- `accounting-independent-message-reads.md`: core history versus optional accounting, strict privacy failures, bounded batches, ledger precedence and honest unavailability.
- `verification.md`: final evidence map and remaining limits. Read the primary artifacts below too.

Read the reconciled ADRs 0015, 0022, 0025, 0026, 0041, 0047, 0056 and 0060. Check their claims against enforcement, not just linked tests. Distinguish normative contracts from historical audit/checkpoint reports. The original diagnosis is in `docs/normal-chat-turn-completion-audit-2026-11-10.md`; its historical rates do not measure this candidate.

## Adversarial questions

1. Does Model Run own a bounded completion policy shared by plain and streaming execution, with one tools-disabled closing allowance per segment? Can any terminal/fallback path rerun the complete pipeline, replay a side effect, exceed the allowance, or close after an intentional Stop/pause?
2. Are effective-model tools, provider failover, reasoning continuation and actual-attempt accounting coherent, including DeepSeek `reasoning_content` after tools? Are nullable provider facts retained as unknown rather than inferred from the final logical outcome?
3. Do typed step/block identities and roles survive all adapters? Can provisional or ordinary activity become canonical answer text, corrupt Markdown, leak into Copy/export, or disappear from a legitimate partial answer? Avoid substring/length heuristics as proof.
4. Are native reasoning, anchored thought steps and ordinary activity distinct? Check collapsed, expanded, explicit raw opt-in, interrupted fresh disclosure, live-to-terminal transitions, repeated canonical adoption and per-segment pause/resume behavior.
5. Can reconnect, unknown/stale stream IDs, truncated replay or completed-stream reconnect start a new generation? Is replay bounded and truthful when a prefix is unavailable? Are admission and cleanup correctly owned?
6. Does durable completion include the required file/job associations before a success receipt? Do delivery/finalization failures remain failures even when the model produced an answer?
7. Does canonical recovery replace exactly the verified assistant row, clear absent stale fields and preserve its render key? Challenge stream/chat/assistant/turn/segment identity, legacy pending-to-terminal observation, Stop strictness, target replacement, route changes and delayed callbacks. Verify dependent-action permits after every await.
8. Can accounting-only failures make Prompt Context lose history or make refresh fail? Check real callers, privacy lookup failure versus absence, incognito, ready zero, pending/unknown, stale legacy values, model identity, partial batches and message-grain pagination. Strict accounting endpoints must retain their explicit failure contract.
9. Do the modules earn their interfaces? Apply the deletion test: identify caller policy actually removed, remaining ordering obligations and unnecessary indirection. Do not score architecture by file count or added lines.

## Primary evidence and limitations

- Full release gate 14: `/tmp/alfyai-completion-contract-gates-14/` and `/tmp/alfyai-completion-contract-gates-14-console.log`: **25,914 unit passed / 3 skipped; 1,590 browser passed / 75 skipped / 0 failed / 0 flaky**. Typecheck/build zero warnings; Fallow four unchanged cycles, zero new findings. Quarantined/skipped cases are not passes.
- Gate 13 remains **FAILED** on the prior query-count assertion. Its test-only correction now distinguishes a bounded core history scan from bounded optional accounting queries; examine whether that correction preserves a meaningful oracle. It was not a production-code fix.
- Local staging evidence directory: `/tmp/alfyai-completion-contract-staging-evidence/`.
- `alfyai-persisted-replies-29e51551f.json`: same 21 historical reply content/event hashes and accounting; original Kimi cost `$0.032304` checked without regeneration.
- `alfyai-completion-contract-29e51551f-full.json` and `.json.audit.json`: original suite **30/30**, exact **33 segments / 33 attempts**. Three deliberately canceled attempts retain unknown usage; total cost remains NULL, not zero.
- `alfyai-wide-29e51551f-candidate.json` and `.json.audit.json`: wider suite remains **FAILED, 20/21 strict cases**. Qwen's Hungarian case returned correct arithmetic but omitted the required `PRODUCT=391` line. Raw structural answer equals saved answer, with no marker in any ordinary text block. All 21 coverage/actual-provider/accounting audits pass. Do not reclassify this as a transport failure or silently waive the formatting failure.
- Preserve comparison history: baseline `8fed848dd` had a Kimi punctuation failure; earlier `db1ea5596` had one Kimi off-topic answer and a Qwen unrequested-tool case. Original Kimi wrong-topic attribution remains unknown. These samples do not prove model-quality improvement or guarantee instruction compliance.
- `/tmp/alfyai-thinking-stop-ui-v8-29e51551f.json` and `/tmp/alfyai-thinking-live-ui-v10-29e51551f.json` remain **FAILED watchdog reports** although their functional assertions passed. Stop's deliberate reload canceled a usage GET. Natural's sole original stream reported `ERR_ABORTED` after protocol/content completion; its precise abort cause was not established. Do not claim an explicit successful-cleanup abort without source evidence.
- `/tmp/alfyai-two-case-readonly-addendum-v3-29e51551f.json` also remains **FAILED**, not an overall pass. It made only GETs of existing staging state: zero generation, zero mutations, zero blocked/HTTP/page/console errors. Stop open/reload, canonical invariance, exact retained-prose hash, two anchors, fresh disclosure and native-default-off assertions passed. Its sole failure was an owned evidence GET starting after reload intent (sequence 142 > 140), failing before navigation commit (143 < 144). The narrow usage-only lifecycle exception correctly did not waive it. Natural was not reached in this addendum.
- The controller accepts **combined, qualified functional evidence**, following Astra's recommendation to retain scoped Stop proof and assess Natural separately: original Stop plus the addendum's completed assertions; original Natural's completed functional assertions plus its exact-attempt audit. This is the controller's release-evidence disposition, not an overall Astra watchdog PASS. This does not pass the failed watchdogs, prove either exact abort caller, certify a clean two-case addendum, or establish all-green release acceptance. No further harness relaxation or new model calls were used. Independently decide whether these limits block owner production approval.
- Exact-ID native audits: `/tmp/alfyai-completion-contract-staging-evidence/alfyai-thinking-stop-ui-v8-29e51551f.json.audit.json` and `/tmp/alfyai-completion-contract-staging-evidence/alfyai-thinking-live-ui-v10-29e51551f.json.audit.json`. Each records one real Kimi working attempt, no closing: Stop usage remains unknown; Natural is answered/ready at 52,172 micros. Inspect them rather than treating structural completion as semantic correctness.
- Local detailed review/coordination material is under ignored `.superpowers/sdd/implementation-plan/`. Use it for navigation, then inspect source and primary evidence independently.

## Validation and access

Run focused tests as useful, especially Model Run completion, prepared turns, SDK/provider integration, replay/observation, client runtime/page helpers, message-usage and the new accounting fault-injection integration tests. Read tests before trusting them: legacy tests may encode old behavior and new tests may miss valid transitions.

For a full rerun use `PATH=/opt/homebrew/opt/node@22/bin:$PATH scripts/gates.sh release /tmp/NEW-UNIQUE-DIRECTORY --port UNIQUE_PORT --workers 6`. Never run `npm run check` or `npm test` while `npm run build` runs; use the gate's ordering. Only one e2e run per worktree.

Staging is `https://ai.dev.alfydesign.com`, host `alfyroot`, app root `/home/alfydesign/apps/langflow-chat-dev`, port 3002. Existing-source and saved-evidence review is authorized. **Do not run further browser/model tests without new explicit owner authorization.** If proposing such tests, describe the missing proof and bounded isolated scenarios first; use DeepSeek **Flash**, never Pro. Do not deploy, alter shared configuration, change existing conversations, or write directly to any database. All production mutations are forbidden. Any database inspection must use `?mode=ro` and query-only; never print credentials or native reasoning. Temporary protected browser-state files have been removed locally and remotely.

## Deliverable

Return an independent verdict memo:

- Actionable findings ordered by severity, each with exact file/line, violated invariant, concrete trigger, impact and smallest reproducer.
- Separate application defects, test-oracle defects, unsupported claims and model-quality limitations.
- Explain which claims you verified independently, which rely on saved evidence and what remains uncertain.
- Evaluate the deep-module shape and whether the ADRs accurately describe enforced behavior.
- State **ready for owner production approval**, **conditionally ready**, or **not ready**, with reasons and the minimum required changes. This verdict never authorizes deployment.

Do not implement fixes or expand into unrelated architecture work. A no-findings verdict still needs evidence and explicit limits.
