# Targeted DeepSeek reasoning replay

2026-11-10. Continue fix/turn-completion at 6aac0f283. Spec: preserve provider-required reasoning_content on native DeepSeek tool continuations without changing user-visible reasoning controls or the completion/recovery architecture.

## Global constraints

- Work only /Users/lvt53/.codex/worktrees/turn-completion/alfyai. Node22 PATH. Read root/services/folder AGENTS before edits.
- Orchestrator delegates implementation; no worker subagents/push/deploy. Named-path small commits, focused tests; one full gate after review.
- Reuse provider compatibility and existing reasoning replay fetch. No node_modules patch, fake/placeholder reasoning, global cache, cross-provider or cross-attempt replay, new persistence subsystem, tool reruns, disabled thinking workaround, prompt-language changes or browser protocol changes.
- Synthetic fixtures and test-account staging data only. No credentials/reasoning text in diagnostic logs. Official DeepSeek thinking-mode docs checked: tools-bearing requests require full reasoning_content replay; no-tools requests ignore it. Installed SDK6 source is version authority.
- Stop and report if solving the issue requires broader storage/history/recovery redesign. Report remaining limits explicitly; do not silently claim persistence across sessions.

## Task 1: Diagnose, prove and fix the targeted replay

Read first: normal-chat-model/{provider-compatibility.ts,openai-compatible-provider.ts,mimo-reasoning-replay.ts} plus relevant tests. Existing adapter captures reasoning keyed to tool calls but compatibility currently enables it for MiMo only; this is a hypothesis until captured requests prove it.

1. Add a failing real model-run test with mocked HTTP/SSE: DeepSeek streams nonempty reasoning plus fetch_url call; second HTTP request must contain the EXACT captured reasoning_content for the matching assistant/tool call. Return provider-like400 when missing. Test both streaming and plain generateText tool loops, including multiple steps, fragmented chunks, parallel tool IDs and existing explicit reasoning preserved.
2. Isolate the loss boundary and reuse the existing adapter. Preserve MiMo, unrelated providers, no-tools recovery, abort/error behavior. Provider identity classification must use existing profile rules and respect strong model identity over weak names. Preserve exact captured reasoning bytes; no trim/normalization that violates DeepSeek's full-replay requirement.
3. Test isolated adapters/attempts/providers with reused tool IDs to exclude state leakage. Read existing assertions that DeepSeek doesn't replay and update them only where behavior intentionally changes; retain a genuine unrelated-provider negative control.
4. Assess prior-turn/persisted assistant messages: say whether current history is sufficient and add focused regression when a small existing seam supports it. Do not fabricate missing historic reasoning. If this requires broader changes, document and stop at targeted in-flight fix.
5. Update local technical ownership docs naming MiMo-only replay if necessary; keep changes narrowly tied. This protocol correction adds no new user-facing feature/guide control.

6. Characterization disproved the in-flight-loss hypothesis: installed SDK preserves real generated reasoning. The fresh URL failure can instead be app-generated prefetch history. Prove that boundary. A small use of the existing provider historyToolMessages flatten seam is authorized for reconstructed history/prefetch if it avoids invalid synthetic assistant messages; preserve real in-flight native reasoning, keep the stored-history limit explicit, and let staging decide live compatibility. Do not build persistence changes.

Owned scope: normal-chat-model adapter/profile/replay + their tests; normal-chat-context prefetch regression tests; directly affected fixture/docs only. Avoid renaming entire helper API unless needed, and do not duplicate it for DeepSeek.

Verification: focused model/replay/profile/provider tests, English purity/reply language if request behavior changes, Biome changed files, npm run check0errors0warnings. Controller reviews diff, runs full chat gate then serial staging tests. Full report in task-1-report.md in plan workspace: root cause, red/green request evidence, coverage, changed paths, limitations and commits; return <=12lines.

## Staging acceptance and stopping rule

Deploy side branch only after local checks. Serial batches avoid the dedicated account's concurrency limit. Re-run Kimi>=12, Qwen20, DeepSeek>=12 ordinary tool turns, including the two fetch_url prompts that failed; silence/empty probes for each. Also check a multi-turn DeepSeek conversation if feasible: a fresh-conversation-only pass cannot establish history stability. Audit exact test assistant IDs, expected providers, completion records, zero silent stubs/dropped calls, and DeepSeek provider errors. Stop if broader fixes remain necessary; preserve evidence and discuss before expanding.
